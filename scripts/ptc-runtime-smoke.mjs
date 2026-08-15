import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../extensions/ptc/runtime-child.mjs", import.meta.url));
const child = spawn(process.execPath, [
  "--permission",
  "--no-warnings",
  "--disable-sigusr1",
  "--max-old-space-size=128",
  runner,
], {
  env: {},
  stdio: ["pipe", "pipe", "pipe"],
});

const timeout = setTimeout(() => {
  child.kill("SIGKILL");
  console.error("PTC smoke test timed out");
  process.exitCode = 1;
}, 5_000);

const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const calls = [];
let completed = false;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "call") {
    calls.push(message.name);
    const value = message.name === "read" ? "alpha\nbeta" : "src/a.ts\nsrc/b.ts";
    child.stdin.write(`${JSON.stringify({ type: "result", id: message.id, ok: true, value })}\n`);
    return;
  }
  if (message.type === "done") {
    completed = true;
    const expected = JSON.stringify({ first: "alpha", files: 2, processType: "undefined" });
    if (JSON.stringify(message.result) !== expected) {
      throw new Error(`Unexpected PTC result: ${JSON.stringify(message.result)}`);
    }
    if (calls.join(",") !== "read,find") {
      throw new Error(`Unexpected PTC calls: ${calls.join(",")}`);
    }
  }
  if (message.type === "error") throw new Error(message.message);
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  if (!completed || code !== 0 || signal) {
    console.error(`PTC smoke test failed: code=${code} signal=${signal}`);
    process.exitCode = 1;
    return;
  }
  console.log("PTC runtime smoke test passed");
});

child.stdin.write(`${JSON.stringify({
  type: "run",
  maxCalls: 4,
  code: `
    const [text, files] = await Promise.all([
      tools.read({ path: "README.md" }),
      tools.find({ path: ".", pattern: "*.ts" }),
    ]);
    return {
      first: text.split("\\n")[0],
      files: files.split("\\n").length,
      processType: typeof process,
    };
  `,
})}\n`);
