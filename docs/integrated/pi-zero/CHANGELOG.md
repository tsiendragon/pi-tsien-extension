# Changelog

All notable changes to `@zerosnow/pi-zero` are documented in this file.

## [0.3.0] - 2026-08

### Added
- **Transcript history window.** Pi now defaults to rendering the newest 20 user-started turns, with earlier turns represented by one expandable-on-command notice. Session data and model context remain unchanged.
- Added `/transcript status`, `/transcript expand`, `/transcript collapse`, and `/transcript turns <n>`, plus global/project `transcriptWindow` configuration.
- Added the versioned `pi.zero.pre-powerline.v1` component host for Extensions that need stable placement immediately before the primary Powerline.

## [0.2.5] - 2026-08

### Fixed
- **Powerline thinking segment stayed stale after switching thinking levels.**
  The `thinking` segment (and the `think:<level>` text on the `model` segment)
  snapshotted the thinking level once at `session_start` and never refreshed,
  so cycling levels with `Shift+Tab` left the status bar showing the previous
  level until a full reload. The extension now subscribes to pi's
  `thinking_level_select` event, adopts the freshly selected level, invalidates
  the layout cache, and requests an immediate repaint.


## [0.2.3] - 2026-08

### Fixed
- **Severe TUI lag in long sessions.** The compact-thinking fork's thinking
  preview (`StrictThinkingPreview`) re-wrapped the entire thinking text on every
  render. Because pi re-renders every visible assistant message on each
  keystroke, in a long session (many large thinking blocks) that O(n) wrap ran
  dozens of times per keypress, causing ~400ms+ typing and deletion lag.

  The preview is now cached by content (`text` + `width` + `previewLines`),
  making unchanged previews O(1) and restoring near-instant keystroke
  responsiveness. The cache is bounded (evicts past 400 entries) and returns a
  defensive copy, so a downstream in-place mutation cannot corrupt it.

## [0.2.2] - 2026-08

### Fixed
- **Mermaid / custom code blocks rendered as raw source when thinking is hidden.**
  The compact assistant renderer (compact-style) and the compact-thinking fork
  re-created Pi's `Markdown` component without the `transform` option that applies
  Pi's markdown transformers (e.g. the built-in mermaid renderer). With
  `hideThinkingBlock` enabled, ` ```mermaid ` blocks showed as raw source instead
  of terminal box-drawing art. Both renderers now apply the transformer chain
  (mirroring Pi's internal `createMarkdownTransform`), restoring mermaid and any
  custom transformer rendering.

### Changed
- **Git status is event-driven.** Powerline no longer runs `git status --porcelain`
  from status-bar renders on a one-second cache TTL. It refreshes after safe Pi
  lifecycle events or an explicit `/powerline refresh`, preventing contention
  with Git writers such as rebase and commit.
- The default Git polling mode is now `event`; legacy `full` configuration is
  accepted and normalized to `event`.

## [0.2.1] - 2026-08

### Fixed
- **Misleading "press ctrl-o to expand" hint on large diffs.** The diff
  collapse hint was emitted unconditionally whenever a diff had hidden content,
  even in the expanded state. Since pi's `app.tools.expand` binding (`ctrl+o`)
  is a binary toggle, pressing it again in the expanded view collapsed the diff
  instead of revealing more, trapping the user on the `expandedPreviewMaxLines`
  cap for huge single edits/writes.

  The expanded-state hint no longer advertises `ctrl+o`; it now reads
  `raise "Expanded max lines" in /ccstyle`, guiding the user to the real knob.
  Collapsed-state behavior is unchanged.

## [0.2.0] - 2026-02

### Fixed
- **Crash on pi 0.84+ startup.** The tool-mouse interaction feature patched
  `TuiMainScreen.doRender`, which recursed infinitely under pi's proxy-based
  TUI reference (`createInteractiveTuiReference`), throwing
  `RangeError: Maximum call stack size exceeded` and preventing pi from opening.

### Removed
- **Tool-mouse interaction** (fixed-editor-only hover/click/scroll affordances).
  pi-zero does not include the fixed editor, so this feature was non-functional.
  Its removal also eliminates the startup crash above.

### Changed
- Syntax highlighting for write diffs now uses `@shikijs/cli`, shipped as an
  **optional dependency**. Highlighting falls back to plain rendering if the
  package cannot be installed.
- Cleaned up pre-existing type errors and dead code across `powerline`,
  `context`, and `ccstyle` (unused imports, stale return types, dead fields).

## [0.1.0] - 2026-01

- Initial release.
