import { BROWSER_USER_AGENT } from "../search/providers/duckduckgo.ts";

/** Refuse absurd payloads before handing them to jsdom. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024;

const ACCEPTED_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];
const FALLBACK_STRIP_SELECTOR = "script, style, noscript, nav, header, footer, aside, form, iframe";
const FALLBACK_MAIN_SELECTOR = "main, article, [role='main'], .content, #content";
const MIN_FALLBACK_HTML = 100;

export interface ExtractedPage {
	title: string | null;
	url: string;
	content: string;
}

export interface FetchPageOptions {
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	maxBytes?: number;
}

/**
 * Download a page and turn it into readable markdown.
 *
 * The extraction stack (jsdom + Readability + turndown) is imported on first use only:
 * loading it at module scope made every pi start pay ~1s for code that a session may
 * never touch.
 */
export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<ExtractedPage> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxBytes = options.maxBytes ?? MAX_HTML_BYTES;

	const response = await fetchImpl(url, {
		headers: {
			Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
			"User-Agent": BROWSER_USER_AGENT,
		},
		signal: options.signal,
	});
	if (!response.ok) {
		throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (contentType && !ACCEPTED_TYPES.some((type) => contentType.toLowerCase().includes(type))) {
		throw new Error(`Unsupported content type: ${contentType}. WebFetch works with HTML/text pages.`);
	}

	const html = await response.text();
	if (html.length > maxBytes) {
		throw new Error(
			`Page too large (${(html.length / 1024 / 1024).toFixed(1)}MB). Max ${maxBytes / 1024 / 1024}MB.`,
		);
	}

	return extract(html, response.url || url);
}

/**
 * Convert HTML to readable markdown.
 *
 * Readability handles article-like pages; when it finds nothing usable we fall back to
 * stripping chrome and reading a main-content container.
 */
export async function extract(html: string, url: string): Promise<ExtractedPage> {
	const { JSDOM } = await import("jsdom");
	const { Readability } = await import("@mozilla/readability");
	const { default: TurndownService } = await import("turndown");
	const { gfm } = await import("turndown-plugin-gfm");

	const turn = new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx" });
	turn.use(gfm);
	turn.addRule("dropEmptyLinks", {
		filter: (node: HTMLElement) => node.nodeName === "A" && !node.textContent?.trim(),
		replacement: () => "",
	});

	const toMarkdown = (fragment: string): string =>
		turn
			.turndown(fragment)
			.replace(/\[\s*\]\([^)]*\)/g, "")
			.replace(/[ \t]{2,}/g, " ")
			.replace(/[ \t]+([,.])/g, "$1")
			.replace(/\n{3,}/g, "\n\n")
			.trim();

	const article = new Readability(new JSDOM(html, { url }).window.document).parse();
	if (article?.content) {
		return { content: toMarkdown(article.content), title: article.title ?? null, url };
	}

	const dom = new JSDOM(html, { url });
	dom.window.document.querySelectorAll(FALLBACK_STRIP_SELECTOR).forEach((node: Element) => node.remove());
	const main = dom.window.document.querySelector(FALLBACK_MAIN_SELECTOR);
	const fallbackHtml = (main ?? dom.window.document.body)?.innerHTML ?? "";
	return {
		content: fallbackHtml.trim().length > MIN_FALLBACK_HTML
			? toMarkdown(fallbackHtml)
			: "(Could not extract readable content)",
		title: article?.title ?? null,
		url,
	};
}