# Pi Agent Goal

Pi Agent Goal adds persistent `/goal` workflows to Pi. Use it to set a long-running objective, import context from docs, track progress, keep state aligned with branch history, and start agent work only when you ask for it.

Repository: [`KristjanPikhof/Pi-Agent-Goal`](https://github.com/KristjanPikhof/Pi-Agent-Goal)

## Compatibility

Release `2026.8.13` requires Node.js `>=22.19.0`.

The package supports `@earendil-works/pi-coding-agent` `>=0.80.5 <0.81.0` and `@earendil-works/pi-tui` `>=0.79.3 <0.81.0`. Development uses both packages at `^0.80.10`. Release validation runs package smoke checks against the minimum peer versions and the 0.80.10 development baseline. The coding-agent floor is required because continuation finalization uses `agent_settled`.

Published package contents must include `extensions`, `src`, `README.md`, `docs`, `CHANGELOG.md`, `VERSION`, and `LICENSE`. Keep docs links relative so they work from both GitHub and npm tarballs.

## Quick start

```bash
pi install npm:pi-agent-goal
pi
```

Then run:

```text
/goal
```

With no saved goal, `/goal` shows help. To create one interactively:

```text
/goal Ship the onboarding cleanup
```

Pi asks the chat agent to draft a concise objective and acceptance criteria. In the TUI, review the draft, then choose Start, Edit, or Cancel. Nothing is saved until you choose Start.

If a goal already exists, start one explicit agent handoff with:

```text
/goal start
```

## Non-interactive starts

Plain non-interactive `/goal <objective> --start` does not save or start work by itself. It only queues the agent-mediated draft/review path, which still needs `propose_goal_draft` and review before persistence.

Use an already-approved path when a non-interactive run should begin immediately:

```bash
pi -e npm:pi-agent-goal -p "/goal import docs/prd.md --yes --start"
pi -e npm:pi-agent-goal -p "/goal resume --start"
```

## Install options

| Need                  | Command                                       |
| --------------------- | --------------------------------------------- |
| Global install        | `pi install npm:pi-agent-goal`                |
| Project-local install | `pi install -l npm:pi-agent-goal`             |
| One-off run           | `pi -e npm:pi-agent-goal`                     |
| Local checkout run    | `pi --no-extensions -e ./extensions/index.ts` |

See [`docs/setup.md`](docs/setup.md) for settings.json examples and local development links.

## Commands

| Command                                 | What it does                                                                                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/goal`                                 | Show help or the current goal summary.                                                                                                                                                                                                                          |
| `/goal <objective> [--start]`           | Ask the chat agent to draft a reviewable goal with `propose_goal_draft`. Interactive Start saves and queues one handoff. Edit opens the draft editor. Cancel saves nothing. Recognized flags such as `--replace` and `--start` are stripped from the objective. |
| `/goal start`                           | Queue one explicit handoff for the current active goal. This is not automatic continuation.                                                                                                                                                                     |
| `/goal status`                          | Show objective, status, criteria, constraints, source docs, progress, blockers, and next commands.                                                                                                                                                              |
| `/goal import <path> [--yes] [--start]` | Import a markdown/text PRD file or docs folder. Creates a goal when none exists. Merges docs, constraints, and criteria into an existing active goal without rewriting the objective. Non-interactive mode needs `--yes`; add `--start` to begin immediately.   |
| `/goal edit`                            | Edit the objective and acceptance criteria in the interactive UI. Non-interactive mode should use `/goal <objective> --replace`.                                                                                                                                |
| `/goal pause`                           | Pause the goal and stop hidden context, continuation, completion, and progress updates.                                                                                                                                                                         |
| `/goal resume [--start]`                | Reactivate a paused goal. Add `--start` for an immediate non-interactive handoff.                                                                                                                                                                               |
| `/goal complete [--yes]`                | Mark an active goal complete.                                                                                                                                                                                                                                   |
| `/goal clear [--yes]`                   | Clear the current goal and hide goal UI.                                                                                                                                                                                                                        |
| `/goal blockers [--markdown]`           | Show the current blocker report. TUI opens a read-only overlay by default; `--markdown` prints the report as text, and `export <path>` writes only to the explicitly supplied path.                                                                             |

## How plain goal review works

Plain `/goal` text is a drafting request, not direct persistence. The command asks the chat agent to call `propose_goal_draft` once with:

- a concise objective,
- concrete acceptance criteria,
- optional source paths.

Only the reviewed objective, criteria, and source paths are saved. If the model replies in prose instead of calling the tool, no goal is saved. If review UI is unavailable, the tool returns `review_ui_unavailable` and saves nothing.

## Model tools

The extension exposes narrow tools on purpose:

- `get_goal`, read current goal state and source paths.
- `create_goal`, create an already-approved goal only when `explicit_request` is true and no goal exists.
- `propose_goal_draft`, open the Start/Edit/Cancel review flow for agent-drafted `/goal` proposals.
- `complete_goal`, mark an active goal complete with optional evidence.
- `update_goal_progress`, update legacy progress fields only.
- `update_goal_graph`, update work items, structured blockers, and immutable blocker attempts.

Expected denials, such as no active goal or missing authorization, return soft refusals with `details.status: "refused"`. Invalid input and unexpected failures remain hard tool errors.

## State and autonomy

Canonical state is stored as Pi session custom entries of type `goal-state`. The extension reconstructs state from `ctx.sessionManager.getBranch()`, so forks, `/tree`, reload, and resume follow the selected branch instead of a global latest value.

Active goals inject a short hidden `goal-context` before agent turns. Compaction preserves objective, criteria, source doc briefs, and progress in summary details. Full imported docs are not repeatedly pasted into model context.

`/goal start` and `--start` queue one explicit handoff. They do not enable background work.

This local fork enables automatic continuation by default. Disable it with `--goal-continuation=false`; `--goal-continuation` remains compatible. `agent_settled` syncs continuation state after Pi finishes retries and queued messages; it never queues another turn by itself, so Esc does not immediately restart the agent.

When a session starts with an active goal, a periodic timer queues the four-character prompt `继续目标` every 20 minutes by default. Configure a positive interval with `--goal-continuation-interval-minutes <n>`. Only one follow-up may be queued for a goal at once; its input clears that queue so the next interval can continue. Pause, complete, clear, disable, or session shutdown stops future periodic follow-ups. This is intentionally periodic, not a silence watchdog: it does not use idle or pending-message state as a trigger.

A goal owns work items and structured blockers. A hard blocker affects only its related items, so independent ready work can continue when the agent is invoked. Session entries remain canonical; a user-private SQLite materialized ledger at `~/.pi/agent/pi-goal.sqlite` supports restart audit and report storage without deciding branch state.

## Known Codex parity gaps

These gaps are intentional for this Pi-native release:

- no Codex `thread_goals` schema or app-server RPC compatibility,
- no exact token budget or wall-clock accounting when Pi does not expose stable usage,
- no exact Codex goal menu or bottom-pane UI,
- no general model objective-rewrite tool,
- no automated proof of live TUI lifecycle behavior.

Live TUI smoke for `/compact`, `/reload`, `/resume`, `/tree`, `/fork`, and the visible active-goal widget remains manual and release-blocking. Record evidence before release, or mark the release blocked. Automated tests cover the underlying hooks and reconstruction behavior, not the live terminal.

## Troubleshooting

| Symptom                                  | Fix                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import path is outside the workspace     | Run from the workspace root or move the file inside it. Realpaths are checked, including symlink escapes.                                           |
| Import requires `--yes`                  | Non-interactive mode cannot confirm. Review the source, rerun with `--yes`, and add `--start` only if work should begin immediately.                |
| Directory import has too many docs       | Narrow the path or raise `maxFiles` in code/tests. Import fails rather than silently truncating.                                                    |
| Replacement fails non-interactively      | Use `/goal <objective> --replace` to authorize the replacement draft. It still saves only after review unless you use an approved persistence path. |
| `/goal edit` fails                       | The editor is interactive-only. Use `/goal <objective> --replace` instead.                                                                          |
| Draft queued but no review appears       | The chat agent must call `propose_goal_draft`. A prose answer saves nothing.                                                                        |
| `review_ui_unavailable`                  | Run the review path in the Pi TUI, or use an explicitly approved `create_goal` request.                                                             |
| Continuation does not start              | Keep the goal active, confirm `--goal-continuation` is not false, check `--goal-continuation-interval-minutes`, and wait for the next interval. |
| Goal looks stale after branch navigation | Run `/goal status`; state is reconstructed from the selected branch.                                                                                |

## Local verification

Canonical release checks are listed in [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md#validation-commands).

```bash
npm run typecheck
npm run lint
npm run format
npm test
npm run test:coverage
npm pack --dry-run
npm run smoke:pi
npm run smoke:package
```

## More docs

- [`docs/README.md`](docs/README.md), doc map and release notes.
- [`docs/setup.md`](docs/setup.md), install and local development.
- [`docs/implementation.md`](docs/implementation.md), architecture and behavior reference.
- [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md), acceptance status, test matrix, and manual smoke checklist.

## License

MIT. See [`LICENSE`](LICENSE).
