import type { SearchProvider } from "./types.ts";
import { BraveSearchProvider } from "./brave.ts";
import { GoogleSearchProvider } from "./google.ts";
import { KagiSearchProvider } from "./kagi.ts";
import { SearXNGProvider } from "./searxng.ts";
import { DuckDuckGoProvider } from "./duckduckgo.ts";

export type { SearchProvider, SearchResult } from "./types.ts";

/**
 * Resolve a search provider from environment variables.
 *
 * Priority:
 * 1. PI_WEB_SEARCH_PROVIDER env var (explicit choice)
 * 2. Auto-detect: first provider with required env vars set
 *    - brave: BRAVE_API_KEY
 *    - kagi: KAGI_API_KEY
 *    - google: GOOGLE_API_KEY + GOOGLE_CX
 *    - searxng: SEARXNG_URL
 *    - duckduckgo: always available (no key needed)
 */
export function resolveProvider(): SearchProvider {
	const explicit = process.env.PI_WEB_SEARCH_PROVIDER?.toLowerCase();

	if (explicit) {
		const provider = createProvider(explicit);
		if (!provider) {
			throw new Error(
				`Unknown PI_WEB_SEARCH_PROVIDER: "${explicit}". ` +
					`Valid options: brave, kagi, google, searxng, duckduckgo`,
			);
		}
		return provider;
	}

	// Auto-detect
	if (process.env.BRAVE_API_KEY) {
		return new BraveSearchProvider(process.env.BRAVE_API_KEY);
	}
	if (process.env.KAGI_API_KEY) {
		return new KagiSearchProvider(process.env.KAGI_API_KEY);
	}
	if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) {
		return new GoogleSearchProvider(process.env.GOOGLE_API_KEY, process.env.GOOGLE_CX);
	}
	if (process.env.SEARXNG_URL) {
		return new SearXNGProvider(process.env.SEARXNG_URL);
	}

	// Fallback
	return new DuckDuckGoProvider();
}

function createProvider(name: string): SearchProvider | null {
	switch (name) {
		case "brave": {
			const key = process.env.BRAVE_API_KEY;
			if (!key) throw new Error("BRAVE_API_KEY env var required for Brave search");
			return new BraveSearchProvider(key);
		}
		case "kagi": {
			const key = process.env.KAGI_API_KEY;
			if (!key) throw new Error("KAGI_API_KEY env var required for Kagi search");
			return new KagiSearchProvider(key);
		}
		case "google": {
			const key = process.env.GOOGLE_API_KEY;
			const cx = process.env.GOOGLE_CX;
			if (!key || !cx) throw new Error("GOOGLE_API_KEY and GOOGLE_CX env vars required for Google search");
			return new GoogleSearchProvider(key, cx);
		}
		case "searxng": {
			const url = process.env.SEARXNG_URL;
			if (!url) throw new Error("SEARXNG_URL env var required for SearXNG search");
			return new SearXNGProvider(url);
		}
		case "duckduckgo":
			return new DuckDuckGoProvider();
		default:
			return null;
	}
}
