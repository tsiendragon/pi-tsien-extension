import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveProvider } from "./providers/index.ts";
import { fetchAndExtract } from "./web-fetch.ts";

export default function (pi: ExtensionAPI) {
	let provider: ReturnType<typeof resolveProvider> | null = null;

	function getProvider() {
		if (!provider) {
			provider = resolveProvider();
		}
		return provider;
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			const p = getProvider();
			ctx.ui.setStatus("web-tools", `WebSearch: ${p.name}`);
		} catch (e: any) {
			ctx.ui.setStatus("web-tools", `WebSearch: no provider`);
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
			limit: Type.Optional(Type.Number({ description: "Max results to return (default 10, max 20)" })),
		}),

		async execute(_toolCallId, params, signal) {
			try {
				const p = getProvider();
				const limit = Math.min(Math.max(params.limit ?? 10, 1), 20);
				const results = await p.search(params.query, limit);

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: `No results found for: "${params.query}"` }],
						details: { provider: p.name, query: params.query, count: 0 },
					};
				}

				const text = results
					.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
					.join("\n\n");

				return {
					content: [{ type: "text", text: `Search results for "${params.query}" (via ${p.name}):\n\n${text}` }],
					details: { provider: p.name, query: params.query, count: results.length },
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Search error: ${e.message}` }],
					isError: true,
					details: {},
				};
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

		async execute(_toolCallId, params, signal) {
			try {
				const result = await fetchAndExtract(params.url);

				let text = "";
				if (result.title) text += `# ${result.title}\n\n`;
				text += `URL: ${result.url}\n\n`;
				if (params.prompt) text += `(Requested focus: ${params.prompt})\n\n`;
				text += result.content;

				// Truncate to pi limits
				const truncation = truncateHead(text, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

				let output = truncation.content;
				if (truncation.truncated) {
					output += `\n\n[Content truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
					output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
					output += ` Use WebSearch to find more specific pages.]`;
				}

				return {
					content: [{ type: "text", text: output }],
					details: { url: result.url, title: result.title, truncated: truncation.truncated },
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Fetch error for ${params.url}: ${e.message}` }],
					isError: true,
					details: {},
				};
			}
		},
	});
}
