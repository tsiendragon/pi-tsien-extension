import type { SearchProvider, SearchResult } from "../types.ts";
import { asArray, asRecord, requestSearchJson, toResult } from "./shared.ts";

const ENDPOINT = "https://kagi.com/api/v0/search";
/** Kagi returns `t: 0` entries for web results and other values for related blocks. */
const WEB_RESULT_TYPE = 0;

/** Kagi Search API (`KAGI_API_KEY`). */
export class KagiProvider implements SearchProvider {
	readonly name = "kagi";

	constructor(
		private readonly apiKey: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async search(query: string, limit: number): Promise<SearchResult[]> {
		const url = `${ENDPOINT}?${new URLSearchParams({ q: query, limit: String(limit) })}`;
		const body = await requestSearchJson(this.fetchImpl, "Kagi", url, {
			headers: {
				Accept: "application/json",
				Authorization: `Bot ${this.apiKey}`,
			},
		});
		return asArray(body.data)
			.slice(0, limit)
			.map((entry) => {
				const record = asRecord(entry);
				if (!record || record.t !== WEB_RESULT_TYPE) return null;
				return toResult(record, ["title"], ["url"], ["snippet", "description"]);
			})
			.filter((entry): entry is SearchResult => entry !== null);
	}
}