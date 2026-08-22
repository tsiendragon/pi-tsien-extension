# pi-zero

A curated pi extension suite that combines the best of `pi-powerline-footer` and `pi-cc-extensions` into a single, lean package — without bash mode, queue, stash, shortcuts, welcome page, or other extras.

## Features

| Module | Feature | Entry |
|--------|---------|-------|
| **powerline** | Powerline-style status bar (git branch, token usage, model, context %) | automatic |
| **vibe** | Random themed working-message (file or generate mode), merged with token / elapsed-time stats | automatic |
| **context** | Context-window usage inspector with System Prompt / Tools / Skills preview | `/context` |
| **ccstyle** | Claude Code style tool rendering (collapse / compact / animation / rich diff) + compact thinking | `/ccstyle` |
| **transcript** | Default-on history window that renders only the newest conversation turns | `/transcript` |
| **shared** | Generic helpers (`getAgentPath`, `showTextPreview`) shared across modules | — |

## Install

Install from npm as a pi package:

```bash
pi install npm:@zerosnow/pi-zero
```

Then run `/reload` in the pi TUI.

> Requires Node.js >= 22.19.

## Commands

| Command | Description |
|---------|-------------|
| `/context` | Show context-window distribution; press Enter/click to preview parts |
| `/ccstyle [on\|off\|compact\|status\|panel]` | Switch or configure Claude Code style tool rendering |
| `/transcript [status\|expand\|collapse\|turns <n>]` | Inspect, expand, restore, or temporarily resize the history window |
| `/vibe [theme\|off\|mode\|model\|generate]` | Configure the working-message vibe |
| `/powerline [on\|off\|refresh\|preset\|placement]` | Toggle the status bar, manually refresh Git state, or set its preset / placement |

## Configuration

Global config lives in `~/.pi/agent/settings.json`. `pi-zero` reads these keys:

- `workingVibe`, `workingVibeMode`, `workingVibeModel` — vibe theme, mode (`file`/`generate`), model
- `powerline` — status bar `preset`, `placement`, `disabledSegments`, `customItems`, etc.
  - Exposes the process-local `pi.zero.pre-powerline.v1` component host so compatible Extensions can render immediately before the primary Powerline without replacing its content or Footer.
  - Git status is event-driven by default: Pi refreshes it at session start and after supported write or Git commands, never from status-bar rendering.
  - `powerline.segmentOptions.git.polling` accepts `event` (default), `branch`, or `off`; legacy `full` is treated as `event`.
  - Run `/powerline refresh` after edits made outside Pi.
- `transcriptWindow` — controls the process-local TUI history window. Omitted configuration defaults to enabled with the newest 20 user-started turns visible.
  - Fields: `enabled`, `recentTurns` (integer 1–200), `hideHistoricalTools`, and `hideHistoricalThinking`.
  - Global fields are overridden by `.pi/settings.json` fields in the current project. Invalid values safely use defaults.
  - `/transcript expand` shows full history until Pi exits; `/transcript collapse` returns to configured behaviour; `/transcript turns <n>` is also process-local.
- `workingVibeShimmer` — shimmer sweep animation (handled by a separate local extension)

## Runtime dependencies

`compact-thinking` needs `jiti` (regular dependency) and `pi-compact-thinking` (a pi package, shipped as a bundled dependency).
When installed via `pi install npm:@zerosnow/pi-zero`, pi runs `npm install`, so these are installed automatically — no manual setup needed.

Syntax highlighting for write diffs is provided by `@shikijs/cli`, shipped as an **optional dependency**. When it is available, `ccstyle` colors code blocks in diff previews; if it cannot be installed, highlighting gracefully falls back to plain rendering.

## Structure

```
pi-zero/
├── index.ts            entry (loaded by pi auto-discovery)
├── shared/             generic helpers shared across modules
├── powerline/          status bar
├── vibe/               random working-message
├── context/            /context inspector
├── transcript-window/  process-local transcript window
└── ccstyle/            Claude Code style tool rendering (+ tool-diff/)
```

## Compatibility & Notes

- `ccstyle` patches pi's tool rendering (similar to fixed-editor); if you ever see layout issues, run `/ccstyle off` to fall back to native rendering.
- **Long-session responsiveness.** `compact-thinking`'s thinking preview is cached by content, so typing and deletion stay responsive even in very long sessions with many large thinking blocks.
- The transcript window patches Pi's interactive transcript entry point. If a future Pi version changes that internal shape, pi-zero safely leaves Pi's native full-history renderer in place.
- Fixed editor is **not** included, and the fixed-editor-only tool-mouse interaction (hover/click/scroll affordances) has been removed.
- Multiple pi processes are isolated: state is process-local (global symbols), and session boundaries are cleaned on `session_start`.

## Acknowledgements

- Status bar, vibe: adapted from [`pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer) (MIT)
- ccstyle, `/context`, token/time stats: adapted from [`pi-cc-extensions`](https://github.com/minuque/pi-cc-extensions) (Proprietary)
- Rich diff: adapted from [`pi-tool-display`](https://github.com/MasuRii/pi-tool-display) (MIT) — see `ccstyle/tool-diff/ATTRIBUTION.md`

## License

MIT (for the pi-zero-specific composition; see individual attributions above).
