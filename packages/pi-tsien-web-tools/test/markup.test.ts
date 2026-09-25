import assert from "node:assert/strict";
import test from "node:test";

import { attributeOf, decodeEntities, findElements, hasClass, textOf } from "../src/html/markup.ts";

test("reads attributes regardless of order, quote style and value shape", () => {
	const tag = `<a rel="nofollow" href="/x" class='result-link' data-id=42>`;
	assert.equal(attributeOf(tag, "href"), "/x");
	assert.equal(attributeOf(tag, "class"), "result-link");
	assert.equal(attributeOf(tag, "data-id"), "42");
	assert.equal(attributeOf(tag, "missing"), null);
});

test("class checks are token based, not substring based", () => {
	assert.equal(hasClass(`<a class='result-link extra'>`, "result-link"), true);
	assert.equal(hasClass(`<a class='not-result-link'>`, "result-link"), false);
	assert.equal(hasClass(`<a href="/x">`, "result-link"), false);
});

test("decodes named and numeric entities and collapses whitespace", () => {
	assert.equal(decodeEntities("a&amp;b &#39;q&#x27; &lt;z&gt;"), "a&b 'q' <z>");
	assert.equal(textOf("<b>Hello</b>\n   <i>world</i>"), "Hello world");
});

test("scans elements in document order, skipping unclosed tags", () => {
	const html = `<a href="/1">one</a><span>x</span><a href="/2">two</a><a href="/3">`;
	const anchors = findElements(html, "a");
	assert.deepEqual(
		anchors.map((entry) => entry.inner),
		["one", "two"],
	);
	assert.equal(attributeOf(anchors[1].tag, "href"), "/2");
});

test("handles nested elements of the same name", () => {
	const html = `<td class="x"><td class="y">inner</td>outer</td><td class="z">next</td>`;
	const cells = findElements(html, "td");
	assert.equal(cells.length, 2);
	assert.equal(cells[0].inner, `<td class="y">inner</td>outer`);
	assert.equal(textOf(cells[1].inner), "next");
});

test("findTagEnd ignores '>' inside quoted attribute values", () => {
	const html = `<a title="a > b" href="/x">link</a>`;
	const [anchor] = findElements(html, "a");
	assert.equal(attributeOf(anchor.tag, "href"), "/x");
});