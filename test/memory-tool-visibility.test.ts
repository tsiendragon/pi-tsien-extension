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
  const notifications: string[] = [];
  registerMemory({
    on() {},
    registerTool() {},
    registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) { commands.set(name, command); },
    appendEntry() {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getAllTools: () => [],
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
  } as any);
  return {
    active: () => activeTools,
    command: commands.get("memory")!,
    ctx: { ui: { notify: (message: string) => notifications.push(message) } },
    notifications,
  };
}

test("hides advanced Memory tools until /memory admin on", async () => {
  const fixture = setup(["memory_search", "memory_remember", ...ADVANCED]);
  assert.deepEqual(fixture.active(), ["memory_search", "memory_remember"]);

  await fixture.command.handler("admin on", fixture.ctx);
  assert.deepEqual(fixture.active(), ["memory_search", "memory_remember", ...ADVANCED]);

  await fixture.command.handler("admin off", fixture.ctx);
  assert.deepEqual(fixture.active(), ["memory_search", "memory_remember"]);
});

test("keeps strict PTC mode single-tool when admin tools are requested", async () => {
  const fixture = setup(["run_code", ...ADVANCED]);
  assert.deepEqual(fixture.active(), ["run_code"]);

  await fixture.command.handler("admin on", fixture.ctx);
  assert.deepEqual(fixture.active(), ["run_code"]);
  assert.match(fixture.notifications.at(-1) ?? "", /Exit strict \/ptc mode/);
});
