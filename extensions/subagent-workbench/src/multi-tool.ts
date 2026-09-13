import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CHILD_MULTI_TOOL_NAME = "multi_tool_use_parallel";
const MAX_PARALLEL_CALLS = 8;
const MAX_TEXT_BYTES = 512 * 1024;

const MultiToolParams = Type.Object(
  {
    tool_uses: Type.Array(
      Type.Object(
        {
          recipient_name: Type.String({
            description:
              "Exact active Pi tool name. A compatibility prefix such as functions.read is also accepted.",
          }),
          parameters: Type.Record(Type.String(), Type.Unknown()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_PARALLEL_CALLS },
    ),
  },
  { additionalProperties: false },
);

type NestedExecutionResult = {
  readonly result: AgentToolResult<unknown>;
  readonly isError: boolean;
};

type MultiToolHostAPI = ExtensionAPI & {
  executeTool(
    toolName: string,
    args: unknown,
    options?: {
      readonly toolCallId?: string;
      readonly signal?: AbortSignal;
      readonly onUpdate?: AgentToolUpdateCallback<unknown>;
    },
  ): Promise<NestedExecutionResult>;
};

type ToolMetadata = ReturnType<ExtensionAPI["getAllTools"]>[number] & {
  readonly executionMode?: "parallel" | "sequential";
};

interface CallResult {
  readonly index: number;
  readonly recipientName: string;
  readonly toolName: string;
  readonly result: AgentToolResult<unknown>;
  readonly isError: boolean;
}

function resolveToolName(
  recipientName: string,
  activeTools: ReadonlySet<string>,
): string | undefined {
  if (activeTools.has(recipientName)) return recipientName;
  const compatibilityName = recipientName.startsWith("functions.")
    ? recipientName.slice("functions.".length)
    : undefined;
  return compatibilityName && activeTools.has(compatibilityName)
    ? compatibilityName
    : undefined;
}

function boundedText(text: string, remainingBytes: number): string {
  if (remainingBytes <= 0) return "";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= remainingBytes) return text;
  const suffix = "\n[... multi-tool output truncated ...]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (remainingBytes <= suffixBytes) return suffix.slice(0, remainingBytes);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      Buffer.byteLength(text.slice(0, middle), "utf8") <=
      remainingBytes - suffixBytes
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${text.slice(0, low)}${suffix}`;
}

function resultContent(
  results: readonly CallResult[],
): AgentToolResult<unknown>["content"] {
  const content: AgentToolResult<unknown>["content"] = [];
  let remainingBytes = MAX_TEXT_BYTES;
  for (const item of results) {
    const heading = `[${item.index}] ${item.recipientName} (${item.toolName}) · ${item.isError ? "error" : "ok"}\n`;
    const boundedHeading = boundedText(heading, remainingBytes);
    if (!boundedHeading) break;
    content.push({ type: "text", text: boundedHeading });
    remainingBytes -= Buffer.byteLength(boundedHeading, "utf8");

    for (const block of item.result.content ?? []) {
      if (block.type === "text") {
        const text = boundedText(`${block.text}\n`, remainingBytes);
        if (!text) break;
        content.push({ type: "text", text });
        remainingBytes -= Buffer.byteLength(text, "utf8");
      } else if (block.type === "image") {
        content.push(block);
      }
    }
    if (remainingBytes <= 0) break;
  }
  return content;
}

export function registerChildMultiTool(pi: ExtensionAPI): void {
  const host = pi as MultiToolHostAPI;
  pi.registerTool({
    name: CHILD_MULTI_TOOL_NAME,
    label: "multi_tool_use.parallel",
    description:
      "Execute up to eight independent active Pi tool calls concurrently and return results in input order. Calls still pass through Pi validation, security hooks, lifecycle events, and abort handling. Use multi_tool_use_parallel when two or more tool calls are independent; keep dependent calls sequential. Pass the exact active Pi tool name in recipient_name (for example read or bash); functions.read is accepted for compatibility. Do not parallelize writes to the same path, dependent edits, authorization decisions, or irreversible operations.",
    promptSnippet:
      "multi_tool_use_parallel: run independent active tool calls concurrently",
    // Serialize outer aggregators so sequential nested tools cannot overlap across batches.
    // Independent calls inside one allowed batch still run concurrently below.
    executionMode: "sequential",
    parameters: MultiToolParams,
    async execute(toolCallId, params, signal, onUpdate) {
      if (typeof host.executeTool !== "function") {
        throw new Error(
          "multi_tool_use_parallel requires a Pi host with pi.executeTool() support.",
        );
      }
      const activeTools = new Set(pi.getActiveTools());
      const metadata = new Map(
        (pi.getAllTools() as ToolMetadata[]).map((tool) => [tool.name, tool]),
      );
      const calls = params.tool_uses.map((call, index) => {
        const toolName = resolveToolName(call.recipient_name, activeTools);
        if (!toolName) {
          throw new Error(`Tool ${call.recipient_name} is not active.`);
        }
        if (toolName === CHILD_MULTI_TOOL_NAME) {
          throw new Error(
            "Recursive multi_tool_use_parallel calls are not allowed.",
          );
        }
        return {
          index,
          recipientName: call.recipient_name,
          toolName,
          parameters: call.parameters,
        };
      });
      const statuses = calls.map(() => "queued");
      const update = (): void => {
        const completed = statuses.filter(
          (status) => status !== "queued" && status !== "running",
        ).length;
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `multi_tool_use.parallel ${completed}/${calls.length} complete · ${statuses.join(", ")}`,
            },
          ],
          details: { statuses: [...statuses] },
        });
      };
      const executeOne = async (
        call: (typeof calls)[number],
      ): Promise<CallResult> => {
        statuses[call.index] = "running";
        update();
        try {
          const nested = await host.executeTool(
            call.toolName,
            call.parameters,
            {
              toolCallId: `${toolCallId}:${call.index}`,
              signal,
              onUpdate: () => update(),
            },
          );
          statuses[call.index] = nested.isError ? "error" : "completed";
          update();
          return { ...call, result: nested.result, isError: nested.isError };
        } catch (error) {
          statuses[call.index] = "error";
          update();
          return {
            ...call,
            result: {
              content: [
                {
                  type: "text",
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
              details: {},
            },
            isError: true,
          };
        }
      };

      update();
      const hasSequentialTool = calls.some(
        (call) => metadata.get(call.toolName)?.executionMode === "sequential",
      );
      const results: CallResult[] = [];
      if (hasSequentialTool) {
        for (const call of calls) results.push(await executeOne(call));
      } else {
        results.push(...(await Promise.all(calls.map(executeOne))));
      }
      results.sort((left, right) => left.index - right.index);
      const terminate =
        results.length > 0 &&
        results.every((item) => item.result.terminate === true);
      return {
        content: resultContent(results),
        ...(terminate ? { terminate: true } : {}),
        details: {
          parallel: !hasSequentialTool,
          calls: results.map((item) => ({
            index: item.index,
            recipientName: item.recipientName,
            toolName: item.toolName,
            isError: item.isError,
          })),
        },
      };
    },
  });
}
