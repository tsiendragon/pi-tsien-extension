# PTC runtime, model, and prompt validation

## Scope

This validation exercises five configured models through real Pi RPC sessions:

- `openai-codex/gpt-5.6-sol`
- `openai-codex/gpt-5.6-terra`
- `openai-codex/gpt-5.6-luna`
- `dashscope/deepseek-v4-flash`
- `dashscope/deepseek-v4-pro`

It separates deterministic semantic correctness, strict output formatting, clean execution, mixed-mode tool selection, and runtime/policy failures. Ordinary PTC smoke tests and scoped TypeScript checks are also run independently of model behavior.

## Final selected matrices

| Matrix | Purpose | Runs | Semantic | Clean | Notes |
|---|---|---:|---:|---:|---|
| Read-only C1 | Low-complexity aggregation | 5 | 5/5 | 5/5 | All models returned strict correct JSON |
| Read-only C4 | 28 shards, expected 31 nested calls | 5 | 5/5 | 5/5 | Flash final policy rerun included |
| Full F1 | 2 writes plus restricted Node test | 5 | 5/5 | 2/5 | Three models recovered from path/schema/tool-value mistakes |
| Full F3 | 14 writes plus restricted Node test | 5 | 5/5 | 3/5 | Sol and Flash recovered from model-generated value/code errors |
| Mixed simple | One-file lookup under `/ptc both` | 5 | 5/5 | 5/5 | All five chose ordinary `read` |
| Mixed batch | Four-file known-schema aggregation under `/ptc both` | 5 | 5/5 | 5/5 | All five chose `run_code` first |

Across these final matrices, deterministic truth passed 30/30 and clean execution passed 25/30. The ten mixed-mode selection cases were 10/10 semantically correct, strict JSON, and selection compliant.

## What the logs showed

No PTC runtime crash, extension error, workspace escape, policy bypass, or leaked runtime child was observed. Failures and recovered runs were attributable to model behavior or an initially too-tight policy:

1. **Path guessing:** Sol, Terra, and Luna sometimes guessed `stage-2.mjs`, omitted `src/`, or omitted `shards/` before using the manifest/listing correctly.
2. **JSON shape assumptions:** Several models assumed a parsed object was directly iterable when the task had not stated that records lived under `records`.
3. **Over-strict result contract:** Luna applied `exactKeys` to raw `tools.run` output but omitted its documented `signal` key. Writes and the test had succeeded before result validation rejected the outer call.
4. **Lossless JSON mistakes:** Flash emitted `undefined`; Sol returned a cyclic object. Both are intentionally rejected by the PTC protocol.
5. **Provider transport:** one Luna WebSocket failed before message streaming and Pi automatically fell back to SSE; the task completed.
6. **Flash policy headroom:** monitored C4/F3 runs exposed exact-boundary failures after successful work. The final policy separates expected and hard sub-call counts and reserves one merge/correction call without raising workload-size limits.

Full-mode clean rate is lower than semantic correctness because a recovered exploratory mistake is still counted as non-clean even when every source file and deterministic test is correct. It should not be reported as a runtime failure.

## Prompt policy added

The extension now teaches the model:

- Use ordinary tools for a one-file lookup in `/ptc both`.
- Start with `run_code` for deterministic filtering, joining, aggregation, or transformation across at least three related files/calls.
- In strict `/ptc on` and `/ptc full`, stop and explain when the task requires unsupported capabilities rather than attempting a workaround.
- Treat `read` output as text, `find`/`ls` as newline-delimited text, join search roots explicitly, use manifest paths exactly, and validate parsed JSON shape before iteration.
- Keep intermediate values inside one program, use bounded `Promise.all` only for independent calls, and preserve input/result association.
- Remember that separate `run_code` calls share no memory; return mergeable partials and reserve an outer call for a compute-only merge when needed.
- Keep budget headroom for discovery, validation, and one correction.
- Use `resultContract` only for independently known invariants. Avoid brittle exact-key contracts around side-effecting write/run workflows.
- In full mode, write a consistent batch, then run the Node test; do not test after every individual file.
- Omit `undefined`, cycles, and other non-lossless JSON values.

## When PTC is appropriate

Use PTC when several operations form one deterministic data flow and intermediate data can remain inside the program:

- multi-file reads followed by filtering, joining, aggregation, ranking, checksum, or validation;
- independent searches/reads that can run in bounded parallelism;
- manifest-driven repetitive writes;
- a controlled write → restricted Node test → focused correction loop.

Prefer ordinary tools when available for:

- one read, grep, find, or lookup;
- open-ended exploration where each result determines the next action;
- tasks requiring large raw outputs for human inspection;
- patch semantics, shell commands, non-Node executables, network access, or other capabilities outside the PTC SDK.

## Policy changes derived from monitored failures

- Read-only DeepSeek wall limit: 90s → 120s.
- Read-only Flash outer calls: 4 → 5 to permit a zero-sub-call merge.
- Read-only expected and hard sub-calls are now separate:
  - Sol/Terra/Luna: expected 83, hard 96.
  - Flash/Pro: expected 31, hard 40.
- Full Flash correction budget:
  - outer calls 6 → 8;
  - wall time 60s → 90s;
  - tokens 75k → 100k;
  - writes remain capped at 60.

## Reproduction

```bash
node scripts/ptc-runtime-smoke.mjs
node --experimental-strip-types scripts/ptc-policy-smoke.ts
node --experimental-strip-types scripts/ptc-extension-smoke.ts
node scripts/ptc-mode-selection-benchmark.mjs --trials=1
node scripts/ptc-model-complexity-benchmark.mjs --levels=C1,C4 --modes=ptc --trials=1
node scripts/ptc-full-tool-benchmark.mjs --levels=F1,F3 --modes=ptc --trials=1
```

Machine-readable aggregate evidence is in `ptc-validation-results.json`. Benchmark runs also preserve per-case Pi RPC JSONL under the temporary workspace printed by each command.
