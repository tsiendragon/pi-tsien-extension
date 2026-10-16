/** Shared helpers for the academic-source tools (arXiv / OpenReview). */

export const ACADEMIC_USER_AGENT =
	"pi-tsien-web-tools/0.1 (+https://github.com/tsiendragon/pi-tsien-extension)";

export const ABSTRACT_CLIP = 320;

/** Collapse whitespace runs (arXiv Atom payloads wrap everything at 80 columns). */
export function collapse(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function clip(value: string, max = ABSTRACT_CLIP): string {
	const text = collapse(value);
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function joinAuthors(authors: readonly string[], max = 4): string {
	if (authors.length === 0) return "";
	if (authors.length <= max) return authors.join(", ");
	return `${authors.slice(0, max).join(", ")} et al. (${authors.length} authors)`;
}

/** ISO-ish timestamp (`2026-09-27T15:45:14Z`, epoch ms, or epoch s) → `YYYY-MM-DD`. */
export function isoDate(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value > 1e12 ? value : value * 1000;
		return new Date(ms).toISOString().slice(0, 10);
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
	}
	return "";
}
