import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

interface SourceMetadata {
  source: string;
  path: string;
  scope?: string;
}

interface ToolUsage extends SourceMetadata {
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  firstUsedAt?: number;
  lastUsedAt?: number;
  sessionCount: number;
}

interface SkillUsage extends SourceMetadata {
  confirmed: number;
  inferred: number;
  exposed: number;
  firstUsedAt?: number;
  lastUsedAt?: number;
  lastExposedAt?: number;
  sessionCount: number;
}

interface UsageStore {
  version: 1;
  createdAt: number;
  updatedAt: number;
  tools: Record<string, ToolUsage>;
  skills: Record<string, SkillUsage>;
}

type Delta =
  | { kind: "discover-tool"; name: string; metadata: SourceMetadata; at: number }
  | { kind: "discover-skill"; name: string; metadata: SourceMetadata; at: number }
  | { kind: "tool"; name: string; metadata: SourceMetadata; at: number; durationMs: number; isError: boolean; newSession: boolean }
  | { kind: "skill"; name: string; metadata: SourceMetadata; at: number; signal: "confirmed" | "inferred" | "exposed"; newSession: boolean };

interface SkillMetadata extends SourceMetadata {
  name: string;
  canonicalPath: string;
}

const STORE_VERSION = 1 as const;
const DEFAULT_UNUSED_DAYS = 30;
const MAX_ROWS = 30;
const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;
const pendingStarts = new Map<string, number>();
const pendingSkillReads = new Map<string, SkillMetadata>();
const skillByPath = new Map<string, SkillMetadata>();
const skillByCommand = new Map<string, SkillMetadata>();
const deltas: Delta[] = [];
let writeQueue = Promise.resolve();
let runId = 0;
let runDedupe = new Set<string>();
let toolSessionSeen = new Set<string>();
let skillSessionSeen = new Set<string>();
let loadWarning: string | undefined;

function now(): number {
  return Date.now();
}

function emptyStore(at = now()): UsageStore {
  return { version: STORE_VERSION, createdAt: at, updatedAt: at, tools: {}, skills: {} };
}

function dataPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "usage-analytics.json");
}

function normalizePath(path: string, cwd: string): string {
  return resolve(cwd, path.replace(/^@/, ""));
}

function sourceMetadata(sourceInfo: { source: string; path: string; scope?: string }): SourceMetadata {
  return { source: sourceInfo.source, path: sourceInfo.path, scope: sourceInfo.scope };
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeSource(value: unknown): SourceMetadata {
  const raw = record(value);
  return {
    source: typeof raw?.source === "string" ? raw.source : "unknown",
    path: typeof raw?.path === "string" ? raw.path : "",
    ...(typeof raw?.scope === "string" ? { scope: raw.scope } : {}),
  };
}

function normalizeStore(value: unknown): UsageStore | undefined {
  const raw = record(value);
  if (raw?.version !== STORE_VERSION) return undefined;
  const toolsRaw = record(raw.tools);
  const skillsRaw = record(raw.skills);
  if (!toolsRaw || !skillsRaw) return undefined;

  const store: UsageStore = {
    version: STORE_VERSION,
    createdAt: number(raw.createdAt) || now(),
    updatedAt: number(raw.updatedAt) || now(),
    tools: {},
    skills: {},
  };

  for (const [name, value] of Object.entries(toolsRaw)) {
    const item = record(value);
    if (!item) continue;
    store.tools[name] = {
      ...normalizeSource(item),
      calls: number(item.calls),
      successes: number(item.successes),
      failures: number(item.failures),
      totalDurationMs: number(item.totalDurationMs),
      firstUsedAt: optionalNumber(item.firstUsedAt),
      lastUsedAt: optionalNumber(item.lastUsedAt),
      sessionCount: number(item.sessionCount) || (Array.isArray(item.sessionIds) ? item.sessionIds.length : 0),
    };
  }

  for (const [name, value] of Object.entries(skillsRaw)) {
    const item = record(value);
    if (!item) continue;
    store.skills[name] = {
      ...normalizeSource(item),
      confirmed: number(item.confirmed),
      inferred: number(item.inferred),
      exposed: number(item.exposed),
      firstUsedAt: optionalNumber(item.firstUsedAt),
      lastUsedAt: optionalNumber(item.lastUsedAt),
      lastExposedAt: optionalNumber(item.lastExposedAt),
      sessionCount: number(item.sessionCount) || (Array.isArray(item.sessionIds) ? item.sessionIds.length : 0),
    };
  }
  return store;
}

function readStore(path = dataPath()): UsageStore {
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = normalizeStore(JSON.parse(readFileSync(path, "utf8")));
    if (parsed) return parsed;
    throw new Error("unsupported or invalid schema");
  } catch (error) {
    let backup = "";
    try {
      const backupPath = `${path}.corrupt-${now()}`;
      renameSync(path, backupPath);
      backup = `，原文件已移至 ${backupPath}`;
    } catch {
      // A concurrent process may already have moved or replaced the broken file.
    }
    loadWarning = `使用统计文件无法读取，已从空数据继续${backup}：${error instanceof Error ? error.message : String(error)}`;
    return emptyStore();
  }
}

function applyDelta(store: UsageStore, delta: Delta): void {
  store.updatedAt = Math.max(store.updatedAt, delta.at);
  if (delta.kind === "discover-tool") {
    store.tools[delta.name] ??= {
      ...delta.metadata,
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      sessionCount: 0,
    };
    return;
  }
  if (delta.kind === "discover-skill") {
    store.skills[delta.name] ??= {
      ...delta.metadata,
      confirmed: 0,
      inferred: 0,
      exposed: 0,
      sessionCount: 0,
    };
    return;
  }
  if (delta.kind === "tool") {
    const item = store.tools[delta.name] ?? {
      ...delta.metadata,
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      sessionCount: 0,
    };
    Object.assign(item, delta.metadata);
    item.calls += 1;
    item.successes += delta.isError ? 0 : 1;
    item.failures += delta.isError ? 1 : 0;
    item.totalDurationMs += delta.durationMs;
    item.firstUsedAt = item.firstUsedAt === undefined ? delta.at : Math.min(item.firstUsedAt, delta.at);
    item.lastUsedAt = Math.max(item.lastUsedAt ?? 0, delta.at);
    item.sessionCount += delta.newSession ? 1 : 0;
    store.tools[delta.name] = item;
    return;
  }

  const item = store.skills[delta.name] ?? {
    ...delta.metadata,
    confirmed: 0,
    inferred: 0,
    exposed: 0,
    sessionCount: 0,
  };
  Object.assign(item, delta.metadata);
  item[delta.signal] += 1;
  if (delta.signal === "exposed") {
    item.lastExposedAt = Math.max(item.lastExposedAt ?? 0, delta.at);
  } else {
    item.firstUsedAt = item.firstUsedAt === undefined ? delta.at : Math.min(item.firstUsedAt, delta.at);
    item.lastUsedAt = Math.max(item.lastUsedAt ?? 0, delta.at);
  }
  item.sessionCount += delta.newSession ? 1 : 0;
  store.skills[delta.name] = item;
}

function writeAtomically(path: string, store: UsageStore): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function withStoreLock<T>(action: () => T | Promise<T>): Promise<T> {
  const lockPath = `${dataPath()}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        return await action();
      } finally {
        try { rmdirSync(lockPath); } catch {}
      }
    } catch (error) {
      const code = record(error)?.code;
      if (code !== "EEXIST") throw error;
      try {
        if (now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmdirSync(lockPath);
      } catch {}
      await delay(Math.min(10 + attempt, 100));
    }
  }
  throw new Error(`等待使用统计锁超时：${lockPath}`);
}

async function mergeDeltas(batch: Delta[]): Promise<void> {
  await withStoreLock(() => {
    const store = readStore();
    for (const item of batch) applyDelta(store, item);
    writeAtomically(dataPath(), store);
  });
}

function queueDelta(delta: Delta): void {
  deltas.push(delta);
  writeQueue = writeQueue.then(async () => {
    const batch = deltas.splice(0);
    if (batch.length === 0) return;
    try {
      await mergeDeltas(batch);
    } catch {
      deltas.unshift(...batch);
    }
  });
}

async function flush(): Promise<void> {
  await writeQueue;
  if (deltas.length > 0) {
    const batch = deltas.splice(0);
    await mergeDeltas(batch);
  }
}

function rebuildIndexes(pi: ExtensionAPI, ctx?: ExtensionContext): void {
  skillByPath.clear();
  skillByCommand.clear();
  for (const command of pi.getCommands().filter((item) => item.source === "skill")) {
    const canonicalPath = normalizePath(command.sourceInfo.path, ctx?.cwd ?? process.cwd());
    const name = command.name.replace(/^skill:/, "");
    const metadata: SkillMetadata = {
      name,
      canonicalPath,
      ...sourceMetadata(command.sourceInfo),
    };
    skillByPath.set(canonicalPath, metadata);
    skillByCommand.set(command.name, metadata);
    skillByCommand.set(`skill:${name}`, metadata);
  }
}

function toolMetadata(pi: ExtensionAPI, name: string): SourceMetadata {
  const tool = pi.getAllTools().find((item) => item.name === name);
  return tool ? sourceMetadata(tool.sourceInfo) : { source: "unknown", path: "" };
}

function inferSkillFromReadPath(path: unknown, cwd: string): SkillMetadata | undefined {
  if (typeof path !== "string") return undefined;
  return skillByPath.get(normalizePath(path, cwd));
}

function markSkill(skill: SkillMetadata, signal: "confirmed" | "inferred" | "exposed", _ctx: ExtensionContext): void {
  const dedupeKey = `${runId}:${signal}:${skill.name}`;
  if (runDedupe.has(dedupeKey)) return;
  runDedupe.add(dedupeKey);
  const newSession = signal !== "exposed" && !skillSessionSeen.has(skill.name);
  if (newSession) skillSessionSeen.add(skill.name);
  queueDelta({
    kind: "skill",
    name: skill.name,
    metadata: { source: skill.source, path: skill.path, scope: skill.scope },
    at: now(),
    signal,
    newSession,
  });
}

function formatDate(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toISOString().slice(0, 10) : "从未";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function rows<T>(items: T[], render: (item: T) => string): string {
  if (items.length === 0) return "暂无数据。";
  const shown = items.slice(0, MAX_ROWS).map(render);
  if (items.length > MAX_ROWS) shown.push(`… 另有 ${items.length - MAX_ROWS} 项，请用 /usage export 查看。`);
  return shown.join("\n");
}

function toolReport(store: UsageStore): string {
  const items = Object.entries(store.tools).sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]));
  return rows(items, ([name, item]) =>
    `${name}: ${item.calls} 次，成功 ${item.successes} / 失败 ${item.failures}，累计 ${formatDuration(item.totalDurationMs)}，最近 ${formatDate(item.lastUsedAt)}`,
  );
}

function skillReport(store: UsageStore): string {
  const items = Object.entries(store.skills).sort((a, b) =>
    (b[1].confirmed + b[1].inferred) - (a[1].confirmed + a[1].inferred) || a[0].localeCompare(b[0]),
  );
  return rows(items, ([name, item]) =>
    `${name}: confirmed ${item.confirmed}，inferred ${item.inferred}，exposed ${item.exposed}，最近使用 ${formatDate(item.lastUsedAt)}`,
  );
}

function unusedReport(store: UsageStore, days: number): string {
  const cutoff = now() - days * 86_400_000;
  const candidates: Array<{ type: string; name: string; lastUsedAt?: number; path: string }> = [];
  for (const [name, item] of Object.entries(store.tools)) {
    if (item.source === "builtin") continue;
    if (!item.lastUsedAt || item.lastUsedAt < cutoff) candidates.push({ type: "Tool", name, lastUsedAt: item.lastUsedAt, path: item.path });
  }
  for (const [name, item] of Object.entries(store.skills)) {
    if (!item.lastUsedAt || item.lastUsedAt < cutoff) candidates.push({ type: "Skill", name, lastUsedAt: item.lastUsedAt, path: item.path });
  }
  candidates.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0) || a.name.localeCompare(b.name));
  const output = rows(candidates, (item) => `${item.type} ${item.name}: 最近 ${formatDate(item.lastUsedAt)}${item.path ? ` (${item.path})` : ""}`);
  return `${output}\n\n仅为卸载候选；安全门禁、发布检查等低频关键能力仍需人工判断。`;
}

function show(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function parseDays(value: string | undefined): number | undefined {
  if (!value) return DEFAULT_UNUSED_DAYS;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 3650 ? parsed : undefined;
}

export default function usageAnalytics(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    rebuildIndexes(pi, ctx);
    runId = 0;
    runDedupe = new Set();
    toolSessionSeen = new Set();
    skillSessionSeen = new Set();
    readStore();
    const at = now();
    for (const tool of pi.getAllTools()) {
      queueDelta({ kind: "discover-tool", name: tool.name, metadata: sourceMetadata(tool.sourceInfo), at });
    }
    for (const skill of skillByPath.values()) {
      queueDelta({
        kind: "discover-skill",
        name: skill.name,
        metadata: { source: skill.source, path: skill.path, scope: skill.scope },
        at,
      });
    }
    if (loadWarning) {
      show(ctx, loadWarning, "warning");
      loadWarning = undefined;
    }
  });

  pi.on("resources_discover", (_event, ctx) => {
    rebuildIndexes(pi, ctx);
  });

  pi.on("input", (event, ctx) => {
    rebuildIndexes(pi, ctx);
    const match = event.text.trimStart().match(/^\/((?:skill:)[a-z0-9-]+)(?:\s|$)/i);
    if (!match) return;
    const skill = skillByCommand.get(match[1]);
    if (skill) markSkill(skill, "confirmed", ctx);
  });

  pi.on("agent_start", () => {
    runId += 1;
    runDedupe = new Set();
  });

  pi.on("before_agent_start", (event, ctx) => {
    rebuildIndexes(pi, ctx);
    const readActive = event.systemPromptOptions.selectedTools?.includes("read") ?? pi.getActiveTools().includes("read");
    if (!readActive) return;
    for (const skill of event.systemPromptOptions.skills ?? []) {
      if (skill.disableModelInvocation) continue;
      const metadata = skillByPath.get(normalizePath(skill.filePath, ctx.cwd)) ?? {
        name: skill.name,
        canonicalPath: normalizePath(skill.filePath, ctx.cwd),
        ...sourceMetadata(skill.sourceInfo),
      };
      markSkill(metadata, "exposed", ctx);
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    pendingStarts.set(event.toolCallId, now());
    if (event.toolName !== "read") return;
    rebuildIndexes(pi, ctx);
    const args = record(event.args);
    const skill = inferSkillFromReadPath(args?.path, ctx.cwd);
    if (skill) pendingSkillReads.set(event.toolCallId, skill);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const endedAt = now();
    const startedAt = pendingStarts.get(event.toolCallId) ?? endedAt;
    pendingStarts.delete(event.toolCallId);
    const newSession = !toolSessionSeen.has(event.toolName);
    if (newSession) toolSessionSeen.add(event.toolName);
    queueDelta({
      kind: "tool",
      name: event.toolName,
      metadata: toolMetadata(pi, event.toolName),
      at: endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      isError: event.isError,
      newSession,
    });
    const skill = pendingSkillReads.get(event.toolCallId);
    pendingSkillReads.delete(event.toolCallId);
    if (skill && !event.isError) markSkill(skill, "inferred", ctx);
  });

  pi.on("session_shutdown", async () => {
    try {
      await flush();
    } catch {
      // Analytics must never block Pi shutdown.
    }
  });

  pi.registerCommand("usage", {
    description: "查看本地 Tool / Skill 使用统计",
    handler: async (args, ctx) => {
      await flush();
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = (parts[0] ?? "summary").toLowerCase();
      const store = readStore();

      if (action === "summary") {
        const toolCalls = Object.values(store.tools).reduce((sum, item) => sum + item.calls, 0);
        const skillUses = Object.values(store.skills).reduce((sum, item) => sum + item.confirmed + item.inferred, 0);
        show(ctx, `Tool：${Object.keys(store.tools).length} 个，完成调用 ${toolCalls} 次\nSkill：${Object.keys(store.skills).length} 个，实际使用 ${skillUses} 次\n数据：${dataPath()}`);
        return;
      }
      if (action === "tools") {
        show(ctx, toolReport(store));
        return;
      }
      if (action === "skills") {
        show(ctx, skillReport(store));
        return;
      }
      if (action === "unused") {
        const days = parseDays(parts[1]);
        if (days === undefined) {
          show(ctx, "用法：/usage unused [1-3650 天]", "warning");
          return;
        }
        show(ctx, unusedReport(store, days));
        return;
      }
      if (action === "export") {
        const target = parts[1]
          ? (isAbsolute(parts[1]) ? parts[1] : resolve(ctx.cwd, parts[1]))
          : resolve(ctx.cwd, "usage-analytics-export.json");
        const rel = relative(ctx.cwd, target);
        try {
          writeAtomically(target, store);
          show(ctx, `已导出：${rel.startsWith("..") ? target : rel || target}`);
        } catch (error) {
          show(ctx, `导出失败：${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action === "reset") {
        if (!ctx.hasUI) {
          show(ctx, "/usage reset 需要交互确认。", "warning");
          return;
        }
        const confirmed = await ctx.ui.confirm("清空使用统计？", "此操作只清空本地聚合数据，不会卸载任何能力。");
        if (!confirmed) return;
        deltas.splice(0);
        await withStoreLock(() => writeAtomically(dataPath(), emptyStore()));
        show(ctx, "使用统计已清空。", "info");
        return;
      }
      show(ctx, "用法：/usage [summary|tools|skills|unused [天数]|export [路径]|reset]", "warning");
    },
  });
}
