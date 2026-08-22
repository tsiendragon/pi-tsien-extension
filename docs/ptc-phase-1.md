# PTC Phase 1 — Experimental Read-only Validation

## Goal

Validate whether a model can use DeepSeek-style Programmatic Tool Calling (PTC): emit one `run_code` call, combine multiple read-only operations in a TypeScript program, and return only the program's logs/final value to the next model turn.

This phase is intentionally an emulation. It does not add a general nested-tool broker to Pi core.

## Usage

```text
/ptc on      # strict read-only PTC: only run_code is active
/ptc both    # keep current tools and add read-only run_code
/ptc full    # explicit experimental workspace write + restricted Node run
/ptc status
/ptc off
```

PTC starts disabled on every extension/session load. `/reload`, session replacement, and extension shutdown restore normal tool presentation.

## Read-only SDK

```ts
declare const tools: {
  read(args: { path: string; offset?: number; limit?: number }): Promise<string>;
  find(args: { path?: string; pattern?: string; limit?: number }): Promise<string>;
  grep(args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string>;
  ls(args: { path?: string; limit?: number }): Promise<string>;
};
```

The bindings call Pi's built-in `read`, `find`, `grep`, and `ls` implementations directly. They are a fixed allowlist, validate their accepted arguments, resolve real paths, and reject paths outside the current workspace. They do not expose arbitrary extension tools. Because they do not re-enter the Agent loop, nested calls do not trigger the normal `tool_call` / `tool_result` extension hooks. That limitation is the reason Phase 2 needs a small core Tool Broker.

`/ptc full` additionally exposes workspace-confined `write` and a structured `run` binding. `run` only executes workspace `.js/.mjs` files in a separate permission-constrained Node process; it is not a shell. See [PTC full tool benchmark](./ptc-full-tool-benchmark.md) for its security boundary and model limits.

## Model policy and result contracts

The extension resolves the active model from `ctx.model` and loads the matching limits from the two benchmark config files. `/ptc status` shows the selected policy and current usage. The following are enforced across all `run_code` calls in one user task:

- outer `run_code` calls;
- read-only total nested calls;
- full-mode nested writes and runs;
- accumulated assistant tokens before later `run_code` or nested calls.

Each `run_code` execution independently receives a 15-second compute-time limit and a model-specific 90–130 second wall-time ceiling. Waiting for nested tools consumes wall time but not compute time. Model thinking, assistant text generation, ordinary tools, and failed earlier programs do not consume the next execution's time allowance. A timeout fails only the current `run_code`; it does not abort the Agent or poison a later correction. The per-program 32-call limit remains independent. Workload descriptors such as shard, record, or module count remain advisory because arbitrary PTC code does not expose those counts reliably. Token enforcement is boundary-based: an already streaming provider response cannot be stopped at an exact token.

For structured tasks, `run_code` accepts an optional result contract:

```ts
resultContract: {
  kind: "object",
  requiredKeys: ["count", "checksum", "ids"],
  exactKeys: true,
  expectedIntegers: [
    { key: "count", value: 42 },
    { key: "checksum", value: 123456 },
  ],
  expectedArrayLengths: [{ key: "ids", length: 7 }],
}
```

A mismatch fails the tool with `PTC_RESULT_VALIDATION_FAILED`. A budget excess fails with `PTC_BUDGET_EXCEEDED`; both errors are JSON-encoded and include a suggested action. Models configured with `normalizeJsonFence: true` also have parseable Markdown JSON fences normalized in `run_code` results and final assistant messages.

## Runtime containment

Each `run_code` starts a fresh Node child process with:

- Node permission mode enabled;
- no filesystem, network, child-process, Worker, inspector, FFI, or WASI permission;
- empty environment;
- a 128 MiB old-generation heap cap;
- 15 second event-loop compute-time limit;
- model-specific 90–130 second per-run wall-time ceiling;
- parent heartbeat watchdog for busy loops that continue after an `await`;
- 32 sub-call limit;
- 256 KiB total protocol/output cap;
- no `process`, `require`, or module loader in the program VM context;
- string/wasm code generation disabled inside the VM context.

This reduces accidental access but is **not a production security boundary**. Node's permission model and `node:vm` must not be treated as a replacement for a container or micro-VM. Do not enable this mode for untrusted unattended workloads.

In full mode, the PTC program itself remains isolated as above. Its `write` requests are checked and performed by the parent, while `run` starts another Node permission process with read-only workspace access, an empty environment, and no network or child-process permission.

## Verification

```bash
node scripts/ptc-runtime-smoke.mjs
node --experimental-strip-types scripts/ptc-policy-smoke.ts
node --experimental-strip-types scripts/ptc-extension-smoke.ts
node scripts/ptc-mode-selection-benchmark.mjs --trials=1
npm run typecheck
```

The smoke test verifies TypeScript stripping, parallel read-only binding calls, final JSON return, hidden `process`, permission-mode startup, and normal runtime shutdown.

## Phase 1 acceptance checks

- One `run_code` program can perform at least two data-independent read-only calls.
- Program logs and final JSON are returned; intermediate results are not appended as separate model tool results.
- Unknown tools, excessive calls, invalid JSON, timeout, cancellation, memory pressure, and oversized output fail closed.
- PTC mode is opt-in and can restore the previous Pi tool selection.
- In `/ptc on` and `/ptc both`, no write, shell, ambient credential, outside-workspace filesystem, or network capability is exposed. Files already inside the selected workspace remain readable by design.
- In explicit `/ptc full`, workspace write and restricted Node execution are exposed; shell, arbitrary executables, ambient credentials, network, child processes, and outside-workspace filesystem remain unavailable.

## Model complexity benchmark

The five-model C1–C6 benchmark, raw merged metrics, and partially enforced per-model limits are available in:

- [PTC model complexity benchmark](./ptc-model-complexity-benchmark.md)
- [Merged benchmark results](./ptc-model-complexity-results.json)
- [Model complexity policy config](./ptc-model-complexity-config.json)
- [Unified PTC benchmark: read-only and read/write/run](./ptc-full-tool-benchmark.md)
- [PTC full merged results](./ptc-full-tool-results.json)
- [PTC full policy config](./ptc-full-tool-config.json)
- [PTC runtime, model, and prompt validation](./ptc-validation-report.md)
- [PTC validation aggregate results](./ptc-validation-results.json)

## Known gap before production

A full PTC implementation needs a Pi core API that executes nested calls through the same parameter validation, extension gates, cancellation, event, and result-finalization path as normal model tool calls.
