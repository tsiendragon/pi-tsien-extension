# pi-web-tools

WebSearch and WebFetch tools for [pi-coding-agent](https://github.com/badlogic/pi-mono).

## Install

```bash
pi install git:github.com/brettatoms/pi-web-tools
```

Or for local development:

```bash
pi install /path/to/pi-web-tools
```

Or test without installing:

```bash
pi -e /path/to/pi-web-tools
```

## Tools

### WebSearch

Search the web and return results with titles, URLs, and snippets.

```
WebSearch query="htmx hx-swap documentation" limit=5
```

### WebFetch

Fetch a web page and extract readable content as markdown.

```
WebFetch url="https://htmx.org/docs/" prompt="hx-swap attribute usage and examples"
```

## Search Providers

The extension auto-detects which search provider to use based on available environment variables. You can also set `PI_WEB_SEARCH_PROVIDER` explicitly.

| Provider | Env Vars | Notes |
|----------|----------|-------|
| **Brave** | `BRAVE_API_KEY` | Recommended. Free tier: 2000 queries/month. [Get a key](https://brave.com/search/api/) |
| **Kagi** | `KAGI_API_KEY` | High quality results. Paid API. [Get a key](https://help.kagi.com/kagi/api/overview.html) |
| **Google** | `GOOGLE_API_KEY` + `GOOGLE_CX` | Free tier: 100 queries/day. [Setup](https://developers.google.com/custom-search/v1/overview) |
| **SearXNG** | `SEARXNG_URL` | Self-hosted, no API key. Point to your instance URL |
| **DuckDuckGo** | *(none)* | Zero-config fallback. Scrapes HTML, may be fragile |

### Auto-detection priority

1. `PI_WEB_SEARCH_PROVIDER` env var (if set, uses that provider)
2. Brave (if `BRAVE_API_KEY` is set)
3. Kagi (if `KAGI_API_KEY` is set)
4. Google (if `GOOGLE_API_KEY` + `GOOGLE_CX` are set)
5. SearXNG (if `SEARXNG_URL` is set)
6. DuckDuckGo (always available)
