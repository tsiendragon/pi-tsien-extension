import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ArxivClient, formatArxivResults, type ArxivSort } from "./academic/arxiv.ts";
import { formatOpenReviewResults, OpenReviewClient } from "./academic/openreview.ts";
import { fetchPage } from "./fetch/extract.ts";
import { resolveSearchProvider, type SearchProvider } from "./search/provider.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const STATUS_KEY = "web-tools";

/**
 * WebSearch (web search) and WebFetch (page → markdown) for pi, plus arxiv_search /
 * openreview_search for structured academic metadata.
 *
 * Search works without credentials: the DuckDuckGo lite provider is the fallback, and
 * `PI_WEB_SEARCH_PROVIDER` / provider API keys select something better when available.
 */
export default function webTools(pi: ExtensionAPI): void {
	let cached: SearchProvider | null = null;

	function searchProvider(): SearchProvider {
		cached ??= resolveSearchProvider();
		return cached;
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, `WebSearch: ${searchProvider().name}`);
		} catch {
			ctx.ui.setStatus(STATUS_KEY, "WebSearch: no provider");
		}
	});

	pi.registerTool({
		name: "WebSearch",
		label: "Web Search",
		description:
			"Search the web and return a list of results with titles, URLs, and snippets. " +
			"Use this to find documentation, look up facts, or discover relevant web pages.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Number({ description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` })),
		}),

		async execute(_toolCallId, params) {
			try {
				const provider = searchProvider();
				const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
				const results = await provider.search(params.query, limit);

				if (results.length === 0) {
					return {
						content: [{ type: "text" as const, text: `No results found for: "${params.query}"` }],
						details: { count: 0, provider: provider.name, query: params.query },
					};
				}

				const text = results
					.map((result, index) => `${index + 1}. **${result.title}**\n   ${result.url}\n   ${result.snippet}`)
					.join("\n\n");

				return {
					content: [
						{
							type: "text" as const,
							text: `Search results for "${params.query}" (via ${provider.name}):\n\n${text}`,
						},
					],
					details: { count: results.length, provider: provider.name, query: params.query },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `Search error: ${messageOf(error)}` }],
					details: { count: 0, provider: "", query: params.query },
					isError: true,				};
			}
		},
	});

	pi.registerTool({
		name: "WebFetch",
		label: "Web Fetch",
		description:
			"Fetch a web page and extract its readable content as markdown. " +
			"Use this to read documentation pages, articles, or any web content. " +
			"Optionally provide a prompt hint describing what information to focus on.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			prompt: Type.Optional(
				Type.String({ description: "Hint for what content to focus on (included as context, not used for filtering)" }),
			),
		}),

		async execute(_toolCallId, params) {
			try {
				const page = await fetchPage(params.url);

				let text = page.title ? `# ${page.title}\n\n` : "";
				text += `URL: ${page.url}\n\n`;
				if (params.prompt) text += `(Requested focus: ${params.prompt})\n\n`;
				text += page.content;

				const clipped = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
				let output = clipped.content;
				if (clipped.truncated) {
					output += `\n\n[Content truncated: ${clipped.outputLines} of ${clipped.totalLines} lines`;
					output += ` (${formatSize(clipped.outputBytes)} of ${formatSize(clipped.totalBytes)}).`;
					output += " Use WebSearch to find more specific pages.]";
				}

				return {
					content: [{ type: "text" as const, text: output }],
					details: { title: page.title, truncated: clipped.truncated, url: page.url },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `Fetch error for ${params.url}: ${messageOf(error)}` }],
					details: { title: null, truncated: false, url: params.url },
					isError: true,
				};
			}
		},
	});

	const arxiv = new ArxivClient();
	const openreview = new OpenReviewClient();

	pi.registerTool({
		name: "arxiv_search",
		label: "arXiv Search",
		description:
			"Search arXiv through its official API and return structured metadata: title, arXiv id, submission date, " +
			"authors, categories and abstract. Prefer this over WebSearch when you need arXiv papers. " +
			"Accepts the API's field prefixes (ti:, au:, abs:, cat:, all:\"exact phrase\") or a bare arXiv id (e.g. 2603.01433).",
		parameters: Type.Object({
			query: Type.String({ description: "arXiv query, e.g. all:\"document forgery\" or au:Smith; a bare arXiv id also works" }),
			limit: Type.Optional(Type.Number({ description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` })),
			sort: Type.Optional(Type.String({ description: "'newest' (submitted date, descending) or 'relevance' (default)" })),
			category: Type.Optional(Type.String({ description: "Optional arXiv category filter, e.g. cs.CV" })),
		}),

		async execute(_toolCallId, params) {
			try {
				const limit = clampLimit(params.limit);
				const sort: ArxivSort = params.sort === "newest" ? "newest" : "relevance";
				const papers = await arxiv.search(params.query, limit, sort, params.category);
				if (papers.length === 0) {
					return {
						content: [{ type: "text" as const, text: `No arXiv papers found for: "${params.query}"` }],
						details: { count: 0, query: params.query },
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `arXiv results for "${params.query}":\n\n${formatArxivResults(papers, params.query)}`,
						},
					],
					details: { count: papers.length, query: params.query },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `arXiv search error: ${messageOf(error)}` }],
					details: { count: 0, query: params.query },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "openreview_search",
		label: "OpenReview Search",
		description:
			"Search OpenReview (conference submissions and DBLP records, e.g. ICLR/NeurIPS/ICML) and return title, venue, " +
			"authors, date, abstract and forum link. Use it next to arxiv_search when you need peer-reviewed venue papers; " +
			"reviews, comments and edits are filtered out.",
		parameters: Type.Object({
			query: Type.String({ description: "Search terms, e.g. 'document forgery detection'" }),
			limit: Type.Optional(Type.Number({ description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` })),
		}),

		async execute(_toolCallId, params) {
			try {
				const limit = clampLimit(params.limit);
				const papers = await openreview.search(params.query, limit);
				if (papers.length === 0) {
					return {
						content: [{ type: "text" as const, text: `No OpenReview papers found for: "${params.query}"` }],
						details: { count: 0, query: params.query },
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `OpenReview results for "${params.query}":\n\n${formatOpenReviewResults(papers, params.query)}`,
						},
					],
					details: { count: papers.length, query: params.query },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `OpenReview search error: ${messageOf(error)}` }],
					details: { count: 0, query: params.query },
					isError: true,
				};
			}
		},
	});
}

function clampLimit(value: unknown): number {
	const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_LIMIT;
	return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}