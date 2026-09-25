import assert from "node:assert/strict";
import test from "node:test";

import { resolveSearchProvider } from "../src/search/provider.ts";

interface Call {
	url: string;
	init?: RequestInit;
}

function jsonFetch(payload: unknown, calls: Call[] = []): typeof fetch {
	return (async (url: string, init?: RequestInit) => {
		calls.push({ init, url });
		return {
			json: async () => payload,
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => JSON.stringify(payload),
		};
	}) as unknown as typeof fetch;
}

test("falls back to key-less duckduckgo", () => {
	assert.equal(resolveSearchProvider({ env: {}, fetchImpl: jsonFetch({}) }).name, "duckduckgo");
});

test("auto-detects the first provider with credentials", () => {
	assert.equal(resolveSearchProvider({ env: { SEARXNG_URL: "http://s" } }).name, "searxng");
	assert.equal(
		resolveSearchProvider({ env: { BRAVE_API_KEY: "k", KAGI_API_KEY: "k2" } }).name,
		"brave",
	);
	assert.equal(
		resolveSearchProvider({ env: { GOOGLE_API_KEY: "k", GOOGLE_CX: "cx" } }).name,
		"google",
	);
});

test("honours an explicit provider choice", () => {
	assert.equal(
		resolveSearchProvider({ env: { PI_WEB_SEARCH_PROVIDER: "Kagi", KAGI_API_KEY: "k" } }).name,
		"kagi",
	);
	assert.equal(
		resolveSearchProvider({ env: { PI_WEB_SEARCH_PROVIDER: "duckduckgo", BRAVE_API_KEY: "k" } }).name,
		"duckduckgo",
	);
});

test("rejects unknown and under-configured providers", () => {
	assert.throws(
		() => resolveSearchProvider({ env: { PI_WEB_SEARCH_PROVIDER: "bing" } }),
		/Unknown PI_WEB_SEARCH_PROVIDER: "bing"/,
	);
	assert.throws(
		() => resolveSearchProvider({ env: { PI_WEB_SEARCH_PROVIDER: "brave" } }),
		/BRAVE_API_KEY env var required/,
	);
	assert.throws(
		() => resolveSearchProvider({ env: { PI_WEB_SEARCH_PROVIDER: "google", GOOGLE_API_KEY: "k" } }),
		/GOOGLE_CX env var required/,
	);
});

test("brave: sends the subscription token and maps web results", async () => {
	const calls: Call[] = [];
	const provider = resolveSearchProvider({
		env: { PI_WEB_SEARCH_PROVIDER: "brave", BRAVE_API_KEY: "secret" },
		fetchImpl: jsonFetch({ web: { results: [{ title: "T", url: "https://a.test", description: "D" }] } }, calls),
	});
	const results = await provider.search("q", 3);
	assert.deepEqual(results, [{ snippet: "D", title: "T", url: "https://a.test" }]);
	assert.match(calls[0].url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
	assert.equal((calls[0].init?.headers as Record<string, string>)["X-Subscription-Token"], "secret");
});

test("kagi: keeps only web results and sends the Bot token", async () => {
	const calls: Call[] = [];
	const provider = resolveSearchProvider({
		env: { PI_WEB_SEARCH_PROVIDER: "kagi", KAGI_API_KEY: "secret" },
		fetchImpl: jsonFetch(
			{
				data: [
					{ snippet: "keep", t: 0, title: "T", url: "https://a.test" },
					{ t: 1, title: "related", url: "https://noise.test" },
				],
			},
			calls,
		),
	});
	const results = await provider.search("q", 5);
	assert.equal(results.length, 1);
	assert.equal(results[0].url, "https://a.test");
	assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bot secret");
});

test("google: maps items and passes key/cx/num", async () => {
	const calls: Call[] = [];
	const provider = resolveSearchProvider({
		env: { PI_WEB_SEARCH_PROVIDER: "google", GOOGLE_API_KEY: "k", GOOGLE_CX: "cx" },
		fetchImpl: jsonFetch({ items: [{ link: "https://a.test", snippet: "S", title: "T" }] }, calls),
	});
	const results = await provider.search("q", 7);
	assert.deepEqual(results, [{ snippet: "S", title: "T", url: "https://a.test" }]);
	assert.match(calls[0].url, /key=k&cx=cx&q=q&num=7|key=k&cx=cx/);
});

test("searxng: tolerates a trailing slash and maps results", async () => {
	const calls: Call[] = [];
	const provider = resolveSearchProvider({
		env: { PI_WEB_SEARCH_PROVIDER: "searxng", SEARXNG_URL: "http://searx.local/" },
		fetchImpl: jsonFetch({ results: [{ content: "C", title: "T", url: "https://a.test" }] }, calls),
	});
	const results = await provider.search("q", 4);
	assert.deepEqual(results, [{ snippet: "C", title: "T", url: "https://a.test" }]);
	assert.match(calls[0].url, /^http:\/\/searx\.local\/search\?q=q&format=json$/);
});

test("json providers surface HTTP failures with the provider label", async () => {
	const failing = (async () => ({ ok: false, status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
	const provider = resolveSearchProvider({
		env: { PI_WEB_SEARCH_PROVIDER: "brave", BRAVE_API_KEY: "k" },
		fetchImpl: failing,
	});
	await assert.rejects(() => provider.search("q", 5), /Brave search failed: 401/);
});