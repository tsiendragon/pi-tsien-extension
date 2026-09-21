import type { SearchProvider, SearchResult } from "./types.ts";

export class SearXNGProvider implements SearchProvider {
	name = "searxng";
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	async search(query: string, limit = 10): Promise<SearchResult[]> {
		const params = new URLSearchParams({
			q: query,
			format: "json",
			number_of_results: String(limit),
		});

		const res = await fetch(`${this.baseUrl}/search?${params}`, {
			headers: { Accept: "application/json" },
		});

		if (!res.ok) {
			throw new Error(`SearXNG search failed: ${res.status} ${res.statusText}`);
		}

		const data = (await res.json()) as {
			results?: Array<{ title: string; url: string; content: string }>;
		};

		return (data.results ?? []).slice(0, limit).map((r) => ({
			title: r.title,
			url: r.url,
			snippet: r.content,
		}));
	}
}
