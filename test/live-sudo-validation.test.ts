import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SudoApprovals, SudoParameterError, prepareSudoSpec, preflightSudoSpec, validateSudoSpec } from "../packages/pi-tsien-live-session/src/sudo.ts";

const spec = { executable: "/usr/bin/id", args: ["-u"], cwd: "/tmp", reason: "打印执行身份的 UID，不修改文件。" };

test("invalid runtime fields reject with repairable errors and never publish an approval", () => {
  const cases: [unknown, string][] = [
    [null, "parameters"], [[], "parameters"], [{ ...spec, reason: undefined }, "reason"],
    [{ ...spec, reason: " " }, "reason"], [{ ...spec, reason: "x".repeat(801) }, "reason"],
    [{ ...spec, executable: undefined }, "executable"], [{ ...spec, executable: "sudo id" }, "executable"],
    [{ ...spec, cwd: null }, "cwd"], [{ ...spec, cwd: "~/apps" }, "cwd"],
    [{ ...spec, args: "-u" }, "args"], [{ ...spec, args: null }, "args"],
    [{ ...spec, args: [1] }, "args"], [{ ...spec, args: [null] }, "args"],
    [{ ...spec, args: ["a\0b"] }, "args"], [{ ...spec, args: Array(257).fill("a") }, "args"],
    [{ ...spec, password: "NEVER-ECHO-THIS" }, "unsupported fields"],
  ];
  const events: unknown[] = [];
  const gate = new SudoApprovals(e => events.push(e));
  for (const [input, field] of cases) {
    assert.throws(() => gate.request(input as any), (e: unknown) => {
      assert.ok(e instanceof SudoParameterError);
      assert.equal(e.code, "invalid_sudo_parameters");
      assert.ok(e.message.includes(field));
      assert.ok(!e.message.includes("NEVER-ECHO-THIS"));
      assert.match(e.message, /no approval was requested/);
      return true;
    });
  }
  assert.deepEqual(events, []);
});

test("prepared arguments are immutable, default cwd is validated, and reasons are not inferred", () => {
  const args = ["literal $(not-a-shell)", "", "it's"];
  const prepared = prepareSudoSpec({ executable: spec.executable, args, reason: "  检查身份  " }, "/tmp");
  args.push("must-not-change-request");
  assert.deepEqual(prepared.args, args.slice(0, -1));
  assert.equal(prepared.cwd, "/tmp");
  assert.equal(prepared.reason, "检查身份");
  assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.args));
  assert.throws(() => prepareSudoSpec({ executable: spec.executable, args: [] }, "/tmp"), /reason/);
  assert.throws(() => prepareSudoSpec({ ...spec, cwd: undefined }, "relative"), /cwd/);
});

test("parameter budget counts UTF-8 bytes rather than hiding oversized Unicode payloads", () => {
  assert.throws(() => validateSudoSpec({ ...spec, args: ["字".repeat(6000)] }), /16000 UTF-8 bytes/);
});

test("filesystem preflight does not run executables and rejects known bad targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sudo-preflight-"));
  try {
    const executable = join(dir, "tool");
    // If executed this would fail; preflight only checks filesystem metadata and access.
    await writeFile(executable, "#!/not/a/real/interpreter\nDO NOT EXECUTE", { mode: 0o700 });
    await preflightSudoSpec({ ...spec, executable, cwd: dir });
    await assert.rejects(preflightSudoSpec({ ...spec, executable: join(dir, "missing") }), /executable.*does not exist/);
    await assert.rejects(preflightSudoSpec({ ...spec, executable: dir }), /executable.*regular/);
    await assert.rejects(preflightSudoSpec({ ...spec, executable, cwd: executable }), /cwd.*directory/);
    await assert.rejects(preflightSudoSpec({ ...spec, executable, cwd: join(dir, "missing") }), /cwd.*does not exist/);
    await chmod(executable, 0o600);
    await assert.rejects(preflightSudoSpec({ ...spec, executable }), /executable.*execute access/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
