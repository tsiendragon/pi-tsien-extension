/**
 * ObservationPack — keep large tool results reachable without replaying them.
 *
 * A large tool result is sent in full for its first few provider requests, then
 * replaced with a short, stable placeholder for every later request. The archived
 * bytes stay outside the provider context, and the agent pulls exact pages back
 * with the registered `obs_recall` tool.
 *
 * The mechanism never edits stored history in place: it rewrites only at the
 * projection layer (`pi.on("context")`), so resume keeps working.
 *
 * Opt-in and disabled by default. `obs_recall` is only registered when enabled, so
 * a disabled extension adds no tool schema to the prompt. Design:
 * docs/efficiency-mechanisms-design.md
 */

import { join } from "node:path";
import { Type } from "typebox";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	appendLedger,
	createObservation,
	DEFAULT_OBSERVATION_PACK_CONFIG,
	ensureStored,
	isObservationId,
	isPureTextResult,
	loadObservationPackConfig,
	moveToTrash,
	placeholderFor,
	readRecallChunk,
	recallChunkLimits,
	resolveSessionRoot,
	selectPruneCandidates,
	type ObservationPackConfig,
} from "./observation-pack/core.ts";

type ContextMessage = ContextEvent["messages"][number];
type ProjectedContext = { messages?: ContextEvent["messages"] };

const TOOL_NAME = "obs_recall";

interface SessionState {
	root: string;
	sentCounts: Map<string, number>;
	cache: Map<string, ReturnType<typeof createObservation>>;
}

export default function observationPack(pi: ExtensionAPI): void {
	let config: ObservationPackConfig = DEFAULT_OBSERVATION_PACK_CONFIG;
	const states = new Map<string, SessionState>();

	const loadConfig = (): void => {
		try {
			config = loadObservationPackConfig();
		} catch {
			config = DEFAULT_OBSERVATION_PACK_CONFIG;
		}
	};
	loadConfig();

	const stateFor = (ctx: ExtensionContext): SessionState | undefined => {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!sessionId) return undefined;
		const root = resolveSessionRoot(config.archiveDir, sessionId);
		if (!root) return undefined;
		let state = states.get(root);
		if (!state) {
			state = { root, sentCounts: new Map(), cache: new Map() };
			states.set(root, state);
		}
		return state;
	};

	const registerRecallTool = (): void => {
		pi.registerTool({
			name: TOOL_NAME,
			label: "Recall Observation",
			description:
				"Read a stored large tool result by observation id and byte offset. Use it when a placeholder asks you to retrieve an earlier observation.",
			promptSnippet: "Recall a paged excerpt from a previously replaced large tool result",
			parameters: Type.Object({
				id: Type.String({ description: "Observation id from a placeholder" }),
				offset: Type.Optional(
					Type.Integer({ minimum: 0, description: "Byte offset, default 0" }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!isObservationId(params.id)) throw new Error(`Unknown observation id: ${params.id}`);
				const state = stateFor(ctx);
				if (!state) throw new Error(`Unknown observation id: ${params.id}`);

				const offset = params.offset ?? 0;
				const limits = recallChunkLimits(config.recallMaxBytes, config.recallMaxLines);
				let chunk;
				try {
					chunk = await readRecallChunk(
						join(state.root, "objects", `${params.id}.txt`),
						offset,
						limits,
					);
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") {
						throw new Error(`Unknown observation id: ${params.id}`);
					}
					throw error;
				}

				const header = [
					`[obs_recall id=${params.id} offset=${chunk.actualOffset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
					`[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
				].join("\n");
				const text = `${header}\n${chunk.text}`;
				if (
					Buffer.byteLength(text, "utf8") > config.recallMaxBytes ||
					text.split("\n").length > config.recallMaxLines
				) {
					throw new Error("Recall output exceeded its hard limit");
				}

				await appendLedger(join(state.root, "ledger.jsonl"), {
					event: "recall",
					id: params.id,
					offset: chunk.actualOffset,
					bytes: chunk.bytes,
					lines: chunk.lines,
					nextOffset: chunk.nextOffset,
					eof: chunk.eof,
				});

				return {
					content: [{ type: "text" as const, text }],
					details: {
						id: params.id,
						offset: chunk.actualOffset,
						bytes: chunk.bytes,
						lines: chunk.lines,
						nextOffset: chunk.nextOffset,
						eof: chunk.eof,
					},
				};
			},
		});
	};

	const registerPruneCommand = (): void => {
		pi.registerCommand("obs-prune", {
			description:
				"列出或清理过期的 ObservationPack 归档（默认 dry-run，加 --yes 才移入 .trash）",
			handler: async (args, ctx) => {
				loadConfig();
				const parsed = parsePruneArgs(args);
				const candidates = await selectPruneCandidates(config.archiveDir, {
					excludeSessionId: ctx.sessionManager?.getSessionId?.(),
					retentionDays: parsed.days ?? config.retentionDays,
				});
				if (candidates.length === 0) {
					ctx.ui.notify(
						`没有超过 ${parsed.days ?? config.retentionDays} 天的归档（根目录 ${config.archiveDir}）。`,
						"info",
					);
					return;
				}
				if (!parsed.yes) {
					const lines = candidates.map((candidate) => `  ${candidate.sessionId}`).join("\n");
					ctx.ui.notify(
						`dry-run：${candidates.length} 个会话将被清理，加 --yes 执行。\n${lines}`,
						"warning",
					);
					return;
				}
				let moved = 0;
				for (const candidate of candidates) {
					try {
						await moveToTrash(config.archiveDir, candidate);
						moved += 1;
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						console.error(
							`[observation-pack] prune failed for ${candidate.sessionId}: ${reason}`,
						);
					}
				}
				ctx.ui.notify(`已把 ${moved}/${candidates.length} 个会话移入 .trash。`, "info");
			},
		});
	};

	pi.on("session_start", () => {
		states.clear();
		loadConfig();
	});

	pi.on("context", async (event, ctx): Promise<ProjectedContext | void> => {
		if (!config.enabled) return;
		const state = stateFor(ctx);
		if (!state) return; // fail-open: no persistent session id or unsafe path

		const messages = event.messages;
		const projected = [...messages];

		// How many provider requests each message has already been part of, counted
		// by the assistant messages that follow it.
		const priorAssistantCounts = new Array<number>(messages.length);
		let assistantCount = 0;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			priorAssistantCounts[index] = assistantCount;
			if (messages[index]?.role === "assistant") assistantCount += 1;
		}

		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index];
			if (!message || !isPureTextResult(message)) continue;
			try {
				let observation: ReturnType<typeof createObservation>;
				if (state.cache.has(message.toolCallId)) {
					observation = state.cache.get(message.toolCallId);
				} else {
					observation = createObservation(message, {
						thresholdBytes: config.thresholdBytes,
						sessionRoot: state.root,
					});
					if (observation) await ensureStored(observation);
					state.cache.set(message.toolCallId, observation);
				}
				if (!observation) continue;

				const previousSends =
					state.sentCounts.get(observation.id) ?? priorAssistantCounts[index] ?? 0;
				if (previousSends < config.fullSends) {
					state.sentCounts.set(observation.id, previousSends + 1);
					await appendLedger(join(state.root, "ledger.jsonl"), {
						event: "full",
						id: observation.id,
						tool: observation.toolName,
						archivedBytes: observation.bytes,
						archivedLines: observation.lines,
						contentHash: observation.contentHash,
					});
					continue;
				}

				const placeholder = placeholderFor(
					observation,
					config.placeholderExcerptBytes,
					config.fullSends,
				);
				projected[index] = {
					...(message as object),
					content: [{ type: "text", text: placeholder }],
				} as ContextMessage;
				state.sentCounts.set(observation.id, previousSends + 1);
				await appendLedger(join(state.root, "ledger.jsonl"), {
					event: "placeholder",
					id: observation.id,
					tool: observation.toolName,
					archivedBytes: observation.bytes,
					sendNumber: previousSends + 1,
					placeholderBytes: Buffer.byteLength(placeholder, "utf8"),
					removedTokens: Math.max(
						0,
						observation.tokens - Math.ceil(placeholder.length / 4),
					),
				});
			} catch (error) {
				// Fail open: a packing failure must never cost the agent its observation.
				state.cache.delete(message.toolCallId);
				const reason = error instanceof Error ? error.message : String(error);
				console.error(`[observation-pack] fail-open for tool result: ${reason}`);
			}
		}

		return { messages: projected };
	});

	if (config.enabled) registerRecallTool();
	registerPruneCommand();
}

function parsePruneArgs(args: string): { days?: number; yes: boolean } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let days: number | undefined;
	let yes = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--days" || token === "-d") {
			const value = Number(tokens[index + 1]);
			if (Number.isFinite(value) && value > 0) days = Math.floor(value);
			index += 1;
		} else if (token.startsWith("--days=")) {
			const value = Number(token.slice("--days=".length));
			if (Number.isFinite(value) && value > 0) days = Math.floor(value);
		} else if (token === "--yes" || token === "-y") {
			yes = true;
		}
	}
	return { days, yes };
}

export { parsePruneArgs };