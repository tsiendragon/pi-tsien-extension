import assert from "node:assert/strict";
import test from "node:test";
import { ACTION_GUIDELINES, adjustGuidelinesSection, replaceSystemPromptIntro } from "../extensions/default-system-prompt.ts";

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

test("adjusts Guidelines: drops common-sense lines and injects action guidelines", () => {
  const original = [
    "Available tools:",
    "- read",
    "",
    "Guidelines:",
    "- Use read before editing.",
    "- Be concise in your responses",
    "- Show file paths clearly when working with files",
  ].join("\n");

  const adjusted = adjustGuidelinesSection(original);
  assert.ok(!adjusted.includes("Be concise in your responses"));
  assert.ok(!adjusted.includes("Show file paths clearly"));
  assert.ok(adjusted.includes("- Use read before editing."));
  for (const guideline of ACTION_GUIDELINES) {
    assert.ok(adjusted.includes(guideline));
  }
});

test("keeps the prompt unchanged when Guidelines is absent", () => {
  const prompt = "No guidelines section here.";
  assert.equal(adjustGuidelinesSection(prompt), prompt);
});
