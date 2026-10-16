import { asArray, asRecord, pickString } from "../search/providers/shared.ts";
import { ACADEMIC_USER_AGENT, clip, collapse, isoDate, joinAuthors } from "./format.ts";

/**
 * OpenReview (conference submissions / DBLP records) through the public API v2.
 *
 * Two quirks worth knowing, both encoded here:
 *  - `GET /notes/search` returns everything matching the term, including **reviews and
 *    comments**; only notes whose content carries a `title` are papers.
 *  - the bare `GET /notes?limit=` listing answers 403 ChallengeRequired (bot challenge);
 *    `/notes/search` works and is what this client uses.
 */

export interface OpenReviewPaper {
	id: string;
	forum: string;
	url: string;
	pdfUrl: string;
	title: string;
	authors: string[];
	venue: string;
	invitation: string;
	date: string;
	abstract: string;
}

const ENDPOINT = "https://api2.openreview.net/notes/search";

export function buildOpenReviewSearchUrl(term: string, limit: number, offset = 0): string {
	return `${ENDPOINT}?${new URLSearchParams({ limit: String(limit), offset: String(offset), term: term.trim() })}`;
}

/** OpenReview content fields are `{ value: X }` envelopes (or plain values in older data). */
function contentValue(content: Record<string, unknown>, key: string): unknown {
	const entry = content[key];
	const record = asRecord(entry);
	return record && "value" in record ? record.value : entry;
}

function textValue(content: Record<string, unknown>, key: string): string {
	const value = contentValue(content, key);
	return typeof value === "string" ? collapse(value) : "";
}

/** Keep only paper-like notes (has a title), de-duplicate by forum, cap at `limit`. */
export function parseOpenReviewSearch(payload: unknown, limit: number): OpenReviewPaper[] {
	if (limit <= 0) return [];
	const notes = asArray(asRecord(payload)?.notes);
	const seen = new Set<string>();
	const papers: OpenReviewPaper[] = [];
	for (const item of notes) {
		const note = asRecord(item);
		if (!note) continue;
		const content = asRecord(note.content) ?? {};
		const title = textValue(content, "title");
		if (!title) continue;
		const forum = pickString(note, ["forum"]) || pickString(note, ["id"]);
		if (!forum || seen.has(forum)) continue;
		seen.add(forum);
		const authors = contentValue(content, "authors");
		papers.push({
			abstract: textValue(content, "abstract"),
			authors: Array.isArray(authors) ? authors.filter((author): author is string => typeof author === "string") : [],
			date: isoDate(note.cdate ?? note.pdate ?? note.tcdate),
			forum,
			id: pickString(note, ["id"]),
			invitation: asArray(note.invitations).map(String)[0] ?? "",
			pdfUrl: textValue(content, "pdf") || `https://openreview.net/pdf?id=${forum}`,
			title,
			url: `https://openreview.net/forum?id=${forum}`,
			venue: textValue(content, "venue") || textValue(content, "venueid"),
		});
		if (papers.length >= limit) break;
	}
	return papers;
}

export function formatOpenReviewResults(papers: readonly OpenReviewPaper[], term: string): string {
	if (papers.length === 0) {
		return `No OpenReview papers found for: "${term}" (submissions and DBLP records only; reviews/comments are filtered out)`;
	}
	return papers
		.map((paper, index) => {
			const meta = [paper.venue, paper.date].filter(Boolean).join(" · ");
			const lines = [`${index + 1}. **${paper.title}**`];
			if (meta) lines.push(`   ${meta}`);
			const authors = joinAuthors(paper.authors);
			if (authors) lines.push(`   Authors: ${authors}`);
			lines.push(`   ${paper.url}`);
			if (paper.abstract) lines.push(`   Abstract: ${clip(paper.abstract)}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

export class OpenReviewClient {
	constructor(private readonly fetchImpl: typeof fetch = fetch) {}

	async search(term: string, limit: number): Promise<OpenReviewPaper[]> {
		// Search floods results with reviews, so ask for more than we need before filtering.
		const fetchLimit = Math.min(Math.max(limit * 4, 20), 40);
		const response = await this.fetchImpl(buildOpenReviewSearchUrl(term, fetchLimit), {
			headers: { Accept: "application/json", "User-Agent": ACADEMIC_USER_AGENT },
		});
		if (!response.ok) {
			throw new Error(`OpenReview search failed: ${response.status} ${response.statusText}`);
		}
		return parseOpenReviewSearch(await response.json(), limit);
	}
}
