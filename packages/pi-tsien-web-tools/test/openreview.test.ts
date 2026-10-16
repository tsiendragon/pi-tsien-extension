import assert from "node:assert/strict";
import test from "node:test";

import {
	OpenReviewClient,
	buildOpenReviewSearchUrl,
	formatOpenReviewResults,
	parseOpenReviewSearch,
} from "../src/academic/openreview.ts";

/** Shape taken from a real `GET /notes/search` answer: review notes carry no title. */
const PAYLOAD = {
	count: 10000,
	notes: [
		{
			cdate: 1730341127825,
			content: { rating: { value: 5 }, summary: { value: "review text" } },
			forum: "rGGwXo0Fo0",
			id: "89zGtBv5oW",
			invitations: ["ICLR.cc/2025/Conference/Submission8452/-/Official_Review", "ICLR.cc/2025/Conference/-/Edit"],
		},
		{
			cdate: 1640995200000,
			content: {
				abstract: { value: "Digital documents are increasingly used as credible evidence." },
				authors: { value: ["Weipeng Liang", "Li Dong", "Rangding Wang", "Diqun Yan", "Yuanman Li"] },
				pdf: { value: "https://ieeexplore.ieee.org/iel7/x/y.pdf" },
				title: { value: "Robust Document Image Forgery Localization Against Image Blending" },
				venue: { value: "TrustCom 2022" },
			},
			forum: "yX0nPFjxFT",
			id: "yX0nPFjxFT",
			invitations: ["DBLP.org/-/Record", "DBLP.org/-/Edit"],
		},
		{
			content: { title: { value: "Same paper, edit note" } },
			forum: "yX0nPFjxFT",
			id: "edit-note",
			invitations: ["DBLP.org/-/Edit"],
		},
	],
};

test("buildOpenReviewSearchUrl targets the search endpoint", () => {
	const url = new URL(buildOpenReviewSearchUrl("document forgery", 20));
	assert.equal(url.origin + url.pathname, "https://api2.openreview.net/notes/search");
	assert.equal(url.searchParams.get("term"), "document forgery");
	assert.equal(url.searchParams.get("limit"), "20");
	assert.equal(url.searchParams.get("offset"), "0");
});

test("parseOpenReviewSearch keeps papers only, de-duplicates by forum, honours limit", () => {
	const papers = parseOpenReviewSearch(PAYLOAD, 5);
	assert.equal(papers.length, 1);
	const paper = papers[0];
	assert.equal(paper.title, "Robust Document Image Forgery Localization Against Image Blending");
	assert.equal(paper.venue, "TrustCom 2022");
	assert.equal(paper.date, "2022-01-01");
	assert.equal(paper.url, "https://openreview.net/forum?id=yX0nPFjxFT");
	assert.equal(paper.pdfUrl, "https://ieeexplore.ieee.org/iel7/x/y.pdf");
	assert.deepEqual(paper.authors.slice(0, 2), ["Weipeng Liang", "Li Dong"]);
	assert.match(paper.abstract, /^Digital documents/);

	assert.equal(parseOpenReviewSearch(PAYLOAD, 0).length, 0);
	assert.equal(parseOpenReviewSearch({}, 5).length, 0);
});

test("parseOpenReviewSearch falls back to the forum pdf link", () => {
	const papers = parseOpenReviewSearch(
		{ notes: [{ content: { title: { value: "T" } }, forum: "F", invitations: ["X/-/Submission"], id: "F" }] },
		5,
	);
	assert.equal(papers[0].pdfUrl, "https://openreview.net/pdf?id=F");
	assert.equal(papers[0].venue, "");
});

test("formatOpenReviewResults mentions the review filtering when empty", () => {
	assert.match(formatOpenReviewResults([], "x"), /reviews\/comments are filtered out/);
	const text = formatOpenReviewResults(parseOpenReviewSearch(PAYLOAD, 5), "forgery");
	assert.match(text, /1\. \*\*Robust Document/);
	assert.match(text, /TrustCom 2022 · 2022-01-01/);
	assert.match(text, /Authors: Weipeng Liang, Li Dong, Rangding Wang, Diqun Yan et al\. \(5 authors\)/);
});

test("OpenReviewClient asks for a wider window then slices, and surfaces HTTP failures", async () => {
	const calls: string[] = [];
	const okFetch = (async (url: string) => {
		calls.push(url);
		return { json: async () => PAYLOAD, ok: true, status: 200, statusText: "OK", text: async () => "" };
	}) as unknown as typeof fetch;
	const papers = await new OpenReviewClient(okFetch).search("document forgery", 3);
	assert.equal(papers.length, 1);
	assert.match(calls[0], /limit=20/); // widened before filtering

	const failing = (async () => ({ ok: false, status: 403, statusText: "Forbidden" })) as unknown as typeof fetch;
	await assert.rejects(() => new OpenReviewClient(failing).search("x", 1), /OpenReview search failed: 403/);
});
