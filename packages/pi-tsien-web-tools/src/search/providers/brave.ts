import type { SearchProvider, SearchResult } from "../types.ts";
import { asArray, asRecord, requestSearchJson, toResult } from "./shared.ts";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Brave Search API (`BRAVE_API_KEY`). */
export class BraveProvider implements SearchProvider {
	readonly name = "brave";

	constructor(
		private readonly apiKey: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async search(query: string, limit: number): Promise<SearchResult[]> {
		const url = `${ENDPOINT}?${new URLSearchParams({ q: query, count: String(limit) })}`;
		const body = await requestSearchJson(this.fetchImpl, "Brave", url, {
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": this.apiKey,
			},
		});
		const results = asArray(asRecord(body.web)?.results);
		return results
			.slice(0, limit)
			.map((entry) => {
				const record = asRecord(entry);
				return record ? toResult(record, ["title"], ["url"], ["description"]) : null;
			})
			.filter((entry): entry is SearchResult => entry !== null);
	}
}