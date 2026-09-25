import assert from "node:assert/strict";
import test from "node:test";

import { DuckDuckGoProvider, parseLiteResults, resolveResultUrl } from "../src/search/providers/duckduckgo.ts";

/** Current live shape: `href` first, single quotes, protocol-relative redirect. */
const CURRENT_MARKUP = `
<table>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=aa" class='result-link'>Example Docs</a></td></tr>
  <tr><td class='result-snippet'>Reference for the example project.</td></tr>
  <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.test%2Fpage" class='result-link'>Other Page</a></td></tr>
  <tr><td class='result-snippet'>A second snippet.</td></tr>
</table>`;

/** Older shape: `class` first, double quotes, plain absolute href. */
const LEGACY_MARKUP = `
<a class="result-link" href="https://legacy.example/item">Legacy Item</a>
<td class="result-snippet">Legacy snippet.</td>`;

test("parses the current single-quote, href-first markup", () => {
	const results = parseLiteResults(CURRENT_MARKUP, 10);
	assert.equal(results.length, 2);
	assert.deepEqual(results[0], {
		snippet: "Reference for the example project.",
		title: "Example Docs",
		url: "https://example.com/docs",
	});
	assert.equal(results[1].url, "https://other.test/page");
});

test("still parses the legacy double-quote markup", () => {
	const results = parseLiteResults(LEGACY_MARKUP, 10);
	assert.equal(results.length, 1);
	assert.equal(results[0].title, "Legacy Item");
	assert.equal(results[0].url, "https://legacy.example/item");
	assert.equal(results[0].snippet, "Legacy snippet.");
});

test("respects the limit and ignores unrelated links", () => {
	const html = `${CURRENT_MARKUP}<a href="/settings">Settings</a>`;
	assert.equal(parseLiteResults(html, 1).length, 1);
	assert.equal(parseLiteResults(html, 10).length, 2);
});

test("decodes redirect wrappers and leaves plain urls alone", () => {
	assert.equal(
		resolveResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fb%3Fc%3D1&rut=x"),
		"https://a.test/b?c=1",
	);
	assert.equal(resolveResultUrl("https://plain.test/x"), "https://plain.test/x");
});

test("reports failures from the lite endpoint", async () => {
	const failing = (async () => ({ ok: false, status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch;
	const provider = new DuckDuckGoProvider(failing);
	await assert.rejects(() => provider.search("q", 5), /DuckDuckGo search failed: 503/);
});

test("sends the query to the lite endpoint and parses the response", async () => {
	const calls: string[] = [];
	const fakeFetch = (async (url: string) => {
		calls.push(url);
		return { ok: true, status: 200, statusText: "OK", text: async () => CURRENT_MARKUP };
	}) as unknown as typeof fetch;

	const provider = new DuckDuckGoProvider(fakeFetch);
	const results = await provider.search("pi coding agent", 5);
	assert.equal(results.length, 2);
	assert.match(calls[0], /^https:\/\/lite\.duckduckgo\.com\/lite\/\?q=pi\+coding\+agent$/);
});