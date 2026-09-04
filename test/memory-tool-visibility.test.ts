import assert from "node:assert/strict";
import test from "node:test";

import registerMemory from "../extensions/memory/src/extension/index.ts";

const ADVANCED = [
  "memory_review",
  "memory_undo",
  "memory_verify_application",
  "memory_promote_preview",
  "memory_promote_dismiss",
  "memory_doctor",
];

function setup(initialTools: string[]) {
  let activeTools = [...initialTools];
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const notifications: string[] = [];
  registerMemory({
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(name, handler);
    },
    registerTool() {},
    registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) { commands.set(name, command); },
    appendEntry() {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getAllTools: () => [],
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
  } as any);
  // sessionManager/isProjectTrusted are intentionally absent so createRuntime
  // throws before any I/O; the session_start handler hides advanced tools
  // before that throw, which is all this test observes.
  const ctx = {
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  };
  return {
    active: () => activeTools,
    command: commands.get("memory")!,
    sessionStart: () => handlers.get("session_start")?.({}, ctx),
    ctx,
    notifications,
  };
}

test("hides advanced Memory tools on session_start, not during registration", async () => {
  const fixture = setup(["memory_search", "memory_remember", ...ADVANCED]);
  // Registration must not call setActiveTools during extension loading; the RPC
  // child would otherwise abort the whole extension load and kill the subagent.
  assert.deepEqual(fixture.active(), ["memory_search", "memory_remember", ...ADVANCED]);

  await fixture.sessionStart();
  assert.deepEqual(fixture.active(), ["memory_search", "memory_remember"]);

  await fixture.command.handler("admin on", fixture.ctx);
  assert.deepEqual(fixture.active(), ["memory_search", "memory_remember", ...ADVANCED]);

  await fixture.command.handler("admin off", fixture.ctx);
  assert.deepEqual(fixture.active(), ["memory_search", "memory_remember"]);
});

test("keeps strict PTC mode single-tool when admin tools are requested", async () => {
  const fixture = setup(["run_code", ...ADVANCED]);
  await fixture.sessionStart();
  assert.deepEqual(fixture.active(), ["run_code"]);

  await fixture.command.handler("admin on", fixture.ctx);
  assert.deepEqual(fixture.active(), ["run_code"]);
  assert.match(fixture.notifications.at(-1) ?? "", /Exit strict \/ptc mode/);
});
