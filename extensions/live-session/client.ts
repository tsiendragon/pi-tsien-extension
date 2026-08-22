import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import {
  LIVE_SESSION_PROTOCOL_VERSION,
  MAX_COMMAND_BYTES,
  MAX_CONNECTION_BUFFER_BYTES,
  MAX_EVENT_BYTES,
  MAX_SNAPSHOT_BYTES,
  REQUEST_CACHE_SIZE,
  encodedBytes,
  failure,
  parseBrokerMessage,
  success,
  type CommandEnvelope,
  type CommandExecutionResult,
  type CommandResultMessage,
  type EventMessage,
  type ExtensionToBrokerMessage,
  type HelloMessage,
  type JsonValue,
  type SnapshotMessage,
} from "./protocol.ts";

const DEFAULT_RUNTIME_DIR = join(homedir(), ".pi", "agent", "run", "pi-dashboard");
const DEFAULT_RECONNECT_DELAYS = [250, 500, 1000, 2000, 5000, 10_000, 30_000] as const;

interface PendingFrame {
  readonly line: string;
  readonly bytes: number;
}

export interface LiveSessionClientOptions {
  readonly processInstanceId: string;
  readonly socketPath?: string;
  readonly brokerTokenPath?: string;
  readonly reconnectDelaysMs?: readonly number[];
  readonly random?: () => number;
  readonly getHello: (brokerToken: string) => HelloMessage;
  readonly getSnapshot: () => SnapshotMessage;
  readonly executeCommand: (envelope: CommandEnvelope) => Promise<CommandExecutionResult>;
  readonly onConnected?: () => void;
  readonly onDisconnected?: () => void;
}

export class LiveSessionClient {
  private readonly options: LiveSessionClientOptions;
  private readonly socketPath: string;
  private readonly brokerTokenPath: string;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly random: () => number;
  private socket?: Socket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private active = false;
  private connecting = false;
  private ready = false;
  private inputBuffer = "";
  private reconnectAttempt = 0;
  private blocked = false;
  private pendingBytes = 0;
  private readonly pendingCritical: PendingFrame[] = [];
  private readonly pendingUpdates = new Map<string, PendingFrame>();
  private readonly requestCache = new Map<string, Promise<CommandResultMessage>>();

  constructor(options: LiveSessionClientOptions) {
    this.options = options;
    this.socketPath = options.socketPath ?? join(DEFAULT_RUNTIME_DIR, "live-sessions.sock");
    this.brokerTokenPath = options.brokerTokenPath ?? join(DEFAULT_RUNTIME_DIR, "live-broker-token");
    this.reconnectDelaysMs = options.reconnectDelaysMs?.length
      ? options.reconnectDelaysMs
      : DEFAULT_RECONNECT_DELAYS;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    void this.connect();
  }

  publish(message: EventMessage): void {
    if (!this.ready || !this.socket) return;
    if (encodedBytes(message) > MAX_EVENT_BYTES) {
      this.disconnectForOverflow("Live Session event exceeds limit");
      return;
    }
    this.sendMessage(message, this.coalesceKey(message));
  }

  sendSnapshot(): void {
    if (!this.ready || !this.socket) return;
    const snapshot = this.options.getSnapshot();
    if (encodedBytes(snapshot) > MAX_SNAPSHOT_BYTES) {
      this.disconnectForOverflow("Live Session snapshot exceeds limit");
      return;
    }
    this.sendMessage(snapshot);
  }

  stop(reason = "session_shutdown"): void {
    if (!this.active) return;
    this.active = false;
    this.ready = false;
    this.connecting = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && !socket.destroyed) {
      const goodbye: ExtensionToBrokerMessage = {
        type: "goodbye",
        processInstanceId: this.options.processInstanceId,
        reason,
      };
      socket.end(`${JSON.stringify(goodbye)}\n`);
    }
    this.clearPending();
  }

  private async connect(): Promise<void> {
    if (!this.active || this.connecting || this.socket) return;
    this.connecting = true;
    try {
      const brokerToken = (await readFile(this.brokerTokenPath, "utf8")).trim();
      if (!brokerToken || Buffer.byteLength(brokerToken, "utf8") > 8192) throw new Error("Invalid broker token");
      if (!this.active) return;
      const socket = createConnection(this.socketPath);
      this.socket = socket;
      this.inputBuffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        const hello = this.options.getHello(brokerToken);
        if (hello.protocolVersion !== LIVE_SESSION_PROTOCOL_VERSION) {
          socket.destroy(new Error("Invalid Live Session protocol version"));
          return;
        }
        this.sendMessage(hello);
      });
      socket.on("data", (chunk: string | Buffer) => this.handleData(String(chunk)));
      socket.on("drain", () => {
        this.blocked = false;
        this.flushPending();
      });
      socket.on("error", () => {});
      socket.on("close", () => this.handleClose(socket));
    } catch {
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private handleData(chunk: string): void {
    this.inputBuffer += chunk;
    if (Buffer.byteLength(this.inputBuffer, "utf8") > MAX_CONNECTION_BUFFER_BYTES) {
      this.disconnectForOverflow("Live Session receive buffer exceeds limit");
      return;
    }
    let newline = this.inputBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.inputBuffer.slice(0, newline);
      this.inputBuffer = this.inputBuffer.slice(newline + 1);
      if (line.trim()) this.handleLine(line);
      if (!this.socket || this.socket.destroyed) return;
      newline = this.inputBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_COMMAND_BYTES) {
      this.disconnectForOverflow("Live Session command exceeds limit");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.socket?.destroy(new Error("Invalid Live Session JSON"));
      return;
    }
    const message = parseBrokerMessage(parsed);
    if (!message) {
      this.socket?.destroy(new Error("Invalid Live Session broker message"));
      return;
    }
    if (message.type === "reject") {
      this.socket?.destroy();
      return;
    }
    if (message.type === "welcome") {
      this.ready = true;
      this.reconnectAttempt = 0;
      this.startHeartbeat(message.heartbeatMs);
      this.options.onConnected?.();
      this.sendSnapshot();
      return;
    }
    void this.handleCommand(message);
  }

  private async handleCommand(envelope: CommandEnvelope): Promise<void> {
    const cached = this.requestCache.get(envelope.requestId);
    if (cached) {
      this.sendMessage(await cached);
      return;
    }

    const pending = this.executeEnvelope(envelope);
    this.requestCache.set(envelope.requestId, pending);
    while (this.requestCache.size > REQUEST_CACHE_SIZE) {
      const oldest = this.requestCache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.requestCache.delete(oldest);
    }
    this.sendMessage(await pending);
  }

  private async executeEnvelope(envelope: CommandEnvelope): Promise<CommandResultMessage> {
    if (envelope.processInstanceId !== this.options.processInstanceId) {
      return failure(envelope.requestId, "wrong_process_instance", "Command targets another process instance");
    }
    try {
      if (envelope.command.type === "resync") {
        this.sendSnapshot();
        return success(envelope.requestId, { resynced: true });
      }
      const result = await this.options.executeCommand(envelope);
      return result.ok
        ? success(envelope.requestId, result.result)
        : failure(envelope.requestId, result.error.code, result.error.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(envelope.requestId, "command_failed", message);
    }
  }

  private sendMessage(message: ExtensionToBrokerMessage, updateKey?: string): void {
    const line = `${JSON.stringify(message)}\n`;
    const frame = { line, bytes: Buffer.byteLength(line, "utf8") };
    if (this.blocked) {
      this.enqueue(frame, updateKey);
      return;
    }
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return;
    try {
      this.blocked = !socket.write(line);
      if (socket.writableLength > MAX_CONNECTION_BUFFER_BYTES) {
        this.disconnectForOverflow("Live Session write buffer exceeds limit");
      }
    } catch {
      socket.destroy();
    }
  }

  private enqueue(frame: PendingFrame, updateKey?: string): void {
    if (updateKey) {
      const previous = this.pendingUpdates.get(updateKey);
      if (previous) this.pendingBytes -= previous.bytes;
      this.pendingUpdates.set(updateKey, frame);
    } else {
      this.pendingCritical.push(frame);
    }
    this.pendingBytes += frame.bytes;
    if (this.pendingBytes > MAX_CONNECTION_BUFFER_BYTES) {
      this.disconnectForOverflow("Live Session pending buffer exceeds limit");
    }
  }

  private flushPending(): void {
    while (!this.blocked && this.pendingCritical.length > 0) {
      const frame = this.pendingCritical.shift();
      if (!frame) break;
      this.pendingBytes -= frame.bytes;
      this.writeFrame(frame);
    }
    while (!this.blocked && this.pendingUpdates.size > 0) {
      const first = this.pendingUpdates.entries().next().value as [string, PendingFrame] | undefined;
      if (!first) break;
      this.pendingUpdates.delete(first[0]);
      this.pendingBytes -= first[1].bytes;
      this.writeFrame(first[1]);
    }
  }

  private writeFrame(frame: PendingFrame): void {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return;
    try {
      this.blocked = !socket.write(frame.line);
      if (socket.writableLength > MAX_CONNECTION_BUFFER_BYTES) {
        this.disconnectForOverflow("Live Session write buffer exceeds limit");
      }
    } catch {
      socket.destroy();
    }
  }

  private coalesceKey(message: EventMessage): string | undefined {
    if (message.event.type !== "message_update" && message.event.type !== "tool_execution_update") return undefined;
    const id = message.event.data.messageId ?? message.event.data.toolCallId ?? message.event.data.id;
    return typeof id === "string" ? `${message.event.type}:${id}` : message.event.type;
  }

  private startHeartbeat(heartbeatMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendMessage({
        type: "heartbeat",
        processInstanceId: this.options.processInstanceId,
        at: Date.now(),
      });
    }, heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private handleClose(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    const wasReady = this.ready;
    this.ready = false;
    this.blocked = false;
    this.stopHeartbeat();
    this.clearPending();
    if (wasReady) this.options.onDisconnected?.();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer) return;
    const index = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1);
    const base = this.reconnectDelaysMs[index] ?? 30_000;
    this.reconnectAttempt += 1;
    const jitter = 0.8 + this.random() * 0.4;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, Math.max(1, Math.round(base * jitter)));
    this.reconnectTimer.unref?.();
  }

  private disconnectForOverflow(message: string): void {
    this.clearPending();
    this.socket?.destroy(new Error(message));
  }

  private clearPending(): void {
    this.pendingCritical.length = 0;
    this.pendingUpdates.clear();
    this.pendingBytes = 0;
  }
}

export function jsonResult(value: JsonValue): CommandExecutionResult {
  return { ok: true, result: value };
}
