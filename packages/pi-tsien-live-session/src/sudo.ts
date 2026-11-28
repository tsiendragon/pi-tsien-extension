import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdtemp, chmod, writeFile, rm, stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

export interface SudoRequest {
  id: string; method: "sudo"; title: string; message: string; command: string; cwd: string; host: string; expiresAt: number;
}
export interface SudoSpec { readonly executable: string; readonly args: readonly string[]; readonly cwd: string; readonly reason: string }

export class SudoParameterError extends Error {
  readonly code = "invalid_sudo_parameters";
  constructor(issues: string[]) {
    super(`invalid_sudo_parameters: ${issues.join("; ")}. Correct these fields and retry sudo_exec; no approval was requested and no command was executed.`);
    this.name = "SudoParameterError";
  }
}

/** Validate untrusted runtime input too, not just the model-facing JSON schema. Never echo values. */
export function validateSudoSpec(input: unknown): asserts input is SudoSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SudoParameterError(["parameters must be an object"]);
  const spec = input as Record<string, unknown>, issues: string[] = [];
  if (Object.keys(spec).some(key => !["executable", "args", "cwd", "reason"].includes(key))) {
    issues.push("unsupported fields; use only executable, args, cwd, reason (never supply passwords)");
  }
  if (typeof spec.reason !== "string" || !spec.reason.trim() || spec.reason.length > 800 || spec.reason.includes("\0")) {
    issues.push("reason is required: 1–800 characters explaining what this exact command does, why root is needed, and what it affects; no NUL");
  }
  for (const field of ["executable", "cwd"] as const) {
    const value = spec[field];
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) issues.push(`${field} must be an absolute path with no NUL; shell expansion is not supported`);
  }
  if (!Array.isArray(spec.args) || spec.args.length > 256 || spec.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    issues.push("args must be an array of at most 256 strings, one literal argv argument per item, with no NUL");
  }
  if (issues.length) throw new SudoParameterError(issues);
  if (Buffer.byteLength(JSON.stringify(spec), "utf8") > 16000) throw new SudoParameterError(["serialized parameters must fit within 16000 UTF-8 bytes"]);
}

export function prepareSudoSpec(input: unknown, defaultCwd: string): SudoSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) { validateSudoSpec(input); }
  const raw = input as Record<string, unknown>;
  const spec = { ...raw, cwd: raw.cwd === undefined ? defaultCwd : raw.cwd };
  validateSudoSpec(spec);
  return Object.freeze({ executable: spec.executable, args: Object.freeze([...spec.args]), cwd: spec.cwd, reason: spec.reason.trim() });
}

/** Filesystem-only preflight. Does not execute the command or validate its program-specific flags. */
export async function preflightSudoSpec(spec: SudoSpec): Promise<void> {
  validateSudoSpec(spec);
  for (const field of ["executable", "cwd"] as const) {
    let info;
    try { info = await stat(spec[field]); }
    catch { throw new SudoParameterError([`${field} does not exist or is inaccessible to the agent user`]); }
    if (field === "executable" ? !info.isFile() : !info.isDirectory()) {
      throw new SudoParameterError([`${field} must refer to ${field === "executable" ? "a regular executable file" : "a directory"}`]);
    }
    try { await access(spec[field], constants.X_OK); }
    catch { throw new SudoParameterError([`${field} requires ${field === "executable" ? "execute" : "directory traversal"} access for the agent user`]); }
  }
  try { if (!(await stat("/usr/bin/sudo")).isFile()) throw new Error(); await access("/usr/bin/sudo", constants.X_OK); }
  catch { throw new Error("sudo_unavailable: /usr/bin/sudo must be installed and executable; no approval was requested and no command was executed"); }
}

/** One-shot authorization. Passwords are never part of request payloads or tool arguments/results. */
export class SudoApprovals {
  private pending = new Map<string, { finish: (password?: string) => void; expiresAt: number }>();
  private revision = 0;
  /** Also invalidates requests still awaiting asynchronous filesystem preflight. */
  get generation(): number { return this.revision; }
  constructor(private readonly publish: (request: SudoRequest | { id: string; closed: true }) => void, private readonly timeout = 120000) {}
  request(spec: SudoSpec, signal?: AbortSignal): Promise<string | undefined> {
    validateSudoSpec(spec);
    if (signal?.aborted) return Promise.resolve(undefined);
    const id = randomUUID(), expiresAt = Date.now() + this.timeout;
    return new Promise(resolve => {
      const finish = (password?: string) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        this.publish({ id, closed: true }); resolve(password);
      };
      const abort = () => finish();
      const timer = setTimeout(abort, this.timeout);
      this.pending.set(id, { finish, expiresAt });
      signal?.addEventListener("abort", abort, { once: true });
      this.publish({ id, method: "sudo", title: "管理员授权 · 仅本次命令", message: spec.reason.trim(), command: JSON.stringify([spec.executable, ...spec.args]), cwd: spec.cwd, host: hostname(), expiresAt });
    });
  }
  answer(id: string, password?: string, cancelled = false): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) { entry.finish(); return false; }
    if (!cancelled && (typeof password !== "string" || password.length > 4096 || /[\r\n\0]/.test(password))) return false;
    entry.finish(cancelled ? undefined : password); return true;
  }
  cancelAll(): void { this.revision++; for (const entry of [...this.pending.values()]) entry.finish(); }
}

/** Password is delivered to sudo's askpass helper via a private one-shot Unix socket.
 * Target stdin is /dev/null, including under NOPASSWD, so it cannot consume the password.
 * -k together with a command neither uses nor refreshes a sudo timestamp ticket.
 */
export async function runSudo(spec: SudoSpec, password: string, signal?: AbortSignal, sudoPath = "/usr/bin/sudo"): Promise<{ code: number | null; output: string }> {
  validateSudoSpec(spec);
  if (signal?.aborted) throw new Error("sudo execution cancelled");
  const dir = await mkdtemp(join(tmpdir(), "pi-sudo-"));
  await chmod(dir, 0o700);
  const socket = join(dir, "askpass.sock"), helper = join(dir, "askpass.cjs");
  let secret: Buffer | undefined = Buffer.from(password + "\n");
  const redact = (text: string) => password ? text.split(password).join("[redacted]") : text;
  const server = createServer(connection => {
    connection.on("error", () => {});
    if (!secret) { connection.destroy(); return; }
    const bytes = secret; secret = undefined;
    connection.end(bytes, () => bytes.fill(0));
    server.close();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    // No password (or other credential) is ever written into this helper.
    await writeFile(helper, `#!${process.execPath}\nconst net=require('node:net'); const s=net.connect(${JSON.stringify(socket)}); s.on('data', d=>process.stdout.write(d)); s.on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),10000).unref();\n`, { mode: 0o700 });
    if (signal?.aborted) throw new Error("sudo execution cancelled");
    return await new Promise((resolve, reject) => {
      const child = spawn(sudoPath, ["-A", "-k", "--", spec.executable, ...spec.args], {
        cwd: spec.cwd, env: { ...process.env, SUDO_ASKPASS: helper }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "", stopped = false;
      const collect = (data: Buffer) => { output = (output + data.toString("utf8")).slice(-52096); };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      const stop = () => { stopped = true; child.kill("SIGTERM"); };
      const timer = setTimeout(stop, 120000);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
      child.once("error", () => { cleanup(); reject(new Error("Unable to start sudo")); });
      child.once("close", code => { cleanup(); stopped ? reject(new Error("sudo cancelled or timed out; check target state before retrying")) : resolve({ code, output: redact(output).slice(-48000) }); });
    });
  } finally {
    secret?.fill(0); secret = undefined; password = "";
    server.close(); await rm(dir, { recursive: true, force: true });
  }
}
