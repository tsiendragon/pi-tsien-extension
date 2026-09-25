import { attributeOf, findElements, hasClass, textOf } from "../../html/markup.ts";
import type { SearchProvider, SearchResult } from "../types.ts";

const LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const LINK_CLASS = "result-link";
const SNIPPET_CLASS = "result-snippet";

/**
 * Key-less search by scraping the DuckDuckGo lite HTML endpoint.
 *
 * This is the always-available provider: no credentials, and the reason the package
 * works out of the box. It is also the most fragile one, because it depends on the
 * page layout — see `test/duckduckgo.test.ts` for the markup shapes we support.
 */
export class DuckDuckGoProvider implements SearchProvider {
	readonly name = "duckduckgo";

	constructor(private readonly fetchImpl: typeof fetch = fetch) {}

	async search(query: string, limit: number): Promise<SearchResult[]> {
		const url = `${LITE_ENDPOINT}?${new URLSearchParams({ q: query })}`;
		const response = await this.fetchImpl(url, {
			headers: {
				Accept: "text/html",
				"User-Agent": BROWSER_USER_AGENT,
			},
		});
		if (!response.ok) {
			throw new Error(`DuckDuckGo search failed: ${response.status} ${response.statusText}`);
		}
		return parseLiteResults(await response.text(), limit);
	}
}

export const BROWSER_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

/**
 * Extract results from a DuckDuckGo lite page.
 *
 * Links and snippets live in separate tables (one row per result), so both lists are
 * read in document order and paired positionally.
 */
export function parseLiteResults(html: string, limit: number): SearchResult[] {
	const results: SearchResult[] = [];
	for (const element of findElements(html, "a")) {
		if (results.length >= limit) break;
		if (!hasClass(element.tag, LINK_CLASS)) continue;
		const href = attributeOf(element.tag, "href");
		const title = textOf(element.inner);
		if (!href || !title) continue;
		results.push({ snippet: "", title, url: resolveResultUrl(href) });
	}

	const snippets = findElements(html, "td")
		.filter((element) => hasClass(element.tag, SNIPPET_CLASS))
		.map((element) => textOf(element.inner));
	for (const [index, result] of results.entries()) {
		result.snippet = snippets[index] ?? "";
	}

	return results.slice(0, limit);
}

/**
 * DuckDuckGo wraps results in protocol-relative redirects such as
 * `//duckduckgo.com/l/?uddg=<encoded target>&rut=<hash>`. Return the decoded target so
 * callers (WebFetch) get a URL they can open directly.
 */
export function resolveResultUrl(href: string): string {
	const absolute = href.startsWith("//") ? `https:${href}` : href;
	try {
		const url = new URL(absolute, "https://duckduckgo.com");
		return url.searchParams.get("uddg") ?? absolute;
	} catch {
		return href;
	}
}