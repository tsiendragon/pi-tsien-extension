# Pi `/goal` implementation

The extension makes long-running objectives explicit, branch-aware, and safe across compaction, reloads, resumes, and default-on continuation. Pi custom entries remain canonical; a local SQLite ledger is a rebuildable audit/materialized view, not an independent source of branch state.

## Compatibility baseline

Release `2026.8.13` requires Node.js `>=22.19.0`.

Pi supplies the host runtime through peer dependencies. Supported ranges are `@earendil-works/pi-coding-agent` `>=0.80.5 <0.81.0` and `@earendil-works/pi-tui` `>=0.79.3 <0.81.0`; local development validates both at `^0.80.10`.

Package smoke checks must confirm the npm tarball includes `extensions`, `src`, `README.md`, `docs`, `CHANGELOG.md`, `VERSION`, and `LICENSE`, with relative docs links intact. Release validation loads the installed extension with the minimum versions inferred from the peer ranges and with the 0.80.10 development baseline.

## Module map

| Area                             | File                          |
| -------------------------------- | ----------------------------- |
| Extension entry                  | `src/index.ts`                |
| State reducer and reconstruction | `src/state.ts`                |
| `/goal` command                  | `src/commands.ts`             |
| UI helpers                       | `src/ui.ts`                   |
| Docs import                      | `src/import.ts`               |
| Model tools                      | `src/tools.ts`                |
| Runtime hooks                    | `src/runtime.ts`              |
| Work graph and report rendering  | `src/goal-graph.ts`           |
| SQLite audit/materialized ledger | `src/ledger.ts`               |
| Prompt rendering                 | `src/prompts.ts`              |
| Public package entry             | `extensions/index.ts`         |
| Nested extension entry           | `extensions/pi-goal/index.ts` |

The package manifest points Pi at `./extensions/index.ts`.

## State model

Every mutation appends a Pi custom session entry with custom type `goal-state`. Current state is reconstructed from `ctx.sessionManager.getBranch()`, not from all session entries. That keeps `/tree`, forks, reload, and resume tied to the selected branch.

Supported statuses:

```typescript
type GoalStatus = "active" | "paused" | "complete";
```

Supported events: `create`, `replace`, `edit`, `pause`, `resume`, `clear`, `complete`, `progress`, `import-docs`, and `graph`.

New goals initialize work items from acceptance criteria. `graph` stores a full work-item/blocker snapshot plus append-only blocker attempts and report revisions. Legacy `version: 1` entries remain readable and derive their initial work items from acceptance criteria.

Important rules:

- Replacing a goal creates a new `goalId`.
- Later mutations for stale IDs are ignored.
- Complete goals are terminal until cleared or replaced.
- Paused goals can resume, report status, or clear, but do not receive hidden context, progress updates, completion, or continuation.
- Objectives are trimmed, non-empty, and limited to 4000 characters.

## Command behavior

| Command                                 | Behavior                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/goal`                                 | Show usage or the current summary.                                                                                                                                                                                                                                                                                    |
| `/goal <objective> [--start]`           | Strip recognized flags, confirm replacement when needed, then ask the chat agent to call `propose_goal_draft` exactly once. Nothing is saved until review completes. Interactive review offers Start, Edit, and Cancel. Non-interactive replacement requires `--replace`, but plain text still needs the review path. |
| `/goal start`                           | Queue one follow-up prompt for the existing active goal. Rejects missing, paused, complete, or changed goals.                                                                                                                                                                                                         |
| `/goal status`                          | Show objective, criteria, constraints, progress, blockers, source docs, and next commands.                                                                                                                                                                                                                            |
| `/goal import <path> [--yes] [--start]` | Import a supported file or folder. Creates a goal when none exists. Merges docs, constraints, and criteria into an existing active goal without replacing the objective. Paused or complete goals reject import. Non-interactive mode requires `--yes`; add `--start` to begin immediately.                           |
| `/goal edit`                            | Open the interactive editor. Non-interactive mode returns an actionable fallback.                                                                                                                                                                                                                                     |
| `/goal pause`                           | Set an active goal to paused.                                                                                                                                                                                                                                                                                         |
| `/goal resume [--start]`                | Reactivate a paused goal. Complete goals must be cleared or replaced.                                                                                                                                                                                                                                                 |
| `/goal complete [--yes]`                | Mark an active goal complete.                                                                                                                                                                                                                                                                                         |
| `/goal clear [--yes]`                   | Clear current goal state.                                                                                                                                                                                                                                                                                             |
| `/goal blockers [--markdown]`           | Open a read-only TUI overlay when available, otherwise print the current Markdown report. `export <path>` writes only to the specified path.                                                                                                                                                                          |

Mutating commands wait for idle and re-read current branch state before saving. This avoids racing active agent turns or goal replacement.

## Plain goal review

Plain goal text is a drafting request. `renderGoalAgentDraftingPrompt` tells the model to call `propose_goal_draft` with a concise objective, concrete acceptance criteria, and any source paths the user named.

Saved state includes only the reviewed objective, acceptance criteria, and source docs. A short tool note can appear in result metadata, but it is not persisted unless the user puts it in the reviewed content.

In non-interactive `-p` runs, `/goal <objective> --start` only queues this draft/review path. For immediate non-interactive work, use:

```text
/goal import docs/prd.md --yes --start
/goal resume --start
```

or an explicitly approved `create_goal` tool path.

## Import safety

`/goal import` accepts `.md`, `.markdown`, and `.txt` files. Directory import scans supported docs, skips generated/vendor directories, enforces file count and size limits, and fails on overflow instead of silently truncating.

Import extracts:

- objective,
- constraints,
- acceptance criteria,
- risks,
- open questions,
- referenced source paths,
- source document hash and compact brief.

Path checks are strict. Relative paths resolve inside the workspace first, then workspace and target are checked with `realpath`. Symlinks that escape the workspace are rejected for files and directories. Missing, unreadable, unsupported, binary, oversized, or out-of-workspace paths return clear errors. Imported docs are read-only inputs.

Imports are deterministic. New docs merge by path, with the new hash and brief winning for the same path. Constraints and criteria dedupe. Existing objectives are not rewritten.

## Model tools

| Tool                   | Boundary                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_goal`             | Read current state and source paths.                                                                                                                                                              |
| `create_goal`          | Requires `explicit_request: true` and no existing goal. This is for already-approved persistence, not plain `/goal` drafting.                                                                     |
| `propose_goal_draft`   | Requires objective and at least one acceptance criterion. Opens Start/Edit/Cancel review and saves only after Start. Returns `review_ui_unavailable` and saves nothing when review UI is missing. |
| `complete_goal`        | Marks only the current active goal complete, with optional evidence. Rejects paused and already complete goals.                                                                                   |
| `update_goal_progress` | Updates legacy progress fields only on active goals. Cannot rewrite objective, source docs, constraints, or criteria.                                                                             |
| `update_goal_graph`    | Replaces work-item/blocker snapshots and appends one immutable blocker attempt. It rejects `agent_can_try` for decision, credential, and safety blockers.                                         |

Tool policy denials return soft refusals with `details.status: "refused"` and a reason such as `permission_denied`, `goal_exists`, `no_goal`, `goal_inactive`, or `already_complete`. Invalid schema data and unexpected runtime failures are hard errors.

## Hidden context and compaction

Active goals inject one hidden custom message of type `goal-context` before an agent turn. Paused, complete, or cleared goals do not inject context.

The runtime removes stale `goal-context` messages from old branches or replaced goals and keeps only the latest message for the active `goalId`.

During `session_before_compact`, active goals preserve:

- objective,
- goal ID and status,
- acceptance criteria,
- source doc paths and briefs,
- progress summary, current work, done items, and blockers.

Canonical state still comes from `goal-state` entries after compaction. The compaction details are context for the model, not the source of truth.

## Start handoff and continuation

`/goal start` and `--start` queue one explicit follow-up prompt for the current active `goalId`. They do not enable recurring idle work and do not bypass paused or complete states.

Automatic continuation is enabled by default in this local fork. Pass `--goal-continuation=false` to disable it; the positive flag remains compatible. Conservative caps are configurable:

```bash
pi --no-extensions -e ./extensions/index.ts --goal-continuation-max-duration-hours 48 --goal-continuation-max-turns 0 --goal-continuation-max-no-progress-turns 2
```

Continuation queues only when:

- continuation was not explicitly disabled,
- the current branch has an active goal,
- Pi is idle,
- no pending user messages exist,
- no continuation is already queued or running,
- the max-turn and consecutive-no-progress caps are not reached,
- a ready work item exists, or a bounded `agent_can_try` blocker exploration is eligible,
- the goal ID still matches after re-read.

Finalization runs on `agent_settled`, not `agent_end`, after Pi has resolved retries, auto-compaction retries, and queued messages. This lifecycle event never queues another turn, so an Esc interruption can settle without immediately restarting the agent.

The default-on silence watchdog is the sole automatic scheduling path. It observes real entries on the current session branch. After 30 minutes without a new entry, it reuses the continuation guards and queues at most one `继续目标` follow-up for that silent window. The four-character prompt stays small because the hidden `goal-context` supplies the objective, work graph, blockers, and progress on the next turn. Configure the behavior with `--goal-continuation-watchdog=false` or `--goal-continuation-watchdog-silence-minutes <n>`. UI calls such as `ctx.ui.notify("EagleEye task settled")` are not branch entries and do not refresh the timer.

It records `goal-continuation` custom entries with source, turn, and no-progress counters, reconstructs unconsumed queues and counters after reload, and defaults to no wall-clock duration budget with no turn cap (`--goal-continuation-max-duration-hours 0`, `--goal-continuation-max-turns 0`; set a positive value to enable either cap). It stops on stale goal, pause, clear, complete, replacement, user interrupt, duplicate queue, pending messages, busy state, explicit disable, duration budget, no-progress budget, or a positive max-turn cap. A new non-continuation user message clears a `no-progress-budget` or `all-paths-blocked` stalemate stop (resetting the no-progress counter) so the next watchdog re-evaluates ready work; `max-turns` remains sticky until the goal is replaced. When every unfinished item is covered by hard blockers or dependency closure, it persists an `all_paths_blocked` Markdown report in the canonical state and SQLite ledger.

## UI behavior

The UI uses public Pi primitives and degrades cleanly:

- draft review uses `ctx.ui.select`, `ctx.ui.editor`, and `ctx.ui.confirm`,
- TUI mode uses themed widget components and semantic theme tokens,
- RPC, JSON, print, and older hosts get readable plain text/status output,
- the active-goal widget stays compact and shows objective, criteria count, blockers, and current work,
- `/goal status` carries detailed state,
- `ctx.ui.setStatus("goal-progress", ...)` uses Powerline's extension-status area for `🎯 done/total`, blocker count, and ready count,
- `/goal blockers` offers a filterable read-only overlay and a Markdown fallback,
- non-interactive errors name the next command or flag.

No legacy footer replacement is rendered.

## Runtime and harness alignment

- `InputEvent.text` is the preferred input source, with compatibility fallbacks.
- Explicit handoffs use `sendUserMessage(..., { deliverAs: "followUp" })`.
- Older `streamingBehavior: "followUp"` is treated as compatibility input, not the primary outbound API.
- Behavior is keyed from `ctx.mode` so TUI and non-TUI hosts get the right output form.

## Intentional non-adoptions

| Feature                       | Why not now                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Project-trust-specific config | Session branch state and confirmations already guard risky mutations.                                        |
| `getSystemPromptOptions`      | Runtime hooks and compaction already inject active-goal context.                                             |
| Rich autocomplete             | Basic `/goal` subcommand completions exist. Richer completions can wait for real command-discovery friction. |

## Codex comparison

| Area         | Pi Agent Goal behavior                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Persistence  | Pi custom entries are canonical per branch; `~/.pi/agent/pi-goal.sqlite` is a user-private rebuildable audit/materialized ledger.                |
| Commands     | Main goal lifecycle plus explicit `/goal start`, non-interactive `--start`, confirmations, and clean flag parsing.                               |
| Model tools  | Narrow tools only. No general objective rewrite tool.                                                                                            |
| Compaction   | `session_before_compact` preserves active-goal summary/details while canonical state stays in custom entries.                                    |
| Continuation | Default-on only in this local fork, capped by turns/no-progress and guarded by idle, pending-message, stale-goal, work-graph, and policy checks. |
| UI           | Compact active-goal widget, `/goal status`, and tool renderers.                                                                                  |

Intentional gaps: no Codex app-server RPC compatibility, no exact token/time accounting, and no exact Codex menu UI.

## Verification

Canonical release commands live in [`acceptance-criteria.md`](acceptance-criteria.md#validation-commands).

Live TUI smoke is still manual and release-blocking for `/compact`, `/reload`, `/resume`, `/tree`, `/fork`, and the visible active-goal widget. Automated tests cover hooks and reconstruction behavior, not the live terminal.

## Troubleshooting

| Symptom                                | Fix                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Import path rejected                   | Run Pi from the workspace root or import a file inside it. Symlinks cannot point outside the workspace.                                         |
| Directory import reports too many docs | Narrow the path or raise `maxFiles`. Import fails rather than dropping docs.                                                                    |
| Import requires `--yes`                | Review the source, rerun with `--yes`, and add `--start` only for immediate handoff.                                                            |
| Goal replacement rejected              | Confirm interactively or use `--replace` to authorize the replacement draft. Persistence still needs review unless using an approved tool path. |
| `/goal edit` fails                     | It needs interactive UI. Use `/goal <objective> --replace` without UI.                                                                          |
| Draft queued but no review appears     | The agent must call `propose_goal_draft`; a prose answer saves nothing.                                                                         |
| `review_ui_unavailable`                | Use the Pi TUI review path or an explicitly approved `create_goal` request.                                                                     |
| `/goal start` does not queue           | Confirm the goal exists, is active, and follow-up messaging is available.                                                                       |
| Continuation does not queue            | Keep the goal active, wait for idle, ensure no pending messages exist, and confirm it was not explicitly disabled.                              |
| Background completion does not resume  | The silence watchdog queues one guarded follow-up after 30 minutes; check its flags and continuation stop reason.                               |
| Goal appears branch-stale              | Run `/goal status`; branch `goal-state` entries are the source of truth.                                                                        |

## Future work

- Optional richer Pi TUI popup if users need more than the compact widget plus `/goal status`.
- Optional stricter Codex parity, such as token/time accounting or RPC compatibility, if Pi users need it.
