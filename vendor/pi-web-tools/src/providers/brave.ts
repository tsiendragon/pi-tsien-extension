import type { SearchProvider, SearchResult } from "./types.ts";

export class BraveSearchProvider implements SearchProvider {
	name = "brave";
	private apiKey: string;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	async search(query: string, limit = 10): Promise<SearchResult[]> {
		const params = new URLSearchParams({
			q: query,
			count: String(Math.min(limit, 20)),
		});

		const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": this.apiKey,
			},
		});

		if (!res.ok) {
			throw new Error(`Brave search failed: ${res.status} ${res.statusText}`);
		}

		const data = (await res.json()) as {
			web?: { results?: Array<{ title: string; url: string; description: string }> };
		};

		return (data.web?.results ?? []).slice(0, limit).map((r) => ({
			title: r.title,
			url: r.url,
			snippet: r.description,
		}));
	}
}
