# vendor/pi-web-tools (patched) — 已停用，保留作回滚

> **状态（2026-09-25）**：WebSearch/WebFetch 已切换为自研实现 `packages/pi-tsien-web-tools`，
> 本目录**不再被加载**。保留原因：回滚路径（把 `extensions.config.json` 的 web-tools 来源改回本目录即可）
> 与本文件记录的第三方来历/合规信息。上游仓库无许可证，故本副本不得公开分发或发布到 npm。

Vendored copy of `pi-web-tools` **0.1.0** (Brett Atoms — https://github.com/brettatoms/pi-web-tools).

## Why vendored

WebSearch stopped returning anything: every query produced `No results found`.
No search-provider key is configured, so the extension falls back to scraping
`https://lite.duckduckgo.com/lite/`. DuckDuckGo changed the lite markup, and the
upstream parser regex no longer matched it:

- upstream regex expected `class` **before** `href` and required **double quotes**:
  `/<a[^>]+class="result-link"[^>]*href="([^"]*)"…/`
- the live markup now emits `href` **first** and uses **single quotes**:
  `<a rel="nofollow" href="…" class='result-link'>…</a>`

Result: 0 links parsed → 0 results. The same mismatch affected `<td … class='result-snippet'>`.

Because this is our WebSearch/WebFetch path, the repo keeps a patched copy and
loads it through the user-level `/home/tsien/.pi/agent/extensions.config.json`
(package source `${PI_TSIEN_EXTENSION_ROOT}/vendor/pi-web-tools`) instead of
`git:github.com/brettatoms/pi-web-tools`.

## Patch scope

### 1. `src/providers/duckduckgo.ts` (DDG lite scraping)

- Parse the whole `<a …>…</a>` / `<td …>…</td>` block and read attributes
  order-independently, accepting single **or** double quotes, instead of a
  fixed attribute order + double quotes.
- Decode DDG's protocol-relative redirect (`//duckduckgo.com/l/?uddg=<encoded>`)
  into the real target URL, so callers such as WebFetch get a directly usable
  absolute URL rather than an unusable `//…` link.
- `parseDDGLite` is exported so the vendor regression test can call it directly.

### 2. `src/web-fetch.ts` (lazy heavy deps)

- `jsdom`, `@mozilla/readability`, `turndown` and `turndown-plugin-gfm` were
  imported at module scope, so **every Pi start** paid to load them. Measured
  with Pi's `PI_TIMING=1`: the `pi-web-tools` module import was ~1.1s (cold
  ~1.8s), ~2/3 of all extension-load time — and jsdom alone is ~500 files,
  read from NFS.
- They are now loaded with `await import(…)` inside `fetchAndExtract()`, on the
  first actual WebFetch call. Steady-state `pi-web-tools` module import dropped
  to ~30ms; total Pi startup went from ~1.7s to ~0.6–0.8s on this machine.
- Extraction behavior is unchanged.

Everything else keeps upstream behavior: provider selection (`resolveProvider`),
Brave/Kagi/Google/SearXNG providers, and tool registration are untouched.

## Runtime dependencies

WebFetch needs `@mozilla/readability`, `jsdom`, `turndown`, and
`turndown-plugin-gfm`. They are declared in the **repo root** `package.json` so a
single `npm install` at the repo root makes them resolvable from this vendored
directory (Node walks up to `node_modules/`). Pi aliases `@mariozechner/*` and
`@sinclair/typebox` to its bundled modules at load time, so those need no install.

## Update procedure

1. Re-copy upstream `pi-web-tools` `src/`, `README.md`, `package.json` over this directory.
2. Re-apply both patches above (`duckduckgo.ts` parser + `web-fetch.ts` lazy imports).
3. Run `npm run test:node` — `test/pi-web-tools-vendor.test.ts` guards the parser
   against both the current single-quote markup and the older double-quote markup.