import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

export interface SudoRequest {
  id: string; method: "sudo"; title: string; message: string; command: string; cwd: string; host: string; expiresAt: number;
}
export interface SudoSpec { executable: string; args: string[]; cwd: string; reason: string }
export function validateSudoSpec(spec: SudoSpec): void {
  if (typeof spec.reason !== "string" || !spec.reason.trim() || spec.reason.length > 800) {
    throw new Error("sudo_exec requires a concise reason explaining what this command does, why it needs root, and what it affects (max 800 characters)");
  }
  if (!isAbsolute(spec.executable) || !isAbsolute(spec.cwd) || [spec.executable, spec.cwd, ...spec.args].some(s => s.includes("\0")) || JSON.stringify(spec).length > 16000) {
    throw new Error("sudo_exec requires absolute executable/cwd, bounded arguments, and no NUL characters");
  }
}

/** One-shot authorization. Passwords are never part of request payloads or tool arguments/results. */
export class SudoApprovals {
  private pending = new Map<string, { finish: (password?: string) => void; expiresAt: number }>();
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
  cancelAll(): void { for (const entry of [...this.pending.values()]) entry.finish(); }
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
