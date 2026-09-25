import type { SearchProvider, SearchResult } from "../types.ts";
import { asArray, asRecord, requestSearchJson, toResult } from "./shared.ts";

/** Self-hosted SearXNG instance (`SEARXNG_URL`). */
export class SearxngProvider implements SearchProvider {
	readonly name = "searxng";

	constructor(
		private readonly baseUrl: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async search(query: string, limit: number): Promise<SearchResult[]> {
		const base = this.baseUrl.replace(/\/+$/, "");
		const url = `${base}/search?${new URLSearchParams({ q: query, format: "json" })}`;
		const body = await requestSearchJson(this.fetchImpl, "SearXNG", url, {
			headers: { Accept: "application/json" },
		});
		return asArray(body.results)
			.slice(0, limit)
			.map((entry) => {
				const record = asRecord(entry);
				return record ? toResult(record, ["title"], ["url"], ["content", "snippet"]) : null;
			})
			.filter((entry): entry is SearchResult => entry !== null);
	}
}