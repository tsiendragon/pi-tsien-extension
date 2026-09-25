import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  CHILD_MULTI_TOOL_NAME,
  registerChildMultiTool,
} from "pi-tsien-subagent-workbench/src/multi-tool.ts";

function setup(
  options: { sequential?: boolean; terminateTools?: string[] } = {},
) {
  let definition: any;
  let active = 0;
  let maxActive = 0;
  const executeTool = vi.fn(async (toolName: string, args: unknown) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const delay = toolName === "read" ? 20 : 5;
    await new Promise((resolve) => setTimeout(resolve, delay));
    active--;
    return {
      result: {
        content: [
          {
            type: "text" as const,
            text: `${toolName}:${JSON.stringify(args)}`,
          },
        ],
        details: {},
        ...(options.terminateTools?.includes(toolName)
          ? { terminate: true }
          : {}),
      },
      isError: false,
    };
  });
  const pi = {
    registerTool: vi.fn((tool: any) => {
      definition = tool;
    }),
    getActiveTools: () => [CHILD_MULTI_TOOL_NAME, "read", "bash"],
    getAllTools: () => [
      {
        name: "read",
        executionMode: options.sequential ? "sequential" : "parallel",
      },
      { name: "bash", executionMode: "parallel" },
    ],
    executeTool,
  } as unknown as ExtensionAPI;
  registerChildMultiTool(pi);
  return {
    get definition() {
      return definition;
    },
    executeTool,
    maxActive: () => maxActive,
  };
}

describe("child multi_tool_use.parallel", () => {
  it("executes independent active tools concurrently and preserves input order", async () => {
    const test = setup();
    const updates: unknown[] = [];
    const result = await test.definition.execute(
      "outer-call",
      {
        tool_uses: [
          {
            recipient_name: "functions.read",
            parameters: { path: "README.md" },
          },
          {
            recipient_name: "bash",
            parameters: { command: "pwd" },
          },
        ],
      },
      undefined,
      (update: unknown) => updates.push(update),
    );

    expect(test.definition.executionMode).toBe("sequential");
    expect(test.maxActive()).toBe(2);
    expect(test.executeTool).toHaveBeenNthCalledWith(
      1,
      "read",
      { path: "README.md" },
      expect.objectContaining({ toolCallId: "outer-call:0" }),
    );
    expect(result.content.map((item: any) => item.text).join("\n")).toMatch(
      /\[0\].*read[\s\S]*\[1\].*bash/,
    );
    expect(result.details.parallel).toBe(true);
    expect(updates.length).toBeGreaterThan(1);
  });

  it("serializes the whole batch when a target tool requires sequential execution", async () => {
    const test = setup({ sequential: true });
    const result = await test.definition.execute("outer-call", {
      tool_uses: [
        { recipient_name: "read", parameters: { path: "a" } },
        { recipient_name: "bash", parameters: { command: "pwd" } },
      ],
    });

    expect(test.maxActive()).toBe(1);
    expect(result.details.parallel).toBe(false);
  });

  it("propagates terminate only when every nested result requests it", async () => {
    const allTerminate = setup({ terminateTools: ["read", "bash"] });
    const terminated = await allTerminate.definition.execute("outer-call", {
      tool_uses: [
        { recipient_name: "read", parameters: { path: "a" } },
        { recipient_name: "bash", parameters: { command: "pwd" } },
      ],
    });
    expect(terminated.terminate).toBe(true);

    const mixed = setup({ terminateTools: ["read"] });
    const continued = await mixed.definition.execute("outer-call", {
      tool_uses: [
        { recipient_name: "read", parameters: { path: "a" } },
        { recipient_name: "bash", parameters: { command: "pwd" } },
      ],
    });
    expect(continued.terminate).toBeUndefined();
  });

  it("rejects inactive and recursive target tools", async () => {
    const test = setup();
    await expect(
      test.definition.execute("outer-call", {
        tool_uses: [{ recipient_name: "write", parameters: {} }],
      }),
    ).rejects.toThrow("Tool write is not active");
    await expect(
      test.definition.execute("outer-call", {
        tool_uses: [{ recipient_name: CHILD_MULTI_TOOL_NAME, parameters: {} }],
      }),
    ).rejects.toThrow("Recursive multi_tool_use_parallel");
  });
});
