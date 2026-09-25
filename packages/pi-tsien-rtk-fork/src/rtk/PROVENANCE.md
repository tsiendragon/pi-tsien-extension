# RTK merged into `tool-result-pipeline` — provenance

This code is **no longer a vendored copy that gets re-synced with upstream**. It was
merged into this repository on 2026-09-20 and is now owned here.

- Origin: `pi-rtk` 0.1.4 (MIT, Matt Cowger — https://github.com/mcowger/pi-rtk),
  based on the RTK (Rust Token Killer) specification (https://github.com/rtk-ai/rtk).
- Previous home: `vendor/pi-rtk/`, loaded as its own extension package.
- Now: `extensions/tool-result-pipeline/rtk/`, driven by
  `extensions/tool-result-pipeline.ts` as stage 1.

## What changed during the merge

1. **Import specifiers updated** to this repo's package names: `@mariozechner/pi-coding-agent`
   → `@earendil-works/pi-coding-agent`, `@mariozechner/pi-ai` → `@earendil-works/pi-ai`,
   `@sinclair/typebox` → `typebox`; relative imports got explicit `.ts` extensions
   (the repo compiles with `node16` resolution, and `vendor/` was never type-checked —
   `tsconfig.json` only includes `extensions/**` and `test/**`).
2. **Its `tool_result` handler became `applyRtkFilters(event, ctx)`.** Upstream registered
   its own hook; now `extensions/tool-result-pipeline.ts` is the single entry point and
   calls it as stage 1. The transform body is otherwise unchanged.
3. **The rest of its surface is untouched** and still registered by `registerRtkSurface(pi)`:
   config loading, the `before_agent_start` system prompt note, the eight `rtk-*` commands
   and the `rtk_configure` tool.

## The two local command-matcher patches (still required)

Upstream misclassifies ordinary shell commands and replaces their output with a synthetic
summary:

- `isTestCommand` matched a **bare `test` token**, so `ls test`, `cat test`, `rm -rf test`
  were treated as test runs and their output became `📋 Test Results: ✅ 0 passed`.
- `isBuildCommand` used substring `includes()`, so **any** command containing `tsc` / `make` /
  `mvn` / `gradle` / `pip install` (e.g. `grep -rn tsc .`) was treated as a build and its
  output became `✓ Build successful (0 units compiled)`.

Both are fixed in `techniques/test-output.ts` and `techniques/build.ts` by requiring a real
runner invocation **at the start of a shell segment**. `test/pi-rtk-vendor.test.ts` guards
both matchers.

## Upstream updates

There is no longer an automated re-sync. To take an upstream change, diff it against this
directory and port it by hand, keeping (a) the two matcher patches and (b) the
`applyRtkFilters` / `registerRtkSurface` split that `extensions/tool-result-pipeline.ts`
depends on.

## Why merge at all

Three extensions used to contend for `tool_result` (RTK, bash-digest, trajectory-recorder)
and their order lived only in `~/.pi/agent/extensions.config.json`'s `loadOrder` array;
bash-digest's comment admitted it "runs after RTK" with nothing enforcing it. The pipeline
makes the order a declared, tested array, so a new mechanism is a new stage rather than a
fourth extension.
