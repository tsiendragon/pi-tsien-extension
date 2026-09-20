// Re-export all techniques
export { stripAnsi, stripAnsiFast } from "./ansi.ts";
export { truncate, truncateLines } from "./truncate.ts";
export { filterBuildOutput, isBuildCommand } from "./build.ts";
export { aggregateTestOutput, isTestCommand } from "./test-output.ts";
export { aggregateLinterOutput, isLinterCommand } from "./linter.ts";
export {
	detectLanguage,
	filterMinimal,
	filterAggressive,
	smartTruncate,
	filterSourceCode,
	type Language,
} from "./source.ts";
export { compactDiff, compactStatus, compactLog, compactGitOutput, isGitCommand } from "./git.ts";
export { groupSearchResults, isSearchCommand } from "./search.ts";
