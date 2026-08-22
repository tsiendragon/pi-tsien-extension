# pi-subagent-workbench

Standalone Subagent / Workflow runtime and keyboard-first Workbench for Pi.

This repository owns its runtime, resource admission, public snapshot contract, and TUI. It does **not** import, patch, or depend on `pi-subagentura`.

## Current milestone

M0 foundation plus the first usable M1 Conversation Workbench:

- process-level `ResourceGovernor` with default active limit 4 and queue limit 32;
- P0/P1/P2 priority scheduling;
- FIFO within a subject and round-robin across same-priority subjects;
- cancellable and timeout-bounded admission;
- immediate structured rejection for unsafe synchronous nested admission;
- immutable runtime snapshots and API v1;
- provider-neutral `SubagentService` with stable ChildSession and multiple Runs;
- orthogonal `contextMode` (`fresh/fork/summary/explicit`) and `isolation` (`native/process/mux`);
- fail-loud provider capability checks and active Run interruption;
- `PiRpcProcessProvider`: one persistent `pi --mode rpc` process per ChildSession;
- RPC continuation across Runs, explicit-context envelope, abort, crash tombstones, and idempotent process cleanup;
- bounded retained RPC processes (`maxSessions=8` by default) with fail-loud `provider_capacity` rejection;
- separate cold-start (`startupTimeoutMs=180000`) and normal RPC command (`commandTimeoutMs=30000`) deadlines;
- full-capability process defaults: child Agents load Pi tools, extensions, skills, prompt templates, and project context files while keeping durable Pi sessions disabled;
- child-only `multi_tool_use_parallel` (`multi_tool_use.parallel` label) for up to eight independent active Pi tool calls, with ordered results, Abort propagation, policy hooks, and sequential-tool fallback;
- explicit provider switches to disable any child resource class for restricted deployments;
- main-Agent-callable `subagent_start` and `subagent_workflow` tools;
- staged Workflow execution: stages run sequentially and tasks inside each stage run in parallel;
- explicit Workflow dataflow: tasks expose stable `key` values and later stages list `inputs` whose completed outputs are appended to context;
- reusable project Workflow definitions in `.pi/workflows/<name>.json`, written only when `saveAs` is explicitly supplied and runnable later with `name`;
- cooperative Workflow pause/resume at Stage boundaries plus in-session whole-Workflow retry under a new `workId`;
- synchronous capacity and dependency validation before a background job is accepted;
- focusable one-line Agent/Workflow navigator above the existing Powerline/status row, leaving that row directly adjacent to the main editor border;
- extension-owned `WorkbenchController` wiring the Runtime, Service, provider, and Workflow execution without exposing mutable provider handles to the UI;
- host-owned fullscreen routes with an independent alternate-screen layout root and primary ScrollView, so child scrolling cannot expose Main content;
- Direct Subagent view reusing Pi's native user/assistant/thinking/tool renderers, `CustomEditor`, and Footer view-model renderer;
- same-ChildSession Follow-up continuation, active-Run queueing, interruption, native mouse/page scrolling, and contextual Help;
- independent Workflow stage/task page with live native Agent output plus read-only Workflow Agent detail; Workflow views never expose a Follow-up input box;
- structured RPC state/timeline projection for provider, model, exact thinking effort, assistant blocks, tool start/progress/result, and usage;
- streaming projection throttled to 20 updates/second and bounded to 1 MiB per ChildSession;
- explicit availability state for lost persistent Sessions and fail-loud continuation;
- leaving the Workbench returns to Main without cancelling background Runs;
- volatile acknowledgment warnings until durable inbox/outbox delivery exists;
- read-only `/subagent-workbench status` diagnostics view;
- Workflow entries and interruption controls in the full-screen Workbench;
- width-safe rendering, render error boundaries, and idempotent cleanup.

The runtime now includes a concrete Pi RPC process provider, automatic main-Agent delegation tools, staged Workflow orchestration, a Powerline-adjacent task navigator, and isolated native-style Direct Subagent/Workflow routes. Durable transcript recovery, native/mux providers, richer Workflow dependency graphs, cross-restart delivery, and RPC extension-dialog projection remain subsequent milestones from the PRD.

## Commands

```text
/subagent-workbench open
/subagent-workbench start <task>
/subagent-workbench status
/subagent-workbench close
```

From the unchanged main editor and Powerline:

```text
←/→         when the main editor is empty, focus the navigator and select a target
↑/↓         keep the main editor's history/cursor behavior
Enter       open the selected target as a full-screen route
Esc         return focus to the main editor
F6          optional: focus or blur the one-line task navigator
```

Inside a Direct Subagent, type in the inline Follow-up input and press `Enter`. If a Run is active, the message is queued for the same ChildSession. `Ctrl+C` interrupts the active Run; `Esc` returns to Main without cancelling it.

Inside a Workflow, use `↑/↓` to select a Stage or task, `←/→` to fold/unfold, and `Enter` to open a read-only Workflow Agent. Press `p` to pause/resume the Workflow, `i` to interrupt the selected Agent, `I` to interrupt the Workflow, and `Esc` to return one level. Pause is cooperative: already-running tasks finish, then the next Stage waits. Workflow pages have no input box and dynamically use the full terminal height for the Stage tree and live output.

`/subagent-workbench status` keeps the diagnostic `r` refresh shortcut.

## Automatic main-Agent delegation

When the extension is loaded, the main Agent can call these tools without a manual slash command:

```text
subagent_start     one bounded child task
subagent_workflow          staged tasks, prior-output inputs, and saved definitions
subagent_workflow_control  pause, resume, or retry a Workflow by workId
subagent_results           query, collect, or briefly wait for workIds
subagent_cancel            cancel queued or running workIds
```

`subagent_start` and `subagent_workflow` run in the background by default and immediately return a stable `workId`. Continue independent work, then use `subagent_results` with `mode: "status"` or `"collect"` when a result is useful. Collected Workflow results include the aggregate Stage/task outputs, not just terminal status. `mode: "wait"` is deliberately bounded to 30 seconds and leaves unfinished jobs running; use it only at a real correctness or delivery dependency point. Set `background: false` only when the current turn must wait for the complete result. Background work is not tied to the completed Tool call's abort signal. A direct task and each workflow task can set `thinking` to `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; an agent follow-up always reuses its initial `cwd`, `model`, and `thinking` configuration.

Terminal jobs retain their result in the controller for collection. Completion is delivered as a non-triggering `nextTurn` custom message, so it appears naturally in the next Agent turn without interrupting an active response or user input. `subagent_workflow_control` pauses at the next Stage boundary, resumes a paused run, or explicitly retries an entire terminal Workflow from its in-memory definition under a new `workId`. Retry can repeat external side effects and is never automatic. In-memory retry definitions do not survive Session shutdown; use `saveAs` and later `name` for cross-Session reuse. Workflow child processes are closed at terminal state to release provider slots while their projected transcript remains inspectable. `subagent_cancel` aborts a queued, running, or paused workId on a best-effort basis; collect status afterward if the terminal state matters.

Active work automatically appears as one unframed line above the existing Powerline/status row, rather than between that row and the main editor border. The extension does not replace the main editor or Powerline while Main is active. When the main editor is empty, use `←/→` to focus and switch tasks directly, then press `Enter` to open an isolated fullscreen route. `↑/↓` remain available for the main editor's history and cursor movement. `F6` remains available as an optional focus shortcut. The route has its own layout root and primary ScrollView; mouse/page scrolling never includes Main content. `Esc` restores the original Main layout, focus, draft, and viewport.

A child process receives `PI_SUBAGENT_WORKBENCH_CHILD=1`, so it still loads normal Pi extensions but does not register another Workbench delegation tool recursively. Direct and Workflow child Agents instead receive `multi_tool_use_parallel`, displayed as `multi_tool_use.parallel`. It accepts one to eight independent calls, preserves input order, accepts `functions.read` compatibility names, rejects recursion/inactive tools, and routes every nested call through Pi validation and security hooks. Outer aggregator calls are serialized so sequential targets cannot overlap across batches; independent calls inside one batch still run concurrently. If any target requires sequential execution, the whole batch runs sequentially. Nested `terminate` is propagated using Pi's all-results batch rule.

Direct and Workflow Agent pages read the child RPC session state and display the actual model plus thinking effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). Workflow overview displays the selected Agent's configuration above its live output.

A Workflow can contain at most eight Stages and eight tasks per Stage, but its total task count must also fit the provider Session limit (eight by default). Accepted background Workflows reserve their required Session slots so concurrent submissions cannot silently overbook that limit. `inputs` may reference only unique task keys from earlier Stages; same-Stage references are rejected because those tasks run concurrently. This is intentionally a deterministic staged runner, not a JavaScript runtime: loops, conditions, and dynamic fan-out remain out of scope until a concrete large-Workflow requirement justifies them.

The native UI requires a Pi host that supports both `ctx.ui.custom(..., { fullscreen: true })` and `ctx.ui.setWidget(..., { placement: "aboveStatus" })`. Older hosts are not supported because falling back to a 100% Overlay would reintroduce Main transcript leakage or place navigation inside the editor/status boundary.

## Runtime contract

The extension publishes API v1 on:

```ts
Symbol.for("pi-subagent-workbench.runtime.v1");
```

Supported package exports:

```ts
import {
  getWorkbenchRuntimeHost,
  installWorkbenchRuntime,
  type SubagentWorkbenchRuntime,
} from "pi-subagent-workbench/runtime";

import {
  ResourceGovernor,
  ResourcePriority,
} from "pi-subagent-workbench/resource-governor";

import {
  SubagentService,
  type SubagentProvider,
} from "pi-subagent-workbench/service";

import { WorkbenchController } from "pi-subagent-workbench/controller";
import { PiRpcProcessProvider } from "pi-subagent-workbench/providers/pi-rpc-process";

const service = new SubagentService();
const provider = new PiRpcProcessProvider({
  defaultModel: "openai-codex/gpt-5.6-luna",
  thinking: "minimal",
  runIdleTimeoutMs: 10 * 60_000,
  maxRunWallTimeMs: 60 * 60_000,
  timeoutAbortGraceMs: 5_000,
});
service.providers.register(provider);

// Reuse result.sessionId in the next start() call to continue the same RPC conversation.
// Call provider.dispose() during shutdown to stop every persistent child process.
```

`runIdleTimeoutMs` is reset by real RPC progress such as assistant or tool events. Polling heartbeats do not reset it. `maxRunWallTimeMs` remains an absolute safety ceiling even while progress continues. On either timeout, the provider first requests an abort, waits up to `timeoutAbortGraceMs`, and then stops and tombstones the Session. The deprecated `runTimeoutMs` option remains an alias for `runIdleTimeoutMs`.

A `background_command_start` tool call normally returns immediately, so the Agent Run should settle instead of waiting for the command. Merely owning a live background process does not reset the idle timer; later status/output tool calls do count as real progress. Background commands that must outlive or be managed outside the ChildSession should be started by the owning parent Session.

The UI receives copied immutable snapshots. Provider handles, `AbortController`, mutable registries, and process objects are not exposed.

### Child capability defaults

Child Agents load tools, extensions, skills, prompt templates, and project context files by default. Restrict individual resource classes when needed:

```ts
new PiRpcProcessProvider({
  allowTools: false,
  loadExtensions: false,
  loadSkills: false,
  loadPromptTemplates: false,
  loadContextFiles: false,
});
```

The provider still uses `--no-session` and `--no-approve`: child context is held by the Workbench-owned RPC process and does not create a durable Pi session.

### Payload safety defaults

Input validation runs before Session creation and provider admission. Limits use UTF-8 bytes and can be lowered or explicitly raised through `SubagentServiceOptions`:

| Payload            | Default limit | Structured failure                      |
| ------------------ | ------------: | --------------------------------------- |
| `task` / prompt    |         1 MiB | `SubagentInputError: task_too_large`    |
| explicit `context` |         8 MiB | `SubagentInputError: context_too_large` |
| provider `output`  |         8 MiB | `ProviderOutputError: output_too_large` |

Invalid runtime parameter types, blank tasks, non-positive timeouts, and already-aborted submissions do not reach a provider. Rejected admission does not create a ChildSession.

## Local development

```bash
npm install
npm run check
```

Load in Pi:

```bash
pi -e /mnt/workspace/lilong/repos/pi-subagent-workbench
```

Or install locally:

```bash
pi install /mnt/workspace/lilong/repos/pi-subagent-workbench
```

## Experiments

Run the repeatable simple and complex runtime experiment matrix:

```bash
npm run check
npm run experiment
```

Run authenticated Luna matrices separately (use model quota and may incur cost):

```bash
npm run experiment:luna      # one-shot JSON provider baseline
npm run experiment:luna-rpc  # persistent Pi RPC provider acceptance
```

Latest checked-in results:

- [Runtime experiment report](docs/reports/runtime-experiment-report.md)
- [Runtime raw JSON metrics](docs/reports/runtime-experiment-report.json)
- [Luna one-shot real-model experiment report](docs/reports/luna-model-experiment-report.md)
- [Luna one-shot raw JSON metrics](docs/reports/luna-model-experiment-report.json)
- [Luna persistent RPC experiment report](docs/reports/luna-rpc-experiment-report.md)
- [Luna persistent RPC raw JSON metrics](docs/reports/luna-rpc-experiment-report.json)

## Product specification

See [`docs/subagent-workflow-tui-prd.md`](docs/subagent-workflow-tui-prd.md) and [`docs/subagent-workflow-fullscreen-tui-design.md`](docs/subagent-workflow-fullscreen-tui-design.md).
