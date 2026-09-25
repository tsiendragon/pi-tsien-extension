/**
 * Dependency-free HTML helpers.
 *
 * WebSearch scrapes one page layout (DuckDuckGo lite) where the markup we need is
 * plain, non-nested `<a>`/`<td>` pairs. Pulling in a DOM parser for that would cost
 * hundreds of files at load time, so this module scans tags directly.
 *
 * The scanner never assumes attribute order and accepts both quote styles because
 * the live duckduckgo.com markup has used `href` before `class` with single quotes.
 */

const ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
};

export function decodeEntities(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name: string) => {
		if (name.startsWith("#x") || name.startsWith("#X")) {
			const code = Number.parseInt(name.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		if (name.startsWith("#")) {
			const code = Number.parseInt(name.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[name.toLowerCase()] ?? match;
	});
}

/** Block-level tags separate words; inline tags (b/i/code/span/…) must not insert spaces. */
const BLOCK_TAGS = /<\/?(?:br|p|div|li|tr|td|th|table|tbody|section|article|h[1-6]|ul|ol|pre|blockquote)\b[^>]*>/gi;

/** Strip tags, decode entities and collapse whitespace — for titles and snippets. */
export function textOf(html: string): string {
	return decodeEntities(html.replace(BLOCK_TAGS, " ").replace(/<[^>]*>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

/** Read one attribute from a raw opening tag, independent of order and quote style. */
export function attributeOf(tag: string, name: string): string | null {
	const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
	const match = pattern.exec(tag);
	if (!match) return null;
	return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** Does the tag carry `token` as a whitespace-separated class? */
export function hasClass(tag: string, token: string): boolean {
	const value = attributeOf(tag, "class");
	if (!value) return false;
	return value.split(/\s+/).includes(token);
}

export interface ScannedElement {
	/** Raw opening tag, so callers can read its attributes. */
	tag: string;
	/** Raw inner markup. */
	inner: string;
}

/**
 * Return every `<name …>…</name>` element in document order.
 *
 * The scan always moves forward, so malformed markup or unclosed tags cannot loop
 * forever; nesting of the same tag name is handled by depth counting.
 */
export function findElements(html: string, name: string): ScannedElement[] {
	const elements: ScannedElement[] = [];
	let cursor = 0;

	while (cursor < html.length) {
		const openIndex = findOpenTagStart(html, name, cursor);
		if (openIndex === -1) break;
		const tagEnd = findTagEnd(html, openIndex);
		if (tagEnd === -1) break;

		const tag = html.slice(openIndex, tagEnd + 1);
		const innerStart = tagEnd + 1;
		if (/\/\s*>$/.test(tag)) {
			elements.push({ inner: "", tag });
			cursor = innerStart;
			continue;
		}

		let depth = 1;
		let scan = innerStart;
		let closeIndex = -1;
		let afterClose = -1;

		while (scan < html.length) {
			const nextOpen = findOpenTagStart(html, name, scan);
			const nextClose = findCloseTagStart(html, name, scan);
			if (nextClose === -1) break;

			if (nextOpen !== -1 && nextOpen < nextClose) {
				const nestedEnd = findTagEnd(html, nextOpen);
				depth += 1;
				scan = (nestedEnd === -1 ? nextOpen + 1 : nestedEnd + 1);
				continue;
			}

			depth -= 1;
			if (depth === 0) {
				closeIndex = nextClose;
				afterClose = html.indexOf(">", nextClose) + 1;
				break;
			}
			scan = nextClose + 1;
		}

		if (closeIndex === -1) {
			cursor = innerStart;
			continue;
		}

		elements.push({ inner: html.slice(innerStart, closeIndex), tag });
		cursor = afterClose > 0 ? afterClose : innerStart;
	}

	return elements;
}

function findOpenTagStart(html: string, name: string, from: number): number {
	const pattern = new RegExp(`<${name}(?=[\\s/>])`, "i");
	const match = pattern.exec(html.slice(from));
	return match ? from + match.index : -1;
}

function findCloseTagStart(html: string, name: string, from: number): number {
	const pattern = new RegExp(`</${name}\\s*>`, "i");
	const match = pattern.exec(html.slice(from));
	return match ? from + match.index : -1;
}

/**
 * Index of the `>` ending the tag that starts at `start`, skipping `>` inside quotes.
 * Returns -1 when the tag is never closed.
 */
export function findTagEnd(html: string, start: number): number {
	let quote: string | null = null;
	for (let index = start; index < html.length; index += 1) {
		const char = html[index];
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ">") return index;
	}
	return -1;
}