# vendor/pi-web-tools (patched)

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

## Patch scope (only `src/providers/duckduckgo.ts`)

- Parse the whole `<a …>…</a>` / `<td …>…</td>` block and read attributes
  order-independently, accepting single **or** double quotes, instead of a
  fixed attribute order + double quotes.
- Decode DDG's protocol-relative redirect (`//duckduckgo.com/l/?uddg=<encoded>`)
  into the real target URL, so callers such as WebFetch get a directly usable
  absolute URL rather than an unusable `//…` link.
- `parseDDGLite` is exported so the vendor regression test can call it directly.

Nothing else is changed: provider selection (`resolveProvider`), Brave/Kagi/
Google/SearXNG providers, WebFetch extraction, and tool registration keep
upstream behavior.

## Runtime dependencies

WebFetch needs `@mozilla/readability`, `jsdom`, `turndown`, and
`turndown-plugin-gfm`. They are declared in the **repo root** `package.json` so a
single `npm install` at the repo root makes them resolvable from this vendored
directory (Node walks up to `node_modules/`). Pi aliases `@mariozechner/*` and
`@sinclair/typebox` to its bundled modules at load time, so those need no install.

## Update procedure

1. Re-copy upstream `pi-web-tools` `src/`, `README.md`, `package.json` over this directory.
2. Re-apply the `duckduckgo.ts` patch above.
3. Run `npm run test:node` — `test/pi-web-tools-vendor.test.ts` guards the parser
   against both the current single-quote markup and the older double-quote markup.