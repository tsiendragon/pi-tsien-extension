import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSessionReviewer } from "./ai.ts";
import { isGitRepo } from "./git.ts";
import { runScan, type GitAction } from "./run.ts";
import { formatReport } from "./scan.ts";
import type { AiReviewer } from "./types.ts";

const SHELL_WRAPPERS = new Set(["sudo", "command", "time", "nice", "env", "exec", "nohup"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface GitIntent {
  action: GitAction;
  cwd: string;
}

/**
 * 判断一条 shell 命令是否真的要 git commit / git push。
 * 要求 git 是这一段的第一个真实命令，避免把 echo "git commit" 之类误判成提交。
 */
export function detectGitIntent(command: string, baseCwd: string): GitIntent | undefined {
  const segments = command.split(/&&|\|\||[;|]/);
  for (const segment of segments) {
    const words = segment
      .replace(/^[\s({]+/, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let index = 0;
    while (index < words.length && (ASSIGNMENT.test(words[index]) || SHELL_WRAPPERS.has(words[index]))) index += 1;
    if (words[index] !== "git") continue;

    let cwd = baseCwd;
    for (let cursor = index + 1; cursor < words.length; cursor += 1) {
      const word = words[cursor];
      if (word === "-C" || word === "--git-dir") {
        const target = words[cursor + 1];
        if (!target) break;
        if (word === "-C") cwd = path.resolve(baseCwd, target.replace(/^["']|["']$/g, ""));
        cursor += 1;
        continue;
      }
      if (word.startsWith("-")) continue;
      if (word === "commit" || word === "push") {
        const rest = words.join(" ");
        if (/--dry-run|--help|-h\b/.test(rest)) return undefined;
        return { action: word, cwd };
      }
      break;
    }
  }
  return undefined;
}

function sessionReviewer(ctx: ExtensionContext, aiModel?: string): AiReviewer {
  return createSessionReviewer({
    complete: async (prompt, signal) => {
      const model = resolveModel(ctx, aiModel);
      const response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: "你是提交前的敏感信息审核员，只输出 JSON 数组。",
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        { signal },
      );
      return response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    },
  });
}

function resolveModel(ctx: ExtensionContext, aiModel?: string) {
  if (aiModel?.includes("/")) {
    const [provider, ...rest] = aiModel.split("/");
    const found = ctx.modelRegistry.find(provider, rest.join("/"));
    if (found) return found;
  }
  if (!ctx.model) throw new Error("当前会话没有可用模型，无法做 AI 复核");
  return ctx.model;
}

interface GuardOutcome {
  action: GitAction;
  blocked: boolean;
  message: string;
}

async function guard(command: string, cwd: string, ctx: ExtensionContext): Promise<GuardOutcome | undefined> {
  if (process.env.SECRET_GUARD_DISABLE === "1") return undefined;
  const intent = detectGitIntent(command, cwd);
  if (!intent) return undefined;
  if (!isGitRepo(intent.cwd)) return undefined;

  try {
    const { report } = await runScan({
      cwd: intent.cwd,
      action: intent.action,
      reviewerFactory: (config) => sessionReviewer(ctx, config.aiModel),
    });
    return {
      action: intent.action,
      blocked: report.blocked.length > 0,
      message: formatReport(report, { action: intent.action }),
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    if (process.env.SECRET_GUARD_STRICT === "1") {
      return {
        action: intent.action,
        blocked: true,
        message: `敏感信息扫描器自己出错了：${detail}\n设置 SECRET_GUARD_STRICT=1 时不允许跳过，请先修好扫描器。`,
      };
    }
    ctx.ui.notify(`敏感信息扫描器出错，本次跳过：${detail}`, "warning");
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (!command) return undefined;
    const outcome = await guard(command, ctx.cwd, ctx);
    if (!outcome?.blocked) return undefined;
    return {
      block: true,
      reason: `提交/推送被敏感信息检查拦下。原始命令没有执行。\n\n${outcome.message}`,
    };
  });

  pi.on("user_bash", async (event, ctx) => {
    const outcome = await guard(event.command, event.cwd, ctx);
    if (!outcome?.blocked) return undefined;
    return {
      result: {
        output: outcome.message,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.registerCommand("secret-guard", {
    description: "扫描待提交/待推送内容里的敏感信息、内网地址和个人信息",
    handler: async (args, ctx) => {
      const action: GitAction = args.trim() === "push" ? "push" : "commit";
      const cwd = ctx.cwd;
      if (!isGitRepo(cwd)) {
        ctx.ui.notify("当前目录不是 git 仓库", "warning");
        return;
      }
      try {
        const { loaded, label, report } = await runScan({
          cwd,
          action,
          reviewerFactory: (config) => sessionReviewer(ctx, config.aiModel),
        });
        const header = `扫描范围：${label}　配置：${loaded.configPath ?? "内置默认"}　放行清单：${loaded.allowlistPath ?? "无"}`;
        ctx.ui.notify(`${header}\n\n${formatReport(report, { action })}`, report.blocked.length > 0 ? "warning" : "info");
      } catch (error: unknown) {
        ctx.ui.notify(`扫描失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}