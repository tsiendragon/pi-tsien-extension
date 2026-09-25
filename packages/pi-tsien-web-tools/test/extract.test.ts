import assert from "node:assert/strict";
import test from "node:test";

import { extract, fetchPage } from "../src/fetch/extract.ts";

const ARTICLE = `<!doctype html>
<html><head><title>Extraction Fixture</title></head>
<body>
  <nav><a href="/">home</a></nav>
  <article>
    <h1>Extraction Fixture</h1>
    <p>${"Readable paragraph text. ".repeat(40)}</p>
    <h2>Details</h2>
    <p>Second section with a <a href="https://link.test">useful link</a>.</p>
    <pre><code>const x = 1;</code></pre>
  </article>
  <footer>footer noise</footer>
</body></html>`;

const EMPTY_PAGE = `<!doctype html><html><head><title>Blank</title></head><body><div id="content"></div></body></html>`;

function responseOf(body: string, options: { contentType?: string; ok?: boolean; status?: number; url?: string } = {}): Response {
	const contentType = options.contentType ?? "text/html; charset=utf-8";
	return {
		headers: new Headers({ "content-type": contentType }),
		ok: options.ok ?? true,
		status: options.status ?? 200,
		statusText: options.status === undefined || options.ok === false ? "Error" : "OK",
		text: async () => body,
		url: options.url ?? "https://page.test/final",
	} as unknown as Response;
}

test("extracts an article into markdown with a title", async () => {
	const page = await extract(ARTICLE, "https://page.test/article");
	assert.equal(page.title, "Extraction Fixture");
	assert.equal(page.url, "https://page.test/article");
	assert.match(page.content, /Readable paragraph text\./);
	assert.match(page.content, /## Details/);
	assert.match(page.content, /\[useful link\]\(https:\/\/link\.test\/?\)/);
	assert.doesNotMatch(page.content, /footer noise/);
});

test("falls back to main-content extraction when readability finds nothing", async () => {
	const page = await extract(EMPTY_PAGE, "https://page.test/blank");
	assert.equal(page.content, "(Could not extract readable content)");
});

test("fetchPage uses the final url and returns extracted content", async () => {
	const fakeFetch = (async () => responseOf(ARTICLE, { url: "https://page.test/redirected" })) as unknown as typeof fetch;
	const page = await fetchPage("https://page.test/start", { fetchImpl: fakeFetch });
	assert.equal(page.url, "https://page.test/redirected");
	assert.match(page.content, /Details/);
});

test("fetchPage rejects non-html content types", async () => {
	const fakeFetch = (async () => responseOf("%PDF-1.7", { contentType: "application/pdf" })) as unknown as typeof fetch;
	await assert.rejects(() => fetchPage("https://page.test/file.pdf", { fetchImpl: fakeFetch }), /Unsupported content type: application\/pdf/);
});

test("fetchPage rejects oversized pages and http failures", async () => {
	const huge = (async () => responseOf("x".repeat(2048))) as unknown as typeof fetch;
	await assert.rejects(() => fetchPage("https://page.test/huge", { fetchImpl: huge, maxBytes: 1024 }), /Page too large/);

	const missing = (async () => responseOf("", { ok: false, status: 404 })) as unknown as typeof fetch;
	await assert.rejects(() => fetchPage("https://page.test/missing", { fetchImpl: missing }), /Fetch failed: 404/);
});