import type { SearchProvider, SearchResult } from "../types.ts";
import { asArray, asRecord, requestSearchJson, toResult } from "./shared.ts";

const ENDPOINT = "https://www.googleapis.com/customsearch/v1";

/** Google Programmable Search (`GOOGLE_API_KEY` + `GOOGLE_CX`). */
export class GoogleProvider implements SearchProvider {
	readonly name = "google";

	constructor(
		private readonly apiKey: string,
		private readonly engineId: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async search(query: string, limit: number): Promise<SearchResult[]> {
		const url = `${ENDPOINT}?${new URLSearchParams({
			key: this.apiKey,
			cx: this.engineId,
			q: query,
			num: String(limit),
		})}`;
		const body = await requestSearchJson(this.fetchImpl, "Google", url, {
			headers: { Accept: "application/json" },
		});
		return asArray(body.items)
			.slice(0, limit)
			.map((entry) => {
				const record = asRecord(entry);
				return record ? toResult(record, ["title"], ["link"], ["snippet"]) : null;
			})
			.filter((entry): entry is SearchResult => entry !== null);
	}
}