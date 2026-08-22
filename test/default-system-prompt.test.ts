import assert from "node:assert/strict";
import test from "node:test";
import { replaceSystemPromptIntro } from "../extensions/default-system-prompt.ts";

test("replaces only the built-in introduction and retains tool guidance", () => {
  const original = [
    "You are an expert coding assistant.",
    "",
    "Available tools:",
    "- read",
    "",
    "Guidelines:",
    "- Use read before editing.",
  ].join("\n");

  assert.equal(
    replaceSystemPromptIntro(original, "# Custom agent\n\nFollow the business objective."),
    [
      "# Custom agent",
      "",
      "Follow the business objective.",
      "",
      "Available tools:",
      "- read",
      "",
      "Guidelines:",
      "- Use read before editing.",
    ].join("\n"),
  );
});

test("leaves the prompt unchanged when the tools section is unavailable", () => {
  assert.equal(replaceSystemPromptIntro("A custom prompt", "# Custom agent"), undefined);
});
