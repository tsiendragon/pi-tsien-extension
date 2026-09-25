const FETCH_TIMEOUT = 15000;
const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5MB max HTML to parse

export async function fetchAndExtract(url: string): Promise<{ title: string | null; content: string; url: string }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

	let res: Response;
	try {
		res = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
			redirect: "follow",
		});
	} finally {
		clearTimeout(timeoutId);
	}

	if (!res.ok) {
		throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
	}

	const contentType = res.headers.get("content-type") ?? "";
	if (!contentType.includes("html") && !contentType.includes("xml") && !contentType.includes("text/plain")) {
		throw new Error(`Unsupported content type: ${contentType}. WebFetch works with HTML/text pages.`);
	}

	const html = await res.text();
	if (html.length > MAX_HTML_BYTES) {
		throw new Error(`Page too large (${(html.length / 1024 / 1024).toFixed(1)}MB). Max ${MAX_HTML_BYTES / 1024 / 1024}MB.`);
	}

	const finalUrl = res.url || url;

	// Heavy HTML-extraction deps (jsdom alone is ~500 files) are loaded lazily,
	// on the first actual WebFetch call. Importing them at module scope made
	// every Pi start pay for them: measured as a 1.1-1.8s module import in
	// `PI_TIMING=1`, i.e. ~2/3 of total extension-load time.
	const [jsdomModule, readabilityModule, turndownModule, gfmModule] = await Promise.all([
		import("jsdom"),
		import("@mozilla/readability"),
		import("turndown"),
		import("turndown-plugin-gfm"),
	]);
	const { JSDOM } = jsdomModule;
	const { Readability } = readabilityModule;
	const TurndownService = turndownModule.default;
	const { gfm } = gfmModule;

	const doc = new JSDOM(html, { url: finalUrl });
	const reader = new Readability(doc.window.document);
	const article = reader.parse();

	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
	turndown.use(gfm);
	turndown.addRule("removeEmptyLinks", {
		filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
		replacement: () => "",
	});

	function toMarkdown(htmlContent: string): string {
		return turndown
			.turndown(htmlContent)
			.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
			.replace(/ +/g, " ")
			.replace(/\s+,/g, ",")
			.replace(/\s+\./g, ".")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	let content: string;
	if (article?.content) {
		content = toMarkdown(article.content);
	} else {
		// Fallback: strip non-content elements and extract main area
		const fallbackDoc = new JSDOM(html, { url: finalUrl });
		const fallbackBody = fallbackDoc.window.document;
		fallbackBody
			.querySelectorAll("script, style, noscript, nav, header, footer, aside")
			.forEach((el) => el.remove());
		const main =
			fallbackBody.querySelector("main, article, [role='main'], .content, #content") || fallbackBody.body;
		const fallbackHtml = main?.innerHTML ?? "";
		content = fallbackHtml.trim().length > 100 ? toMarkdown(fallbackHtml) : "(Could not extract readable content)";
	}

	return {
		title: article?.title ?? null,
		content,
		url: finalUrl,
	};
}
