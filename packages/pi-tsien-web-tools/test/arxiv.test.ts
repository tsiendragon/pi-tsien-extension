import assert from "node:assert/strict";
import test from "node:test";

import {
	ArxivClient,
	buildArxivUrl,
	formatArxivResults,
	looksLikeArxivId,
	parseArxivFeed,
} from "../src/academic/arxiv.ts";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2609.33683v1</id>
    <updated>2026-09-27T15:45:14Z</updated>
    <published>2026-09-27T15:45:14Z</published>
    <title>MAD-Guard: Controlled
  Study of Autoregressive &amp; Direct Decision</title>
    <summary>When should multimodal foundation models generate tokens,
and when should they decide directly? We compare both.</summary>
    <author><name>Hao Chen</name></author>
    <author><name>Jane Doe</name></author>
    <link href="https://arxiv.org/abs/2609.33683v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="https://arxiv.org/pdf/2609.33683v1" rel="related" type="application/pdf"/>
    <category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CR" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/0000.00001v1</id>
    <title>   </title>
  </entry>
</feed>`;

test("looksLikeArxivId detects new- and old-style ids", () => {
	assert.equal(looksLikeArxivId("2603.01433"), true);
	assert.equal(looksLikeArxivId("arXiv:2603.01433v2"), true);
	assert.equal(looksLikeArxivId("cs.CV/0701001"), true);
	assert.equal(looksLikeArxivId("document forgery"), false);
});

test("buildArxivUrl passes queries through and maps sort", () => {
	const url = new URL(buildArxivUrl({ limit: 5, query: 'all:"document forgery"' }));
	assert.equal(url.origin + url.pathname, "https://export.arxiv.org/api/query");
	assert.equal(url.searchParams.get("search_query"), 'all:"document forgery"');
	assert.equal(url.searchParams.get("max_results"), "5");
	assert.equal(url.searchParams.get("sortBy"), "relevance");
	assert.equal(new URL(buildArxivUrl({ limit: 3, query: "ti:forgery", sort: "newest" })).searchParams.get("sortBy"), "submittedDate");
});

test("buildArxivUrl uses id_list for a bare id and adds category filters", () => {
	const byId = new URL(buildArxivUrl({ limit: 1, query: "arXiv:2603.01433" }));
	assert.equal(byId.searchParams.get("id_list"), "2603.01433");
	assert.equal(byId.searchParams.get("search_query"), null);

	const filtered = new URL(buildArxivUrl({ category: "cs.CV", limit: 10, query: "forgery" }));
	assert.equal(filtered.searchParams.get("search_query"), "(forgery) AND cat:cs.CV");
});

test("parseArxivFeed extracts metadata and skips title-less entries", () => {
	const papers = parseArxivFeed(FEED);
	assert.equal(papers.length, 1);
	const paper = papers[0];
	assert.equal(paper.id, "2609.33683v1");
	assert.equal(paper.title, "MAD-Guard: Controlled Study of Autoregressive & Direct Decision");
	assert.equal(paper.published, "2026-09-27");
	assert.deepEqual(paper.authors, ["Hao Chen", "Jane Doe"]);
	assert.deepEqual(paper.categories, ["cs.CV", "cs.CR"]);
	assert.equal(paper.url, "https://arxiv.org/abs/2609.33683v1");
	assert.equal(paper.pdfUrl, "https://arxiv.org/pdf/2609.33683v1");
	assert.match(paper.summary, /^When should multimodal/);
});

test("formatArxivResults renders id, date, categories and a clipped abstract", () => {
	const text = formatArxivResults(parseArxivFeed(FEED), "forgery");
	assert.match(text, /1\. \*\*MAD-Guard/);
	assert.match(text, /arXiv:2609\.33683v1 · 2026-09-27 · cs\.CV, cs\.CR/);
	assert.match(text, /Authors: Hao Chen, Jane Doe/);
	assert.match(text, /https:\/\/arxiv\.org\/abs\/2609\.33683v1/);
	assert.equal(formatArxivResults([], "nothing"), 'No arXiv papers found for: "nothing"');
});

test("ArxivClient surfaces HTTP failures", async () => {
	const client = new ArxivClient((async () => ({ ok: false, status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch);
	await assert.rejects(() => client.search("forgery", 1), /arXiv request failed: 503/);
});
