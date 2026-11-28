import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/integrated/goal/**/*.test.ts",
      "test/integrated/workbench/**/*.test.ts",
    ],
    // The goal ledger defaults to ~/.pi/agent/pi-goal.sqlite; keep test runs out of it.
    env: {
      PI_GOAL_LEDGER_PATH: path.join(tmpdir(), "pi-goal-test-ledger", "ledger.sqlite"),
    },
  },
});