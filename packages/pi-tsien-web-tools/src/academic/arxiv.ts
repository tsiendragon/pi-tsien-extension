import { decodeEntities } from "../html/markup.ts";
import { ACADEMIC_USER_AGENT, clip, collapse, isoDate, joinAuthors } from "./format.ts";

/**
 * arXiv search through the official API (`export.arxiv.org/api/query`).
 *
 * Why not WebSearch: the API returns structured, citable metadata (arXiv id, version,
 * submission date, authors, categories, abstract) instead of a scraped snippet list.
 * Free, no credentials; arXiv asks for ≤1 request per 3 seconds, so keep calls coarse.
 */

export type ArxivSort = "relevance" | "newest";

export interface ArxivPaper {
	id: string;
	title: string;
	url: string;
	pdfUrl: string;
	published: string;
	updated: string;
	authors: string[];
	categories: string[];
	summary: string;
}

export interface ArxivQueryOptions {
	query: string;
	limit: number;
	sort?: ArxivSort;
	category?: string;
}

const API_ENDPOINT = "https://export.arxiv.org/api/query";
/** New-style ids (`2603.01433v1`) and old-style ones (`cs.CV/0701001`). */
const ARXIV_ID = /^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)$/i;

export function looksLikeArxivId(value: string): boolean {
	return ARXIV_ID.test(value.trim());
}

/**
 * Build the API URL. Field prefixes (`ti:`, `au:`, `abs:`, `cat:`, `all:"..."`) pass through
 * untouched — the API's own query syntax is the interface. A bare arXiv id becomes `id_list`.
 */
export function buildArxivUrl(options: ArxivQueryOptions): string {
	const params = new URLSearchParams();
	const query = options.query.trim();
	const category = options.category?.trim();
	if (looksLikeArxivId(query)) {
		params.set("id_list", query.replace(/^arxiv:/i, ""));
	} else {
		params.set("search_query", category ? `(${query}) AND cat:${category}` : query);
	}
	params.set("start", "0");
	params.set("max_results", String(options.limit));
	params.set("sortBy", options.sort === "newest" ? "submittedDate" : "relevance");
	params.set("sortOrder", "descending");
	return `${API_ENDPOINT}?${params.toString()}`;
}

function blocks(xml: string, tag: string): string[] {
	return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1]);
}

function innerText(block: string, tag: string): string {
	const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
	return match ? decodeEntities(match[1]) : "";
}

function hrefOf(tag: string): string {
	return /href="([^"]*)"/.exec(tag)?.[1] ?? "";
}

/** Parse an arXiv Atom feed into papers (pure — fixture-tested). */
export function parseArxivFeed(xml: string): ArxivPaper[] {
	const papers: ArxivPaper[] = [];
	for (const block of blocks(xml, "entry")) {
		const title = collapse(innerText(block, "title"));
		if (!title) continue;
		const id = collapse(innerText(block, "id")).replace(/^https?:\/\/arxiv\.org\/abs\//, "");
		const links = [...block.matchAll(/<link\b[^>]*>/g)].map((match) => match[0]);
		const hrefs = links.map(hrefOf);
		const url = hrefs.find((href) => href.includes("/abs/")) || (id ? `https://arxiv.org/abs/${id}` : "");
		const pdfUrl = hrefs.find((href) => href.includes("/pdf/")) || "";
		papers.push({
			authors: [...block.matchAll(/<author\b[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((match) => collapse(decodeEntities(match[1]))),
			categories: [...block.matchAll(/<category\b[^>]*term="([^"]*)"/g)].map((match) => match[1]),
			id,
			pdfUrl,
			published: isoDate(collapse(innerText(block, "published"))),
			summary: collapse(innerText(block, "summary")),
			title,
			updated: isoDate(collapse(innerText(block, "updated"))),
			url,
		});
	}
	return papers;
}

export function formatArxivResults(papers: readonly ArxivPaper[], query: string): string {
	if (papers.length === 0) return `No arXiv papers found for: "${query}"`;
	return papers
		.map((paper, index) => {
			const meta = [`arXiv:${paper.id}`, paper.published, paper.categories.slice(0, 3).join(", ")]
				.filter(Boolean)
				.join(" · ");
			const lines = [`${index + 1}. **${paper.title}**`, `   ${meta}`];
			const authors = joinAuthors(paper.authors);
			if (authors) lines.push(`   Authors: ${authors}`);
			lines.push(`   ${paper.url}`);
			if (paper.summary) lines.push(`   Abstract: ${clip(paper.summary)}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

export class ArxivClient {
	constructor(private readonly fetchImpl: typeof fetch = fetch) {}

	async search(query: string, limit: number, sort: ArxivSort = "relevance", category?: string): Promise<ArxivPaper[]> {
		const response = await this.fetchImpl(buildArxivUrl({ category, limit, query, sort }), {
			headers: { Accept: "application/atom+xml", "User-Agent": ACADEMIC_USER_AGENT },
		});
		if (!response.ok) {
			throw new Error(`arXiv request failed: ${response.status} ${response.statusText}`);
		}
		return parseArxivFeed(await response.text()).slice(0, limit);
	}
}
