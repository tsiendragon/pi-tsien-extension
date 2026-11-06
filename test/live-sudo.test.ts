import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SudoApprovals, runSudo, validateSudoSpec } from "../packages/pi-tsien-live-session/src/sudo.ts";
import { parseBrokerMessage } from "../packages/pi-tsien-live-session/src/protocol.ts";

const spec = { executable: "/usr/bin/id", args: ["-u"], cwd: "/tmp" };
test("sudo authorization is bound to a random request, one-shot and secret-free", async () => {
  const events: any[] = [];
  const gate = new SudoApprovals(event => events.push(event));
  const wait = gate.request(spec);
  assert.equal(events[0].method, "sudo");
  assert.deepEqual(JSON.parse(events[0].command), [spec.executable, ...spec.args]);
  assert.equal(gate.answer("wrong-id", "test-secret"), false);
  assert.equal(gate.answer(events[0].id, "test-secret"), true);
  assert.equal(gate.answer(events[0].id, "test-secret"), false);
  assert.equal(await wait, "test-secret");
  assert.equal(JSON.stringify(events).includes("test-secret"), false);
});
test("cancel, abort, timeout and disconnect never authorize", async () => {
  const events: any[] = [];
  const gate = new SudoApprovals(e => events.push(e), 10);
  const first = gate.request(spec); gate.answer(events.at(-1).id, undefined, true);
  assert.equal(await first, undefined);
  const controller = new AbortController();
  const second = gate.request(spec, controller.signal); controller.abort();
  assert.equal(await second, undefined);
  assert.equal(await gate.request(spec), undefined);
  const fourth = gate.request(spec); gate.cancelAll();
  assert.equal(await fourth, undefined);
});
test("rejects multiline password and ambiguous paths", async () => {
  const events: any[] = [], gate = new SudoApprovals(e => events.push(e));
  const wait = gate.request(spec);
  assert.equal(gate.answer(events[0].id, "a\nb"), false);
  gate.cancelAll(); await wait;
  assert.throws(() => validateSudoSpec({ ...spec, executable: "id" }));
  assert.throws(() => validateSudoSpec({ ...spec, args: ["a\0b"] }));
});
test("aborted execution never starts sudo", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runSudo(spec, "test-secret", controller.signal, "/does-not-exist"), /cancelled/);
});
test("dedicated transport rejects extra arguments and passwords on cancellation", () => {
  const envelope = { type: "command", processInstanceId: "p", requestId: "r", command: { type: "answer_sudo", id: "i", password: "test-only" } };
  assert.ok(parseBrokerMessage(envelope));
  assert.equal(parseBrokerMessage({ ...envelope, command: { ...envelope.command, executable: "/bad" } }), undefined);
  assert.equal(parseBrokerMessage({ ...envelope, command: { ...envelope.command, cancelled: true } }), undefined);
});

test("askpass receives a secret once; target stdin is empty, arguments and helper contain no secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sudo-test-"));
  try {
    const fake = join(dir, "sudo");
    await writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs'), cp=require('node:child_process');
const helper=fs.readFileSync(process.env.SUDO_ASKPASS,'utf8');
if(helper.includes('test-secret') || JSON.stringify(process.argv).includes('test-secret')) process.exit(9);
if(fs.readFileSync(0).length!==0) process.exit(8);
if(JSON.stringify(process.argv.slice(2,5))!==JSON.stringify(['-A','-k','--'])) process.exit(7);
cp.execFile(process.env.SUDO_ASKPASS, [], (error, stdout)=>{if(error || stdout!=='test-secret\\n') process.exit(6); else console.log('verified');});\n`, { mode: 0o700 });
    const before = (await readdir(tmpdir())).filter(x => x.startsWith("pi-sudo-")).sort();
    const result = await runSudo(spec, "test-secret", undefined, fake);
    assert.equal(result.code, 0); assert.equal(result.output.trim(), "verified");
    assert.deepEqual((await readdir(tmpdir())).filter(x => x.startsWith("pi-sudo-")).sort(), before);
    // NOPASSWD never runs askpass, and command input must still be empty.
    await writeFile(fake, `#!${process.execPath}\nif(require('node:fs').readFileSync(0).length) process.exit(1); console.log('no-password-rule');\n`, { mode: 0o700 });
    assert.equal((await runSudo(spec, "test-secret", undefined, fake)).output.trim(), "no-password-rule");
    await writeFile(fake, `#!${process.execPath}\nconsole.log('test-secret');\n`, { mode: 0o700 });
    assert.equal((await runSudo(spec, "test-secret", undefined, fake)).output.trim(), "[redacted]");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
