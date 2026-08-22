import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/integrated/goal/**/*.test.ts",
      "test/integrated/workbench/**/*.test.ts",
    ],
  },
});
