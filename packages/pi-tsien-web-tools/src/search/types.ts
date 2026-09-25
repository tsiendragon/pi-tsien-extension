/** Provider-agnostic search contract. */
export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchProvider {
	/** Short identifier reported in tool output and status text. */
	name: string;
	/** Resolve up to `limit` results for `query`. */
	search(query: string, limit: number): Promise<SearchResult[]>;
}

export interface SearchRequest {
	url: string;
	init: RequestInit;
}

/** Endpoints and authentication used by the JSON-API providers. */
export const PROVIDER_IDS = ["brave", "kagi", "google", "searxng", "duckduckgo"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Env vars that make a provider usable without asking the user to pick one. */
export const PROVIDER_ENV_KEYS: Record<Exclude<ProviderId, "duckduckgo">, string[]> = {
	brave: ["BRAVE_API_KEY"],
	kagi: ["KAGI_API_KEY"],
	google: ["GOOGLE_API_KEY", "GOOGLE_CX"],
	searxng: ["SEARXNG_URL"],
};