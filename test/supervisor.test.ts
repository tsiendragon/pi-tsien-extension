import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { TObject } from "typebox";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import supervisorExtension, {
  AUTO_PATROL_TAG,
  grantFromPrompt,
  MAX_RESULT_BYTES,
  readCredentials,
  RPC_TIMEOUT_MS,
  SupervisorGateway,
  SUPERVISOR_TOOL_NAMES,
  type SupervisorCredentials,
} from "../extensions/supervisor/index.ts";

const GRANT = "a1234567-1234-4567-89ab-123456789abc";
interface Received {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  body: unknown;
}
type Respond = (req: IncomingMessage, res: ServerResponse, received: Received) => void;

async function fixture(t: TestContext, allowedTools: string[] = [...SUPERVISOR_TOOL_NAMES, "read"]) {
  const dir = await mkdtemp(join(tmpdir(), "pi-supervisor-"));
  const filePath = join(dir, "credentials.json");
  const credentials: SupervisorCredentials = {
    socketPath: join(dir, "gateway.sock"), token: "test-only-bearer-token", revision: "revision-7", allowedTools,
  };
  const received: Received[] = [];
  let respond: Respond = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: "gateway-result" }));
  };
  const connections = new Set<Socket>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const item = {
        method: req.method, path: req.url, authorization: req.headers.authorization,
        body: body ? JSON.parse(body) as unknown : undefined,
      };
      received.push(item);
      if (item.authorization !== `Bearer ${credentials.token}`) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      respond(req, res, item);
    });
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  t.after(async () => {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(credentials.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await writeFile(filePath, JSON.stringify(credentials), { mode: 0o600 });
  return {
    credentials, filePath, received,
    gateway: new SupervisorGateway(credentials, filePath),
    respondWith(handler: Respond) { respond = handler; },
  };
}

type Hook = (event: never, ctx: ExtensionContext) => unknown;
function harness(filePath?: string) {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Hook>();
  const flags = new Map<string, { type: string }>();
  const active: string[][] = [];
  let confirmResult = true;
  let confirmImpl: (() => Promise<boolean>) | undefined;
  let confirmations = 0;
  const confirmationTexts: string[] = [];
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => "supervisor-session" },
    ui: { confirm: async (_title: string, question: string) => {
      confirmations++;
      confirmationTexts.push(question);
      return confirmImpl ? confirmImpl() : confirmResult;
    } },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, command); },
    registerFlag: (name: string, options: { type: string }) => { flags.set(name, options); },
    getFlag: () => filePath,
    registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
    on: (name: string, handler: Hook) => { handlers.set(name, handler); },
    getAllTools: () => [...tools.keys(), "read", "bash"].map((name) => ({ name })),
    setActiveTools: (names: string[]) => { active.push([...names]); },
  } as unknown as ExtensionAPI;
  supervisorExtension(pi);
  return {
    commands, tools, flags, active, ctx, confirmationTexts,
    get confirmations() { return confirmations; },
    confirm(value: boolean) { confirmResult = value; },
    confirmWith(fn: () => Promise<boolean>) { confirmImpl = fn; },
    async emit(name: string, event: unknown = {}) {
      const handler = handlers.get(name);
      assert.ok(handler, `Missing hook ${name}`);
      return handler(event as never, ctx);
    },
    async execute(name: string, args: unknown = {}, signal?: AbortSignal) {
      const tool = tools.get(name);
      assert.ok(tool, `Missing tool ${name}`);
      return tool.execute("call-1", args, signal, undefined, ctx);
    },
  };
}

test("supervisor clear creates an empty session without seeding old context", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  let created = 0;
  const ctx = { isIdle: () => true, newSession: async (...args: unknown[]) => {
    assert.deepEqual(args, []);
    created++;
    return { cancelled: false };
  } };
  await h.commands.get("supervisor-clear")!.handler("", ctx);
  assert.equal(created, 1);
  await assert.rejects(h.commands.get("supervisor-clear")!.handler("", { ...ctx, isIdle: () => false }), /正在工作/);
  await assert.rejects(h.commands.get("supervisor-clear")!.handler("", { ...ctx, newSession: async () => ({ cancelled: true }) }), /已取消/);
});

test("gateway authenticates Unix HTTP health, loaded acknowledgement, and exact execution payload", async (t) => {
  const f = await fixture(t);
  assert.equal(RPC_TIMEOUT_MS, 15_000);
  assert.equal(MAX_RESULT_BYTES, 2 * 1024 * 1024);
  await f.gateway.call("/health");
  const ack = { revision: f.credentials.revision, sessionId: "s-1", tools: ["event_get"] };
  await f.gateway.call("/loaded", ack);
  const payload = { request: { operation: "events", args: { id: "event-1" } }, grantRef: GRANT, confirmed: true };
  assert.deepEqual(await f.gateway.call("/execute", payload), { ok: true, result: "gateway-result" });
  assert.deepEqual(f.received, [
    { method: "GET", path: "/health", authorization: `Bearer ${f.credentials.token}`, body: undefined },
    { method: "POST", path: "/loaded", authorization: `Bearer ${f.credentials.token}`, body: ack },
    { method: "POST", path: "/execute", authorization: `Bearer ${f.credentials.token}`, body: payload },
  ]);
});

test("gateway rejects HTTP errors, backend errors, redirects, invalid JSON and empty execution", async (t) => {
  const f = await fixture(t);
  for (const [status, body, expected] of [
    [403, '{"error":"grant denied"}', /HTTP 403: grant denied/],
    [200, '{"ok":false,"error":{"message":"task not authorized"}}', /task not authorized/],
    [302, '{"error":"no redirects"}', /HTTP 302/],
    [200, 'not-json', /invalid JSON/],
    [204, '', /no execution result/],
  ] as const) {
    f.respondWith((_req, res) => { res.writeHead(status).end(body); });
    await assert.rejects(f.gateway.call("/execute", { request: { operation: "context", args: {} } }), expected);
  }
  assert.equal(f.received.length, 5);
});

test("gateway enforces an absolute deadline even if the response keeps sending bytes", async (t) => {
  const f = await fixture(t);
  f.respondWith((_req, res) => {
    res.writeHead(200);
    res.write('"');
    const timer = setInterval(() => res.write("x"), 5);
    res.on("close", () => clearInterval(timer));
  });
  await assert.rejects(f.gateway.call("/execute", {}, { timeoutMs: 40 }), /timed out/);
});

test("gateway rejects over-size results and interrupted responses", async (t) => {
  const f = await fixture(t);
  f.respondWith((_req, res) => res.end(JSON.stringify("x".repeat(MAX_RESULT_BYTES))));
  await assert.rejects(f.gateway.call("/execute", {}), /exceeds 2 MiB/);
  f.respondWith((_req, res) => {
    res.writeHead(200, { "Content-Length": "1000" });
    res.write("{");
    setImmediate(() => res.destroy());
  });
  await assert.rejects(f.gateway.call("/execute", {}), /interrupted|connection failed/);
});

test("gateway cancellation and transport failures do not expose credential paths", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.gateway.call("/execute", {}, { signal: controller.signal }), /cancelled/);
  assert.equal(f.received.length, 0);
  const missing = new SupervisorGateway({ ...f.credentials, socketPath: join(f.filePath, "missing.sock") }, f.filePath);
  await assert.rejects(missing.call("/health"), (error: unknown) => {
    assert.equal((error as Error).message, "Supervisor gateway connection failed.");
    return true;
  });
});

test("gateway redacts credential values from successful results and backend errors", async (t) => {
  const f = await fixture(t);
  const secrets = [f.credentials.token, f.credentials.socketPath, f.filePath];
  f.respondWith((_req, res) => res.end(JSON.stringify({ result: secrets.join(" | ") })));
  const result = JSON.stringify(await f.gateway.call("/execute", {}));
  for (const secret of secrets) assert.equal(result.includes(secret), false);
  assert.match(result, /redacted/);
  f.respondWith((_req, res) => res.writeHead(403).end(JSON.stringify({ error: secrets.join(" | ") })));
  await assert.rejects(f.gateway.call("/execute", {}), (error: unknown) => {
    for (const secret of secrets) assert.equal((error as Error).message.includes(secret), false);
    return true;
  });
  f.respondWith((_req, res) => res.end(f.credentials.token));
  await assert.rejects(f.gateway.call("/execute", {}), { message: "Supervisor gateway returned invalid JSON." });
});

test("redaction handles escaped values and keys without corrupting numeric JSON", async (t) => {
  const f = await fixture(t);
  f.credentials.token = 'test-"quoted"-credential';
  f.respondWith((_req, res) => res.end(JSON.stringify({ nested: [f.credentials.token], value: 123 })));
  assert.deepEqual(await f.gateway.call("/execute", {}), { nested: ["[redacted]"], value: 123 });
  f.credentials.token = "123";
  f.respondWith((_req, res) => res.end('{"123":"123","value":123}'));
  assert.deepEqual(await f.gateway.call("/execute", {}), { "[redacted]": "[redacted]", value: 123 });
});

test("in-flight cancellation stops the real HTTP request", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.respondWith(() => controller.abort());
  await assert.rejects(f.gateway.call("/execute", {}, { signal: controller.signal }), /cancelled/);
  assert.equal(f.received.length, 1);
});

test("credential loading is lazy; startup authenticates and acknowledges revision, session and whitelist", async (t) => {
  const f = await fixture(t, ["supervisor_context", "event_get", "read"]);
  const h = harness(f.filePath);
  assert.deepEqual([...h.tools.keys()], SUPERVISOR_TOOL_NAMES);
  assert.equal(h.flags.get("supervisor-credentials")?.type, "string");
  assert.equal(f.received.length, 0);
  assert.equal(h.active.length, 0);
  await assert.rejects(h.execute("supervisor_context"), /not ready/);
  await h.emit("session_start");
  assert.deepEqual(f.received.map((r) => r.path), ["/health", "/loaded"]);
  assert.deepEqual(f.received[1].body, {
    revision: "revision-7", sessionId: "supervisor-session", tools: f.credentials.allowedTools,
  });
  await h.emit("before_agent_start", { prompt: `${AUTO_PATROL_TAG}patrol` });
  assert.deepEqual(h.active.at(-1), f.credentials.allowedTools);
  assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
  assert.deepEqual(await h.emit("tool_call", { toolName: "bash" }), {
    block: true, reason: "Tool is not authorized by the supervisor profile.",
  });
  await assert.rejects(h.execute("supervisor_action", { action: "x" }), /not allowed/);
});

test("absent, unreadable, invalid or unknown-tool configuration fails closed", async (t) => {
  const f = await fixture(t);
  const missingFlag = harness();
  await assert.rejects(missingFlag.emit("session_start"), /credential flag is required/);
  assert.deepEqual(missingFlag.active.at(-1), []);
  const missingFile = harness(join(f.filePath, "not-a-file"));
  await assert.rejects(missingFile.emit("session_start"), { message: "Supervisor credentials could not be read." });
  await writeFile(f.filePath, "not-json");
  await assert.rejects(readCredentials(f.filePath), { message: "Supervisor credentials could not be read." });
  await writeFile(f.filePath, JSON.stringify({ ...f.credentials, revision: 7 }));
  assert.equal((await readCredentials(f.filePath)).revision, 7);
  await writeFile(f.filePath, JSON.stringify({ ...f.credentials, token: "bad\r\nheader" }));
  await assert.rejects(readCredentials(f.filePath), /credentials are invalid/);
  await writeFile(f.filePath, JSON.stringify({ ...f.credentials, allowedTools: ["unknown-tool"] }));
  const invalid = harness(f.filePath);
  await assert.rejects(invalid.emit("session_start"), /unavailable tools/);
  assert.deepEqual(invalid.active.at(-1), []);
  assert.equal(f.received.length, 0);
});

test("failed health or loaded acknowledgement leaves all tool execution blocked", async (t) => {
  const f = await fixture(t);
  for (const path of ["/health", "/loaded"]) {
    f.respondWith((req, res) => {
      res.writeHead(req.url === path ? 403 : 200).end(JSON.stringify(req.url === path ? { error: "denied" } : { ok: true }));
    });
    const h = harness(f.filePath);
    await assert.rejects(h.emit("session_start"), /denied/);
    await h.emit("before_agent_start", { prompt: `${AUTO_PATROL_TAG}patrol` });
    assert.deepEqual(h.active.at(-1), []);
    await assert.rejects(h.execute("supervisor_context"), /not ready/);
  }
});

test("historical screenshots are returned as image content without base64 in text", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  f.respondWith((_req, res) => res.end(JSON.stringify({ ok: true, result: { event: { id: "event-1", attachmentIds: ["image-1"] }, images: [{ attachmentId: "image-1", mimeType: "image/png", data }] } })));
  const result = await h.execute("event_get", { id: "event-1", includeImages: true });
  assert.deepEqual(result.content[1], { type: "image", data, mimeType: "image/png" });
  assert.equal(result.content[0].type, "text");
  assert.equal(JSON.stringify(result.content[0]).includes(data), false);
});

test("all fifteen tools map to actual gateway operations without shell or arbitrary args", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  await h.emit("before_agent_start", { prompt: `[supervisor-user-grant:${GRANT}]` });
  const cases: [string, string, Record<string, unknown>][] = [
    ["supervisor_context", "context", { scope: "tasks" }],
    ["event_objects", "context", { query: "open", limit: 10 }],
    ["event_list", "events", { objectRef: "local:object-1", limit: 3 }],
    ["event_query", "query", { objectRef: "local:object-1", includeChildren: true, limit: 20, order: "desc", types: ["progress"], since: "2026-01-01", until: "2026-03-31", view: "summary" }],
    ["event_get", "events", { id: "event-1" }],
    ["event_append", "record", { objectRef: "local:task-1", title: "observed", type: "progress" }],
    ["event_correct", "correct", { id: "event-1", expectedVersion: 1, patch: { title: "corrected" }, reason: "source verified" }],
    ["supervisor_task_create", "task_create", { title: "Task", kind: "task", parentUid: "local:epic-1" }],
    ["supervisor_task_update", "task_update", { uid: "local:task-1", description: "work in progress" }],
    ["supervisor_working_state", "working_state", { objectRef: "local:task-1", description: "User confirmed waiting", stage: "waiting" }],
    ["supervisor_action", "action", { title: "Need a decision", objectRef: "local:task-1", state: "suggested", sourceRefs: [] }],
    ["supervisor_analyze", "analyze", { objectRef: "local:task-1" }],
    ["supervisor_report", "report", { kind: "summary", content: "summary", coverage: "one task", missing: [], sourceRefs: [] }],
    ["supervisor_inspect", "inspect", { path: "/approved/report.md", query: "progress" }],
    ["supervisor_coordinate", "coordinate", { sessionId: "session-2", text: "Please report progress.", kind: "continue", sourceRefs: ["event-1"] }],
  ];
  for (const [name, operation, args] of cases) {
    const result = await h.execute(name, args);
    assert.deepEqual(result.content, [{ type: "text", text: '{"ok":true,"result":"gateway-result"}' }]);
    const sent = (f.received.at(-1)?.body as { request: { operation: string; args: Record<string, unknown> } }).request;
    assert.match(String(sent.args.requestId), /^[a-f0-9]{64}$/);
    const { requestId: _requestId, ...sentArgs } = sent.args;
    assert.deepEqual({ operation: sent.operation, args: sentArgs }, { operation, args });
    const schema = h.tools.get(name)!.parameters as TObject & { additionalProperties: boolean };
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.equal("confirmed" in schema.properties, false);
    assert.equal("grantRef" in schema.properties, false);
  }
  assert.equal(h.confirmations, 1);
  assert.match(h.confirmationTexts[0], /event-1/);
  assert.match(h.confirmationTexts[0], /corrected/);
  await assert.rejects(h.execute("supervisor_action", { action: "x", command: "sh" }), /arguments are invalid/);
  await assert.rejects(h.execute("supervisor_inspect", { path: "relative.md" }), /approved absolute path/);
});

test("pasted screenshots are archived once and their ids are handed to the model", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  f.respondWith((_req, res, item) => {
    const operation = (item.body as { request?: { operation?: string } })?.request?.operation;
    if (operation === "attachment_put") return res.end(JSON.stringify({ ok: true, result: { attachmentId: "attachment-9", bytes: 3, mime: "image/png" } }));
    res.end(JSON.stringify({ ok: true, result: "gateway-result" }));
  });
  const images = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
  const result = await h.emit("before_agent_start", { prompt: "帮我把这个记录到对应任务的记录里", images }) as { message?: { customType?: string; content?: string } };
  const upload = f.received.filter(item => (item.body as { request?: { operation?: string } })?.request?.operation === "attachment_put");
  assert.equal(upload.length, 1);
  assert.equal((upload[0].body as { userTurn?: boolean }).userTurn, true);
  assert.equal(result?.message?.customType, "supervisor-attachments");
  assert.match(String(result?.message?.content), /attachmentIds=\["attachment-9"\]/);
  // The instruction must not reintroduce a detail the model could invent.
  assert.match(String(result?.message?.content), /不要编造 id/);
  // The dashboard dialog already uploaded its own images; those must not be archived a second time.
  f.received.length = 0;
  const second = await h.emit("before_agent_start", { prompt: "[supervisor-user-grant:a1234567-1234-4567-89ab-123456789abc]\n用户提交的已保存截图 attachmentIds：[\"attachment-1\"]\n记录一下", images });
  assert.equal(f.received.filter(item => (item.body as { request?: { operation?: string } })?.request?.operation === "attachment_put").length, 0);
  assert.equal(second, undefined);
  // An automatic patrol turn never archives anything.
  f.received.length = 0;
  const third = await h.emit("before_agent_start", { prompt: `${AUTO_PATROL_TAG}巡查`, images });
  assert.equal(f.received.length, 0);
  assert.equal(third, undefined);
});

test("a user grant is captured per turn and never reused for automatic patrol", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  await h.emit("before_agent_start", { prompt: `[supervisor-user-grant:${GRANT}] user request` });
  await h.execute("event_get", { id: "event-1" });
  assert.equal((f.received.at(-1)?.body as { grantRef: string }).grantRef, GRANT);
  assert.equal((f.received.at(-1)?.body as { userTurn?: boolean }).userTurn, true);
  await h.emit("before_agent_start", { prompt: `${AUTO_PATROL_TAG}automatic patrol` });
  await h.execute("event_get", { id: "event-2" });
  assert.equal((f.received.at(-1)?.body as { grantRef?: string }).grantRef, undefined);
  assert.equal((f.received.at(-1)?.body as { request: { args: { id: string } } }).request.args.id, "event-2");
  assert.equal(grantFromPrompt(`[supervisor-user-grant:${GRANT}]`), GRANT);
  assert.equal(grantFromPrompt("[supervisor-user-grant:invalid]"), undefined);
  assert.equal(grantFromPrompt(`[supervisor-user-grant:${GRANT}][supervisor-user-grant:${GRANT}]`), undefined);
});

test("an untagged prompt is a real user turn, so writes need no marker", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  await h.emit("before_agent_start", { prompt: "帮我把这个记录到对应任务的记录里" });
  await h.execute("event_append", { objectRef: "local:task-1", title: "recorded", type: "progress" });
  assert.equal((f.received.at(-1)?.body as { userTurn?: boolean }).userTurn, true);
  // The turn's own words travel with the request so the gateway keeps negation/question safeguards.
  assert.equal((f.received.at(-1)?.body as { userPrompt?: string }).userPrompt, "帮我把这个记录到对应任务的记录里");
  await h.execute("event_get", { id: "event-9" });
  assert.equal((f.received.at(-1)?.body as { userTurn?: boolean }).userTurn, true);
  // The dashboard's own patrol prompt is tagged, so that turn must not claim a user turn.
  await h.emit("before_agent_start", { prompt: `${AUTO_PATROL_TAG}【自动巡查】check the approved sessions` });
  await h.execute("event_get", { id: "event-10" });
  assert.equal((f.received.at(-1)?.body as { userTurn?: boolean }).userTurn, undefined);
  assert.equal((f.received.at(-1)?.body as { userPrompt?: string }).userPrompt, undefined);
});

test("task completion, corrections and action completion require real UI confirmation", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  await h.emit("before_agent_start", { prompt: `[supervisor-user-grant:${GRANT}]` });
  const cases: [string, Record<string, unknown>][] = [
    ["supervisor_task_update", { uid: "local:task-1", status: "done", evidence: "tests passed" }],
    ["event_correct", { id: "event-1", expectedVersion: 1, patch: { title: "corrected" }, reason: "verified" }],
    ["supervisor_action", { id: "action-1", expectedVersion: 1, state: "done" }],
  ];
  for (const [name, args] of cases) {
    h.confirm(false);
    const before = f.received.length;
    await assert.rejects(h.execute(name, args), /操作确认未通过/);
    assert.equal(f.received.length, before);
    h.confirm(true);
    await h.execute(name, args);
    assert.equal((f.received.at(-1)?.body as { confirmed: boolean }).confirmed, true);
  }
  await assert.rejects(h.execute("supervisor_task_update", { uid: "local:task-1", status: "done" }), /requires observable evidence/);
  await assert.rejects(h.execute("supervisor_task_update", { uid: "local:task-1", status: "done", evidence: "  " }), /requires observable evidence/);
  await assert.rejects(h.execute("event_correct", { id: "event-1", expectedVersion: 1, patch: { title: "x" }, reason: "x", confirmed: true }), /arguments are invalid/);
  await assert.rejects(h.execute("event_get", { id: "event-1", grantRef: GRANT }), /arguments are invalid/);
  h.ctx.hasUI = false;
  await assert.rejects(h.execute("event_correct", { id: "event-1", expectedVersion: 1, patch: { title: "x" }, reason: "x" }), /requires UI confirmation/);
});

test("automatic coordination is limited, does not claim user identity and relies on backend authorization", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  h.ctx.hasUI = false;
  const args = { sessionId: "s-2", text: "Assistant patrol: please report progress.", kind: "continue", sourceRefs: ["event-1"] };
  await h.execute("supervisor_coordinate", args);
  const sent = (f.received.at(-1)?.body as { request: { operation: string; args: Record<string, unknown> } }).request;
  assert.equal(sent.operation, "coordinate");
  assert.equal(sent.args.text, args.text);
  assert.equal(h.confirmations, 0);
  f.respondWith((_req, res) => res.writeHead(403).end('{"error":"automatic coordination not authorized"}'));
  await assert.rejects(h.execute("supervisor_coordinate", args), /not authorized/);
  await assert.rejects(h.execute("supervisor_coordinate", { ...args, text: "x".repeat(1025) }), /arguments are invalid/);
  await assert.rejects(h.execute("supervisor_coordinate", { ...args, actor: "user" }), /arguments are invalid/);
});

test("a plain 确认 typed in the chat approves the asked request without a popup", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  const args = { uid: "local:t-1", status: "done", evidence: "验收 1 通过" };
  // Turn 1: the user only said what to do, so the popup asks. Dismissing it must not approve anything.
  await h.emit("before_agent_start", { prompt: "[supervisor-user-grant:11111111-2222-3333-4444-555555555555]\n把任务标成完成" });
  h.confirm(false);
  await assert.rejects(h.execute("supervisor_task_update", args), /操作确认未通过/);
  assert.equal(h.confirmations, 1);
  assert.equal(f.received.some(item => (item.body as { confirmed?: boolean })?.confirmed === true), false);
  // Turn 2: the same operation after the user types "确认" needs no popup and carries confirmed:true.
  f.received.length = 0;
  await h.emit("before_agent_start", { prompt: "确认" });
  await h.execute("supervisor_task_update", args);
  assert.equal(h.confirmations, 1);
  const executed = f.received.filter(item => (item.body as { request?: { operation?: string } })?.request?.operation === "task_update");
  assert.equal(executed.length, 1);
  assert.equal((executed[0].body as { confirmed?: boolean }).confirmed, true);
});

test("a typed 确认 never authorizes a different or ambiguous operation", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  const args = { uid: "local:t-1", status: "done", evidence: "验收 1 通过" };
  await h.emit("before_agent_start", { prompt: "把任务标成完成" });
  h.confirm(false);
  await assert.rejects(h.execute("supervisor_task_update", args), /操作确认未通过/);
  // Same word, different target: still a popup, never a silent approval.
  await h.emit("before_agent_start", { prompt: "确认" });
  h.confirm(false);
  await assert.rejects(h.execute("supervisor_task_update", { ...args, uid: "local:t-2" }), /操作确认未通过/);
  assert.equal(h.confirmations, 2);
  // A sentence that merely contains 确认 is not a bare confirmation either.
  await h.emit("before_agent_start", { prompt: "确认一下顺便把别的也改了吧" });
  h.confirm(false);
  await assert.rejects(h.execute("supervisor_task_update", args), /操作确认未通过/);
  assert.equal(h.confirmations, 3);
  // An explicit refusal disarms the pending request.
  await h.emit("before_agent_start", { prompt: "不要" });
  await h.emit("before_agent_start", { prompt: "确认" });
  h.confirm(false);
  await assert.rejects(h.execute("supervisor_task_update", args), /操作确认未通过/);
  assert.equal(h.confirmations, 4);
});

test("confirmation text is specific and never exposes credentials", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  await h.emit("before_agent_start", { prompt: `[supervisor-user-grant:${GRANT}]` });
  await h.execute("event_correct", { id: "event-1", expectedVersion: 1, patch: { title: f.credentials.token }, reason: f.filePath });
  assert.match(h.confirmationTexts[0], /event-1/);
  assert.match(h.confirmationTexts[0], /redacted/);
  assert.equal(h.confirmationTexts[0].includes(f.credentials.token), false);
  assert.equal(h.confirmationTexts[0].includes(f.filePath), false);
});

test("automatic patrol cannot open completion or destructive correction confirmations", async (t) => {
  const f = await fixture(t); const h = harness(f.filePath);
  await h.emit("session_start"); await h.emit("before_agent_start", { prompt: `${AUTO_PATROL_TAG}automatic patrol` });
  await assert.rejects(h.execute("event_correct", { id: "event-1", expectedVersion: 1, patch: { title: "wrong" }, reason: "Unrequested automatic correction" }), /current user turn/);
  await assert.rejects(h.execute("supervisor_task_update", { uid: "local:task-1", status: "done", evidence: "tests" }), /current user turn/);
  assert.equal(h.confirmations, 0);
});

test("confirmation cannot carry a stale grant into another turn and shutdown clears readiness", async (t) => {
  const f = await fixture(t);
  const h = harness(f.filePath);
  await h.emit("session_start");
  await h.emit("before_agent_start", { prompt: `[supervisor-user-grant:${GRANT}]` });
  h.confirmWith(async () => {
    await h.emit("before_agent_start", { prompt: `${AUTO_PATROL_TAG}patrol` });
    return true;
  });
  const before = f.received.length;
  await assert.rejects(h.execute("event_correct", { id: "event-1", expectedVersion: 1, patch: { title: "x" }, reason: "x" }), /turn changed/);
  assert.equal(f.received.length, before);
  await h.emit("session_shutdown");
  await assert.rejects(h.execute("supervisor_context"), /not ready/);
});
