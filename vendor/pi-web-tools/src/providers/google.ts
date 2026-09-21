import type { SearchProvider, SearchResult } from "./types.ts";

export class GoogleSearchProvider implements SearchProvider {
	name = "google";
	private apiKey: string;
	private cx: string;

	constructor(apiKey: string, cx: string) {
		this.apiKey = apiKey;
		this.cx = cx;
	}

	async search(query: string, limit = 10): Promise<SearchResult[]> {
		const params = new URLSearchParams({
			key: this.apiKey,
			cx: this.cx,
			q: query,
			num: String(Math.min(limit, 10)), // Google CSE max is 10 per request
		});

		const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);

		if (!res.ok) {
			throw new Error(`Google search failed: ${res.status} ${res.statusText}`);
		}

		const data = (await res.json()) as {
			items?: Array<{ title: string; link: string; snippet: string }>;
		};

		return (data.items ?? []).slice(0, limit).map((r) => ({
			title: r.title,
			url: r.link,
			snippet: r.snippet,
		}));
	}
}
