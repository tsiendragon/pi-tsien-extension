/**
 * Shared contract for tool-result pipeline stages.
 *
 * A stage is pure text-in / text-out: it receives the event with the content
 * produced by the previous stage and either returns new content or `undefined`
 * ("nothing to say"). Stages must be fail-open; the pipeline also wraps each
 * call, so a throwing stage degrades to "output unchanged" instead of losing
 * tool output.
 */
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export interface ToolResultStage {
	readonly name: string;
	readonly apply: (
		event: ToolResultEvent,
		ctx: ExtensionContext,
	) => Promise<
		| {
				readonly content: readonly { readonly type: "text"; readonly text: string }[];
				readonly details?: unknown;
				readonly usage?: unknown;
		  }
		| undefined
	>;
}

export interface TextPart {
	type: "text";
	text: string;
}

export function textFromContent(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((part): part is TextPart => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function isPureText(content: readonly { type: string }[]): boolean {
	return content.length > 0 && content.every((part) => part.type === "text");
}
