import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelRouter,
  RouterExhaustedError,
  classifyError,
  formatRouterSnapshot,
  parseRouterConfig,
} from "../../../packages/pi-tsien-subagent-workbench/src/model-router.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configFile(config: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-models-"));
  dirs.push(dir);
  const file = path.join(dir, "subagent-models.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
}

const baseConfig = {
  version: 1,
  defaultTier: "medium",
  roles: { read_only: "light", research: "medium", code: "medium" },
  tiers: {
    light: {
      candidates: [{ model: "a/light-1", maxConcurrency: 1 }, { model: "b/light-2" }],
      onExhausted: { action: "wait_then_escalate", maxWaitMs: 5_000, escalateTo: "medium" },
    },
    medium: { candidates: [{ model: "c/medium-1", thinking: "high" }] },
    heavy: { candidates: [{ model: "d/heavy-1" }] },
    ultra: { candidates: [] },
  },
};

function clockRouter(config: unknown = baseConfig) {
  let now = 1_000_000;
  const router = new ModelRouter({
    configPath: configFile(config),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { router, advance: (ms: number) => (now += ms) };
}

describe("classifyError", () => {
  it.each([
    ['Pi RPC process exited; stderr: Error: Model "azure-gateway/gpt-5.6-luna" not found.', "not_found"],
    ["429 Too Many Requests", "rate_limited"],
    ["insufficient_quota: You exceeded your current quota", "quota_exhausted"],
    ['529 {"type":"overloaded_error"}', "overloaded"],
    ["Request aborted", "network"],
    ["This operation was aborted", "network"],
    ["prompt is too long: 300000 tokens > 200000 maximum", "context_overflow"],
    ["401 invalid api key", "auth"],
    ["Run interrupted.", "cancelled"],
    ["reached its model call budget (5 calls)", "budget"],
    ["something odd", "unknown"],
  ])("%s -> %s", (message, expected) => {
    expect(classifyError(message).errorClass).toBe(expected);
  });

  it("reads retry-after seconds", () => {
    expect(classifyError("429 rate limit, retry-after: 7")).toEqual({ errorClass: "rate_limited", retryAfterMs: 7_000 });
  });
});

describe("parseRouterConfig", () => {
  it("accepts the documented shape and applies confirmed defaults", () => {
    const config = parseRouterConfig(baseConfig);
    expect(config.tiers.medium.onExhausted).toMatchObject({ action: "wait" });
    expect(config.tiers.heavy.onExhausted.action).toBe("fail");
    expect(config.workHardMs).toBe(72 * 60 * 60_000);
    expect(config.maxModelCallsPerTask).toBe(2_000);
  });

  it("rejects duplicates and automatic escalation to heavy", () => {
    expect(() =>
      parseRouterConfig({ ...baseConfig, tiers: { light: { candidates: [{ model: "a/x" }] }, medium: { candidates: [{ model: "a/x" }] } } }),
    ).toThrow(/more than one place/);
    expect(() =>
      parseRouterConfig({ version: 1, tiers: { medium: { candidates: [], onExhausted: { action: "escalate", escalateTo: "heavy" } } } }),
    ).toThrow(/never reached automatically/);
  });
});

describe("ModelRouter", () => {
  it("uses candidates in order, cools down rate-limited models, and returns after cooldown", async () => {
    const { router, advance } = clockRouter();
    const plan = router.plan({ role: "read_only" });
    const first = await router.acquire(plan, new Set());
    expect(first.model).toBe("a/light-1");
    first.release();
    router.reportFailure("a/light-1", "rate_limited", "429");
    const second = await router.acquire(plan, new Set());
    expect(second.model).toBe("b/light-2");
    second.release();
    advance(61_000);
    expect((await router.acquire(plan, new Set())).model).toBe("a/light-1");
  });

  it("spills over when the first candidate is at max concurrency", async () => {
    const { router } = clockRouter();
    const plan = router.plan({ tier: "light" });
    const held = await router.acquire(plan, new Set());
    expect((await router.acquire(plan, new Set())).model).toBe("b/light-2");
    held.release();
  });

  it("cools down a whole quota group", async () => {
    const { router } = clockRouter({
      version: 1,
      tiers: { medium: { candidates: [{ model: "g/one", quotaGroup: "shared" }, { model: "g/two", quotaGroup: "shared" }, { model: "h/three" }] } },
    });
    router.reportFailure("g/one", "quota_exhausted", "insufficient_quota");
    expect((await router.acquire(router.plan({}), new Set())).model).toBe("h/three");
  });

  it("waits then escalates light to medium, and fails heavy immediately", async () => {
    const { router } = clockRouter();
    router.reportFailure("a/light-1", "rate_limited", "429", 60_000);
    router.reportFailure("b/light-2", "rate_limited", "429", 60_000);
    const lease = await router.acquire(router.plan({ tier: "light" }), new Set());
    expect(lease).toMatchObject({ model: "c/medium-1", tier: "medium", thinking: "high" });
    router.reportFailure("d/heavy-1", "overloaded", "529");
    await expect(router.acquire(router.plan({ tier: "heavy" }), new Set())).rejects.toBeInstanceOf(RouterExhaustedError);
  });

  it("disables unregistered models and rejects unconfigured explicit models", async () => {
    const router = new ModelRouter({
      configPath: configFile(baseConfig),
      catalog: () => ({ known: new Set(["b/light-2"]), available: new Set(["b/light-2"]) }),
    });
    expect((await router.acquire(router.plan({ tier: "light" }), new Set())).model).toBe("b/light-2");
    expect(() => router.plan({ model: "z/other" })).toThrow(/not configured/);
    expect(router.plan({ model: "c/medium-1" })).toMatchObject({ tier: "pinned" });
    expect(router.plan({ model: "c/medium-1", allowFallback: true })).toMatchObject({ tier: "medium", preferred: "c/medium-1" });
    expect(formatRouterSnapshot(router)).toContain("a/light-1 — 停用");
  });

  it("keeps the last valid config when the file becomes invalid, and has no built-in default", () => {
    const file = configFile(baseConfig);
    const router = new ModelRouter({ configPath: file });
    expect(router.config().tiers.light.candidates).toHaveLength(2);
    writeFileSync(file, "{ broken");
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(router.config().tiers.light.candidates).toHaveLength(2);
    expect(router.warning()).toMatch(/Invalid/);

    const legacy = new ModelRouter({ configPath: path.join(os.tmpdir(), "missing-subagent-models.json"), environment: {} });
    return expect(legacy.acquire(legacy.plan({}), new Set())).rejects.toBeInstanceOf(RouterExhaustedError);
  });
});
