import type { SearchProvider, SearchResult } from "./types.ts";

/**
 * DuckDuckGo search via the HTML lite endpoint.
 * No API key needed, but fragile — relies on HTML scraping.
 */
export class DuckDuckGoProvider implements SearchProvider {
	name = "duckduckgo";

	async search(query: string, limit = 10): Promise<SearchResult[]> {
		const params = new URLSearchParams({ q: query });

		const res = await fetch(`https://lite.duckduckgo.com/lite/?${params}`, {
			headers: {
				"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
				Accept: "text/html",
			},
		});

		if (!res.ok) {
			throw new Error(`DuckDuckGo search failed: ${res.status} ${res.statusText}`);
		}

		const html = await res.text();
		return parseDDGLite(html, limit);
	}
}

function stripTags(value: string): string {
	return value
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * DDG lite result links are protocol-relative redirect URLs such as
 * `//duckduckgo.com/l/?uddg=<encoded target>&rut=<hash>`. Return the real target
 * so callers (e.g. WebFetch) get a directly usable absolute URL.
 */
function decodeResultHref(href: string): string {
	try {
		const absolute = href.startsWith("//") ? `https:${href}` : href;
		const url = new URL(absolute, "https://duckduckgo.com");
		const target = url.searchParams.get("uddg");
		return target ?? absolute;
	} catch {
		return href;
	}
}

export function parseDDGLite(html: string, limit: number): SearchResult[] {
	// DDG lite currently emits single-quoted attributes and places `href` before
	// `class`, so match the whole anchor/td and read attributes order-independently
	// instead of relying on a fixed attribute order + double quotes.
	const linkRegex = /<a\b[^>]*\bclass=["']result-link["'][^>]*>([\s\S]*?)<\/a>/gi;
	const snippetRegex = /<td\b[^>]*\bclass=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi;

	const links: Array<{ url: string; title: string }> = [];
	let match: RegExpExecArray | null;

	while ((match = linkRegex.exec(html)) !== null) {
		const hrefMatch = match[0].match(/\bhref=["']([^"']*)["']/i);
		if (!hrefMatch) continue;
		links.push({
			url: decodeResultHref(hrefMatch[1]),
			title: stripTags(match[1]),
		});
	}

	const snippets: string[] = [];
	while ((match = snippetRegex.exec(html)) !== null) {
		snippets.push(stripTags(match[1]));
	}

	return links.slice(0, Math.max(limit, 0)).map((link, index) => ({
		title: link.title,
		url: link.url,
		snippet: snippets[index] ?? "",
	}));
}