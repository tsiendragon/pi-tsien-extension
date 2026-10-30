import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, matchesGlob, parseAllowlist } from "../src/config.ts";
import { detectGitIntent } from "../src/index.ts";
import { formatReport, parseDiffLines, scanDiff } from "../src/scan.ts";
import { applyConfigGuards } from "../src/run.ts";
import { createLineScanner, mask, scanLine } from "../src/rules.ts";
import type { AiReviewer } from "../src/types.ts";

const config = { ...DEFAULT_CONFIG, aiReview: false };

function categories(line: string, file = "src/a.ts"): string[] {
  return scanLine(file, line, 1).map((hit) => hit.category);
}

function diff(files: Array<{ path: string; lines: string[] }>): string {
  const chunks: string[] = [];
  for (const file of files) {
    chunks.push(`diff --git a/${file.path} b/${file.path}`);
    chunks.push("index 0000000..1111111 100644");
    chunks.push(`--- a/${file.path}`);
    chunks.push(`+++ b/${file.path}`);
    chunks.push(`@@ -0,0 +1,${file.lines.length} @@`);
    for (const line of file.lines) chunks.push(`+${line}`);
  }
  return `${chunks.join("\n")}\n`;
}

test("diff 解析保留新增行的新文件行号", () => {
  const parsed = parseDiffLines([
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,3 +10,4 @@",
    " context",
    "+added one",
    "+added two",
    " context two",
  ].join("\n"));
  const added = parsed.filter((line) => line.added);
  assert.deepEqual(added.map((line) => [line.file, line.line, line.text]), [
    ["a.ts", 11, "added one"],
    ["a.ts", 12, "added two"],
  ]);
});

test("删除行不占用新文件行号", () => {
  const parsed = parseDiffLines([
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -3,2 +3,1 @@",
    "-removed",
    "+kept",
  ].join("\n"));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].line, 3);
});

test("硬凭证类直接命中", () => {
  assert.ok(categories("-----BEGIN OPENSSH PRIVATE KEY-----").includes("private_key"));
  assert.ok(categories('aws_access_key_id = "AKIAZ7Q2XWPLM4RTY6NB"').includes("cloud_key"));
  assert.ok(categories("token: ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8").includes("provider_token"));
  assert.ok(categories("sk-proj-9aB8cD7eF6gH5iJ4kL3mN2oP1qR").includes("provider_token"));
  assert.ok(categories("db: postgres://admin:hunter2pass@db.internal:5432/app").includes("credential_url"));
  assert.ok(categories("auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop").includes("jwt"));
});

test("文档示例值不误报", () => {
  assert.deepEqual(categories('aws_access_key_id = "AKIAIOSFODNN7EXAMPLE"'), []);
  assert.deepEqual(categories('const key = "your-api-key-here"'), []);
  assert.deepEqual(categories('"phone": "13800138000"'), []);
  assert.deepEqual(categories('"idCard": "11010519491231002X"'), []);
});

test("内网地址识别并排除回环/文档段", () => {
  assert.ok(categories('host: "10.20.30.40"').includes("internal_host"));
  assert.ok(categories('url: "http://192.168.1.15:8080"').includes("internal_host"));
  assert.ok(categories('api: "https://pay.corp/v1"').includes("internal_host"));
  assert.ok(categories('svc: "risk-api.prod.svc.cluster.local"').includes("internal_host"));
  assert.deepEqual(categories('local: "http://127.0.0.1:3000"'), []);
  assert.deepEqual(categories('meta: "http://localhost:8080"'), []);
  assert.deepEqual(categories('doc: "http://192.0.2.10"'), []);
});

test("个人信息识别：手机号、身份证、姓名、邮箱", () => {
  assert.ok(categories('"mobile": "13912345678"').includes("phone_cn"));
  assert.ok(categories('"id": "110101199003071234"').includes("id_card_cn"));
  assert.ok(categories("姓名：李小龙").includes("person_name"));
  assert.ok(categories('"fullName": "王小明"').includes("person_name"));
  assert.ok(categories('contact: "zhang.wei@qq.com"').includes("email"));
});

test("个人信息误报防线", () => {
  assert.deepEqual(categories("张三"), []);
  assert.deepEqual(categories('作者邮箱 noreply@github.com'), []);
  assert.deepEqual(categories('"test@example.com"'), []);
  assert.deepEqual(categories("import type { X } from '@types/node'"), []);
  assert.deepEqual(categories('telemetry: "17000000000"'), []);
});

test("带版本号的包名不算邮箱", () => {
  assert.deepEqual(categories("- pi-tsien-web-tools@0.1.2 新增"), []);
  assert.deepEqual(categories("quoted = \"pkg@1.0.0-beta.3\""), []);
  assert.ok(categories("mail: \"someone@company.com\"").includes("email"));
});

test("本机路径识别并放过通用用户", () => {
  assert.ok(categories("path=/home/alice/work/data.csv").includes("local_path"));
  assert.ok(categories("p: C:\\\\Users\\\\tsien\\\\Desktop\\\\a.xlsx").includes("local_path"));
  assert.deepEqual(categories("p=/home/runner/work/repo"), []);
  assert.deepEqual(categories("p=/usr/local/bin"), []);
});

test("身份证校验位决定严格程度", () => {
  assert.equal(scanLine("f.json", '"id": "11010519491231002X"', 1).length, 0, "公开示例号应当被跳过");
  const valid = scanLine("f.json", '"id": "440301199001011234"', 1).find((hit) => hit.category === "id_card_cn");
  assert.ok(valid, "应当识别出身份证号");
  assert.equal(valid.tier, "hard", "校验位正确就是真号，硬拦");
  const fake = scanLine("f.json", '"id": "440301199001011230"', 1).find((hit) => hit.category === "id_card_cn");
  assert.ok(fake, "校验位不对仍应提示");
  assert.equal(fake.tier, "soft", "校验位不对的多半是编的，交给 AI 核");
});

test("整仓扫描：默认配置下锁文件与构建产物被跳过", async () => {
  const report = await scanDiff({
    diff: diff([
      { path: "src/config.ts", lines: ['const host = "10.20.30.40";'] },
      { path: "package-lock.json", lines: ['"resolved": "https://user:pass1234@registry.npmjs.org/x"'] },
      { path: "dist/bundle.js", lines: ['var k = "AKIAZ7Q2XWPLM4RTY6NB";'] },
    ]),
    allowRules: [],
    config,
  });
  assert.equal(report.blocked.length, 1);
  assert.equal(report.blocked[0].file, "src/config.ts");
});

test("行内标记放行", async () => {
  const report = await scanDiff({
    diff: diff([{ path: "docs/a.md", lines: ["连接 10.20.30.40 这台机器 secret-guard:allow"] }]),
    allowRules: [],
    config,
    reviewer: undefined,
  });
  assert.equal(report.blocked.length, 0);
  assert.equal(report.rescued[0]?.rescuedBy, "allowlist-inline");
});

test("放行清单按路径和类别生效", async () => {
  const rules = parseAllowlist("docs/*.md internal_host # 文档里的拓扑示例");
  const report = await scanDiff({
    diff: diff([
      { path: "docs/topo.md", lines: ["机器 10.20.30.40"] },
      { path: "src/a.ts", lines: ["const host = '10.20.30.40';"] },
    ]),
    allowRules: rules,
    config,
  });
  assert.equal(report.blocked.length, 1);
  assert.equal(report.blocked[0].file, "src/a.ts");
});

test("AI 判定为示例时放行，判 real 时仍然阻断", async () => {
  const reviewer: AiReviewer = async (items) =>
    items.map((item) =>
      item.file === "docs/a.md"
        ? { verdict: "example", reason: "文档示例路径" }
        : { verdict: "real", reason: "真实本机路径" },
    );
  const report = await scanDiff({
    diff: diff([
      { path: "docs/a.md", lines: ["结果在 /home/alice/work/out.csv"] },
      { path: "src/a.ts", lines: ["const p = '/home/alice/work/out.csv';"] },
    ]),
    allowRules: [],
    config: { ...config, aiReview: true },
    reviewer,
  });
  assert.equal(report.aiStatus, "ok");
  assert.equal(report.blocked.length, 1);
  assert.equal(report.blocked[0].file, "src/a.ts");
});

test("AI 不可用时软线索降级放行，硬凭证仍阻断", async () => {
  const reviewer: AiReviewer = async () => {
    throw new Error("model offline");
  };
  const report = await scanDiff({
    diff: diff([
      { path: "src/a.ts", lines: ["const p = '/home/alice/x'; const k = 'AKIAZ7Q2XWPLM4RTY6NB';"] },
    ]),
    allowRules: [],
    config: { ...config, aiReview: true, onAiFailure: "notice" },
    reviewer,
  });
  assert.equal(report.aiStatus, "failed");
  assert.equal(report.blocked.length, 1);
  assert.equal(report.blocked[0].category, "cloud_key");
});

test("内网地址和个人信息不接受 AI 放行，只认人工白名单", async () => {
  const reviewer: AiReviewer = async (items) => items.map(() => ({ verdict: "example" as const, reason: "看起来像假的" }));
  const report = await scanDiff({
    diff: diff([{ path: "src/a.ts", lines: ["const h = '10.20.30.40'; const m = '13912345678';"] }]),
    allowRules: [],
    config: { ...config, aiReview: true },
    reviewer,
  });
  assert.equal(report.blocked.length, 2);
  assert.deepEqual(report.blocked.map((hit) => hit.category).sort(), ["internal_host", "phone_cn"]);
  assert.equal(report.aiStatus, "skipped", "没有可交给 AI 的类别时不该发起模型调用");
});

test("硬凭证不经过 AI，即使 AI 说是示例也不放行", async () => {
  const reviewer: AiReviewer = async (items) => items.map(() => ({ verdict: "example", reason: "假的" }));
  const report = await scanDiff({
    diff: diff([{ path: "src/a.ts", lines: ['const k = "AKIAZ7Q2XWPLM4RTY6NB";'] }]),
    allowRules: [],
    config: { ...config, aiReview: true },
    reviewer,
  });
  assert.equal(report.blocked.length, 1);
});

test("glob 匹配", () => {
  assert.ok(matchesGlob("package-lock.json", "**/package-lock.json"));
  assert.ok(matchesGlob("sub/pkg/package-lock.json", "**/package-lock.json"));
  assert.ok(matchesGlob("src/a.ts", "src/*.ts"));
  assert.ok(!matchesGlob("src/nested/a.ts", "src/*.ts"));
  assert.ok(matchesGlob("docs/a.md", "docs/**"));
});

test("脱敏保留可定位但不暴露全文", () => {
  assert.equal(mask("AKIAZ7Q2XWPLM4RTY6NB"), "AKIA***6NB");
  assert.equal(mask("x"), "x***");
  assert.equal(mask("accountkey1234567890abcdefghijklmnopqrstuvwxyz"), "accoun***wxyz");
});

test("只把真正执行 git commit/push 的命令当作提交", () => {
  assert.equal(detectGitIntent("git commit -m 'fix'", "/r")?.action, "commit");
  assert.equal(detectGitIntent("cd sub && git push origin main", "/r")?.action, "push");
  assert.equal(detectGitIntent("git -C /tmp/repo commit -am x", "/r")?.cwd, "/tmp/repo");
  assert.equal(detectGitIntent("GIT_AUTHOR_NAME=x git commit -m y", "/r")?.action, "commit");
  assert.equal(detectGitIntent("echo 'git commit'", "/r"), undefined);
  assert.equal(detectGitIntent("git log --grep push", "/r"), undefined);
  assert.equal(detectGitIntent("git commit --dry-run", "/r"), undefined);
  assert.equal(detectGitIntent("npm test && git status", "/r"), undefined);
});
test("自定义关键词命中即阻断，且只认人工白名单", async () => {
  const scanner = createLineScanner({ blockedKeywords: ["AcmeInternal", "内部代号X"] });
  const hits = scanner("src/a.ts", "const url = 'https://acmeinternal/service';", 7);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].category, "custom_keyword");
  assert.equal(hits[0].tier, "hard");
  const none = scanner("src/a.ts", "const url = 'https://example.com';", 8);
  assert.equal(none.length, 0);
});

test("自定义正则能补内置规则没覆盖的自家格式", async () => {
  const scanner = createLineScanner({
    extraPatterns: [{ id: "acme-session", pattern: "ACMESESS-[0-9a-f]{16}", category: "provider_token" }],
  });
  const hits = scanner("src/a.ts", "cookie = 'ACMESESS-0123456789abcdef'", 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ruleId, "acme-session");
  assert.equal(hits[0].category, "provider_token");
});

test("写错的正则不会拖垮扫描", () => {
  const scanner = createLineScanner({ extraPatterns: [{ id: "bad", pattern: "([unclosed" }] });
  assert.equal(scanner("src/a.ts", "const k = 'AKIAZ7Q2XWPLM4RTY6NB';", 1).length, 1);
});

test("私有配置层叠加生效，且仓库私有文件优先", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "sg-cfg-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".secret-guard.json"), JSON.stringify({ blockedKeywords: ["团队词"] }));
  writeFileSync(join(root, ".secret-guard.local.json"), JSON.stringify({ blockedKeywords: ["私有词"], onAiFailure: "block" }));

  const loaded = loadConfig(root, { withGlobal: false });
  assert.deepEqual(loaded.config.blockedKeywords.sort(), ["团队词", "私有词"].sort(), "两层关键词取并集");
  assert.equal(loaded.config.onAiFailure, "block");
  assert.ok(loaded.configPath?.includes(".secret-guard.local.json"), "报告里能看到叠加的配置路径");
});

function emptyReport(): Parameters<typeof applyConfigGuards>[0] {
  return { blocked: [], rescued: [], scannedLines: 0, scannedFiles: 0, aiStatus: "skipped", skippedLines: 0, warnings: [] };
}

test("把私有规则写进会提交的配置时直接阻断", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "sg-leak-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".secret-guard.json"), JSON.stringify({ blockedKeywords: ["内部代号"], extraPatterns: [] }));

  const loaded = loadConfig(root, { withGlobal: false });
  assert.equal(loaded.sharedRuleLeaks.length, 1);
  const report = applyConfigGuards(emptyReport(), loaded, root);
  assert.equal(report.blocked.length, 1);
  assert.equal(report.blocked[0].category, "config_layer_misuse");
  assert.equal(report.blocked[0].tier, "hard");
  assert.equal(report.blocked[0].file, ".secret-guard.json");
});

test("同样的规则放进不提交的私有配置时不阻断", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "sg-leak2-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".secret-guard.local.json"), JSON.stringify({ blockedKeywords: ["内部代号"] }));

  const loaded = loadConfig(root, { withGlobal: false });
  assert.equal(loaded.sharedRuleLeaks.length, 0);
  const report = applyConfigGuards(emptyReport(), loaded, root);
  assert.equal(report.blocked.length, 0);
  assert.deepEqual(loaded.config.blockedKeywords, ["内部代号"], "规则本身照常生效");
});

test("可提交配置里放规则没有例外开关", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "sg-leak3-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  // 旧版本用来放行的开关，现在必须完全不起作用
  writeFileSync(join(root, ".secret-guard.json"), JSON.stringify({
    blockedKeywords: ["格式描述"],
    extraPatterns: [{ id: "x", pattern: "abc" }],
    allowSharedRules: true,
  }));

  const loaded = loadConfig(root, { withGlobal: false });
  const report = applyConfigGuards(emptyReport(), loaded, root);
  assert.equal(report.blocked.length, 1, "开关已删除，仍然要拦");
  assert.equal(report.blocked[0].category, "config_layer_misuse");
});

test("自定义正则可以指定区分大小写", async () => {
  const scanner = createLineScanner({
    extraPatterns: [{ id: "ticket-prefix", pattern: "\\bOPS\\b", flags: "", tier: "hard" }],
  });
  assert.equal(scanner("a.ts", "ticket = 'OPS-18570'", 1).length, 1);
  assert.equal(scanner("a.ts", "// ops change, review later", 2).length, 0, "小写不该误伤");
});

test("配置层误用可以被白名单按类别放行", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "sg-leak4-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".secret-guard.json"), JSON.stringify({ blockedKeywords: ["格式描述"] }));
  writeFileSync(join(root, ".secret-guard-allow"), ".secret-guard.json config_layer_misuse # 里面只有格式描述\n");

  const loaded = loadConfig(root, { withGlobal: false });
  const report = applyConfigGuards(emptyReport(), loaded, root);
  assert.equal(report.blocked.length, 0);
});

test("私有配置文件被强行加进提交时单独拦一条", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "sg-force-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".secret-guard.local.json"), JSON.stringify({ blockedKeywords: ["内部代号"] }));
  writeFileSync(join(root, ".secret-guard-allow"), "src/*.ts internal_host # 示例\n");

  const loaded = loadConfig(root, { withGlobal: false });
  const forcedDiff = [
    "diff --git a/.secret-guard.local.json b/.secret-guard.local.json",
    "--- a/.secret-guard.local.json",
    "+++ b/.secret-guard.local.json",
    "@@ -1 +1 @@",
    '+{"blockedKeywords":["内部代号"]}',
  ].join("\n");

  const report = applyConfigGuards(emptyReport(), loaded, root, forcedDiff);
  assert.equal(report.blocked.length, 1);
  assert.equal(report.blocked[0].ruleId, "private-config-committed");

  const clean = applyConfigGuards(emptyReport(), loaded, root, "");
  assert.equal(clean.blocked.length, 0, "没被提交时不该报");
});

test("配置文件写坏时给提醒，而不是静默丢掉规则", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "sg-broken-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".secret-guard.json"), "{ not json !!");

  const loaded = loadConfig(root, { withGlobal: false });
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /解析失败/);
  assert.deepEqual(loaded.config.blockedKeywords, [], "坏配置不能让扫描直接崩掉");
});

test("超出上限没扫到的行要在通过提示里说清楚", async () => {
  const many = Array.from({ length: 12 }, (_, i) => `line ${i}`);
  const report = await scanDiff({
    diff: diff([{ path: "src/big.ts", lines: many }]),
    allowRules: [],
    config: { ...DEFAULT_CONFIG, aiReview: false, maxLines: 5 },
  });
  assert.equal(report.scannedLines, 5);
  assert.equal(report.skippedLines, 7);
  const text = formatReport(report, { action: "commit" });
  assert.match(text, /还有 7 行没检查/);
});
