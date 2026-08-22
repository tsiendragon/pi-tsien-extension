import { createConnection, type Socket } from "node:net";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  SubagentWorkbenchRuntime,
  WorkbenchCommand,
  WorkbenchCommandResult,
} from "./runtime.ts";

const BRIDGE_SYMBOL = Symbol.for("pi.dashboard.extension-bridge.v1");
const API_VERSION = 1 as const;
const RECONNECT_MS = 1_000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

type Adapter = {
  readonly feature: "subagent-workbench";
  readonly apiVersion: typeof API_VERSION;
  getSnapshot(): unknown;
  subscribe(listener: (snapshot: unknown) => void): () => void;
  dispatch(command: unknown): Promise<unknown>;
};

type Capability = {
  readonly apiVersion: typeof API_VERSION;
  register(adapter: Adapter): () => void;
};

function capability(ctx: ExtensionContext): Capability | undefined {
  const value = (ctx.sessionManager as unknown as Record<PropertyKey, unknown>)[
    BRIDGE_SYMBOL
  ];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<Capability>;
  return candidate.apiVersion === API_VERSION &&
    typeof candidate.register === "function"
    ? (candidate as Capability)
    : undefined;
}

function isCommand(value: unknown): value is WorkbenchCommand {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

export function registerWorkbenchDashboardBridge(
  ctx: ExtensionContext,
  runtime: SubagentWorkbenchRuntime,
  ensureController: () => void,
): () => void {
  const adapter: Adapter = {
    feature: "subagent-workbench",
    apiVersion: API_VERSION,
    getSnapshot: () => runtime.getSnapshot(),
    subscribe: (listener) => runtime.subscribe(listener),
    async dispatch(command: unknown): Promise<WorkbenchCommandResult> {
      if (!isCommand(command)) return { ok: false, error: "invalid_command" };
      ensureController();
      return runtime.dispatch(command);
    },
  };

  const direct = capability(ctx);
  if (direct) return direct.register(adapter);

  const socketPath = process.env.PI_DASH_BRIDGE_SOCKET;
  const token = process.env.PI_DASH_BRIDGE_TOKEN;
  if (!socketPath || !token || process.env.PI_RUNTIME !== "dashboard") {
    return () => {};
  }

  let active = true;
  let socket: Socket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let buffer = "";

  const send = (message: unknown): void => {
    if (socket && !socket.destroyed && socket.writable) {
      socket.write(`${JSON.stringify(message)}\n`);
    }
  };

  const unsubscribe = runtime.subscribe((snapshot) => {
    send({ type: "snapshot", feature: adapter.feature, snapshot });
  });

  const connect = (): void => {
    if (!active) return;
    buffer = "";
    socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      send({
        type: "register",
        token,
        feature: adapter.feature,
        apiVersion: API_VERSION,
        snapshot: runtime.getSnapshot(),
      });
    });
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer, "utf8") > MAX_BUFFER_BYTES) {
        socket?.destroy(new Error("Dashboard bridge message exceeds limit"));
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          socket?.destroy(new Error("Invalid Dashboard bridge JSON"));
          return;
        }
        if (message?.type !== "command" || !isCommand(message.command)) continue;
        void adapter.dispatch(message.command).then(
          (result) => send({ type: "result", requestId: message.requestId, result }),
          (error) =>
            send({
              type: "error",
              requestId: message.requestId,
              error: {
                code: "workbench_command_failed",
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      socket = undefined;
      if (!active) return;
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
      reconnectTimer.unref?.();
    });
  };

  connect();
  return () => {
    if (!active) return;
    active = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    unsubscribe();
    send({ type: "unregister", feature: adapter.feature });
    socket?.destroy();
    socket = undefined;
  };
}
