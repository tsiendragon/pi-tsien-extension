# Code Mode (`run_code`)

Code Mode exposes one always-available `run_code` tool. There is no `/ptc` mode switch and no separate read-only/full permission model.

## Purpose

Use one model-generated TypeScript program to compose several existing Pi tools, keeping intermediate values out of the model context:

```text
model -> run_code(read -> grep -> bash -> aggregate) -> model
```

This reduces model round trips for deterministic loops, branching, filtering, aggregation, and independent parallel calls.

## Tool access

The `run_code` capability hint is placed immediately after Pi's four core tool descriptions (`read`, `bash`, `edit`, `write`). Its 50-character Chinese summary tells the agent when Code Mode is preferable without adding a second large SDK block. Inside `run_code`, call active tools as:

```ts
const [source, tests] = await Promise.all([
  tools.read({ path: "src/index.ts" }),
  tools.bash({ command: "npm test" }),
]);
return { source, tests };
```

- Every active tool except `run_code` is available dynamically; the model reuses each tool's normal schema.
- Nested calls use `pi.executeTool()`, so normal argument validation, `tool_call` / `tool_result` hooks, cancellation, security extensions, and sequential execution gates still apply.
- `tools.bash` has the same effective trust and policy as calling Pi's ordinary `bash` tool. Code Mode adds no independent permission layer.
- Failed nested calls reject and may be handled with `try/catch`.
- Only `console.log/info/warn/error/debug` and the final lossless-JSON return value enter model context.

Ordinary Pi tools remain available for simple one-step work; `run_code` is one additional higher-order tool rather than a session mode.

## Runtime boundaries

Each program runs in a fresh Node child process with a compute watchdog, wall-clock timeout, output limit, and a hard limit of 256 nested calls. These are resource bounds rather than permission modes. Calls can overlap through `Promise.all`; Pi serializes tools whose definitions require sequential execution.

## Validation

```bash
npm run typecheck
node --import tsx --test test/ptc-code-mode.test.ts
```

Historical benchmark documents under `docs/ptc-*-benchmark.md` describe the previous opt-in read-only/full prototype and are not current usage instructions.
