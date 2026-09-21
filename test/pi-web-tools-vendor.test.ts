import assert from "node:assert/strict";
import test from "node:test";

import { parseDDGLite } from "../vendor/pi-web-tools/src/providers/duckduckgo.ts";

// Current DDG lite markup: `href` before `class`, single-quoted attributes, and
// protocol-relative redirect links (`//duckduckgo.com/l/?uddg=<encoded>`).
const CURRENT_MARKUP = `
<table>
  <tr>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FHello%2C_world&amp;rut=abc" class='result-link'>Hello, world - Wikipedia</a></td>
  </tr>
  <tr><td class='result-snippet'>A <b>Hello, world</b> program prints &amp; exits.</td></tr>
  <tr>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=def" class='result-link'>Example Docs</a></td>
  </tr>
  <tr><td class='result-snippet'>Documentation home.</td></tr>
</table>
`;

// Older DDG lite markup: double quotes and `class` before `href`.
const LEGACY_MARKUP = `
<table>
  <tr>
    <td><a class="result-link" href="https://example.org/a">Legacy A</a></td>
  </tr>
  <tr><td class="result-snippet">Legacy snippet.</td></tr>
</table>
`;

test("vendored DDG parser reads current single-quote, href-first markup", () => {
	const results = parseDDGLite(CURRENT_MARKUP, 10);
	assert.equal(results.length, 2);
	assert.equal(results[0].title, "Hello, world - Wikipedia");
	assert.equal(results[0].url, "https://en.wikipedia.org/wiki/Hello,_world");
	assert.equal(results[0].snippet, "A Hello, world program prints & exits.");
	assert.equal(results[1].url, "https://example.com/docs");
	assert.equal(results[1].snippet, "Documentation home.");
});

test("vendored DDG parser still reads legacy double-quote markup", () => {
	const results = parseDDGLite(LEGACY_MARKUP, 10);
	assert.equal(results.length, 1);
	assert.equal(results[0].title, "Legacy A");
	assert.equal(results[0].url, "https://example.org/a");
	assert.equal(results[0].snippet, "Legacy snippet.");
});

test("vendored DDG parser respects the limit and ignores unrelated links", () => {
	const html = `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test" class='result-link'>A</a>
	<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.test" class='result-link'>B</a>
	<a href="https://not-a-result.test" class='other'>ignored</a>`;
	const results = parseDDGLite(html, 1);
	assert.equal(results.length, 1);
	assert.equal(results[0].url, "https://a.test");
});