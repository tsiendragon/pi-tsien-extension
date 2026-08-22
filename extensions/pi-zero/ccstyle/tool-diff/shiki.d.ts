/**
 * Ambient type for the optional `@shikijs/cli` runtime dependency used by
 * shiki-highlight.ts. The module is imported dynamically and its absence is
 * handled gracefully (highlighting falls back to plain ANSI rendering), so it
 * is intentionally not a hard dependency of this package.
 */
declare module "@shikijs/cli" {
	export function codeToANSI(
		code: string,
		lang: unknown,
		theme: unknown,
	): Promise<string>;
}
