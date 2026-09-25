import { BraveProvider } from "./providers/brave.ts";
import { DuckDuckGoProvider } from "./providers/duckduckgo.ts";
import { GoogleProvider } from "./providers/google.ts";
import { KagiProvider } from "./providers/kagi.ts";
import { SearxngProvider } from "./providers/searxng.ts";
import { PROVIDER_ENV_KEYS, PROVIDER_IDS, type ProviderId, type SearchProvider } from "./types.ts";

export type { SearchProvider, SearchResult } from "./types.ts";

export interface ProviderOptions {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

/**
 * Pick a search provider.
 *
 * `PI_WEB_SEARCH_PROVIDER` wins when set; otherwise the first provider whose
 * credentials are present is used, and DuckDuckGo is the key-less fallback.
 */
export function resolveSearchProvider(options: ProviderOptions = {}): SearchProvider {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const requested = env.PI_WEB_SEARCH_PROVIDER?.trim().toLowerCase();

	if (requested) {
		if (!isProviderId(requested)) {
			throw new Error(
				`Unknown PI_WEB_SEARCH_PROVIDER: "${requested}". Valid options: ${PROVIDER_IDS.join(", ")}`,
			);
		}
		return createProvider(requested, env, fetchImpl);
	}

	for (const id of ["brave", "kagi", "google", "searxng"] as const) {
		if (PROVIDER_ENV_KEYS[id].every((key) => env[key])) {
			return createProvider(id, env, fetchImpl);
		}
	}

	return new DuckDuckGoProvider(fetchImpl);
}

function isProviderId(value: string): value is ProviderId {
	return (PROVIDER_IDS as readonly string[]).includes(value);
}

function createProvider(id: ProviderId, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): SearchProvider {
	switch (id) {
		case "brave":
			return new BraveProvider(requireEnv(env, "BRAVE_API_KEY", "Brave"), fetchImpl);
		case "kagi":
			return new KagiProvider(requireEnv(env, "KAGI_API_KEY", "Kagi"), fetchImpl);
		case "google":
			return new GoogleProvider(
				requireEnv(env, "GOOGLE_API_KEY", "Google"),
				requireEnv(env, "GOOGLE_CX", "Google"),
				fetchImpl,
			);
		case "searxng":
			return new SearxngProvider(requireEnv(env, "SEARXNG_URL", "SearXNG"), fetchImpl);
		case "duckduckgo":
			return new DuckDuckGoProvider(fetchImpl);
	}
}

function requireEnv(env: NodeJS.ProcessEnv, key: string, label: string): string {
	const value = env[key];
	if (!value) throw new Error(`${key} env var required for ${label} search`);
	return value;
}