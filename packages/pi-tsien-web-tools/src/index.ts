import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchPage } from "./fetch/extract.ts";
import { resolveSearchProvider, type SearchProvider } from "./search/provider.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const STATUS_KEY = "web-tools";

/**
 * WebSearch (web search) and WebFetch (page → markdown) for pi.
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
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}