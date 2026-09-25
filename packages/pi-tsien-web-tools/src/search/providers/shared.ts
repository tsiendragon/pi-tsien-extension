import type { SearchResult } from "../types.ts";

/** Shared plumbing for the JSON-API providers. */
export async function requestSearchJson(
	fetchImpl: typeof fetch,
	label: string,
	url: string,
	init: RequestInit,
): Promise<Record<string, unknown>> {
	const response = await fetchImpl(url, init);
	if (!response.ok) {
		throw new Error(`${label} search failed: ${response.status} ${response.statusText}`);
	}
	return (await response.json()) as Record<string, unknown>;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function pickString(record: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

export function toResult(record: Record<string, unknown>, titleKeys: string[], urlKeys: string[], snippetKeys: string[]): SearchResult | null {
	const url = pickString(record, urlKeys);
	if (!url) return null;
	return {
		snippet: pickString(record, snippetKeys),
		title: pickString(record, titleKeys) || url,
		url,
	};
}