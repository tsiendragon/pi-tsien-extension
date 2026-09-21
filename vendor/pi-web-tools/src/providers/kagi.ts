import type { SearchProvider, SearchResult } from "./types.ts";

export class KagiSearchProvider implements SearchProvider {
	name = "kagi";
	private apiKey: string;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	async search(query: string, limit = 10): Promise<SearchResult[]> {
		const params = new URLSearchParams({
			q: query,
			limit: String(limit),
		});

		const res = await fetch(`https://kagi.com/api/v0/search?${params}`, {
			headers: {
				Authorization: `Bot ${this.apiKey}`,
			},
		});

		if (!res.ok) {
			throw new Error(`Kagi search failed: ${res.status} ${res.statusText}`);
		}

		const data = (await res.json()) as {
			data?: Array<{ t: number; url?: string; title?: string; snippet?: string }>;
		};

		return (data.data ?? [])
			.filter((r) => r.t === 0 && r.url)
			.slice(0, limit)
			.map((r) => ({
				title: r.title ?? "",
				url: r.url!,
				snippet: (r.snippet ?? "").replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
			}));
	}
}
