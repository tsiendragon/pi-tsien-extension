let buffer = "";
const history = [];
let pendingSlow = false;
let abortMode = "success";
let progressTimer;

const sigtermDelay = Number(process.env.FAKE_RPC_SIGTERM_DELAY_MS ?? 0);
if (sigtermDelay > 0) {
  let scheduled = false;
  process.on("SIGTERM", () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => process.exit(0), sigtermDelay);
  });
}

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function assistant(text, stopReason = "stop") {
  send({ type: "agent_start" });
  send({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: text,
    },
  });
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      provider: "fake",
      model: "fake-rpc",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.001 },
      },
      stopReason,
    },
  });
  send({ type: "agent_settled" });
}

function timelineAssistant() {
  send({ type: "agent_start" });
  send({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  send({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "Inspecting the repository",
    },
  });
  send({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "I will read the source.",
    },
  });
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspecting the repository" },
        { type: "text", text: "I will read the source." },
        {
          type: "toolCall",
          id: "call-read",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
      provider: "fake",
      model: "fake-rpc",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.001 },
      },
      stopReason: "toolUse",
    },
  });
  send({
    type: "tool_execution_start",
    toolCallId: "call-read",
    toolName: "read",
    args: { path: "README.md" },
  });
  send({
    type: "tool_execution_update",
    toolCallId: "call-read",
    toolName: "read",
    args: { path: "README.md" },
    partialResult: {
      content: [{ type: "text", text: "partial README" }],
    },
  });
  send({
    type: "tool_execution_end",
    toolCallId: "call-read",
    toolName: "read",
    result: { content: [{ type: "text", text: "complete README" }] },
    isError: false,
  });
  send({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  send({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Inspection complete.",
    },
  });
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Inspection complete." }],
      provider: "fake",
      model: "fake-rpc",
      usage: {
        input: 5,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.001 },
      },
      stopReason: "stop",
    },
  });
  send({ type: "agent_settled" });
}

function progressingTool(totalMs, intervalMs) {
  pendingSlow = true;
  abortMode = "success";
  send({ type: "agent_start" });
  send({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  send({
    type: "tool_execution_start",
    toolCallId: "call-long-running",
    toolName: "bash",
    args: { command: "long-running" },
  });
  let elapsedMs = 0;
  progressTimer = setInterval(() => {
    elapsedMs += intervalMs;
    send({
      type: "tool_execution_update",
      toolCallId: "call-long-running",
      toolName: "bash",
      args: { command: "long-running" },
      partialResult: {
        content: [{ type: "text", text: `progress:${elapsedMs}` }],
      },
    });
    if (elapsedMs < totalMs) return;
    clearInterval(progressTimer);
    progressTimer = undefined;
    pendingSlow = false;
    send({
      type: "tool_execution_end",
      toolCallId: "call-long-running",
      toolName: "bash",
      result: { content: [{ type: "text", text: "complete" }] },
      isError: false,
    });
    send({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "progress complete" }],
        provider: "fake",
        model: "fake-rpc",
        usage: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.001 },
        },
        stopReason: "stop",
      },
    });
    send({ type: "agent_settled" });
  }, intervalMs);
}

function promptOutput(message) {
  if (message === "report-argv") {
    return JSON.stringify(process.argv.slice(2));
  }
  if (message.includes("what was remembered")) {
    const remembered = history.find((item) => item.startsWith("remember:"));
    return remembered ? remembered.slice("remember:".length).trim() : "missing";
  }
  const context = message.match(
    /<explicit_context>\n([\s\S]*?)\n<\/explicit_context>/,
  )?.[1];
  if (context) return `context:${context}`;
  return `pid:${process.pid};turn:${history.length};${message}`;
}

function handle(command) {
  if (command.type === "get_state") {
    const respond = () =>
      send({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          model: { provider: "fake", id: "fake-rpc" },
          thinkingLevel: "off",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionId: `fake-${process.pid}`,
          autoCompactionEnabled: true,
          messageCount: history.length,
          pendingMessageCount: 0,
        },
      });
    const delay = Number(process.env.FAKE_RPC_STARTUP_DELAY_MS ?? 0);
    if (delay > 0) setTimeout(respond, delay);
    else respond();
    return;
  }
  if (command.type === "prompt") {
    send({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
    });
    history.push(command.message);
    if (command.message === "crash-now") {
      setTimeout(() => process.exit(41), 5);
      return;
    }
    const progressing = command.message.match(/^progress-for:(\d+):(\d+)$/);
    if (progressing) {
      progressingTool(Number(progressing[1]), Number(progressing[2]));
      return;
    }
    const continuousProgress = command.message.match(
      /^continuous-progress:(\d+)$/,
    );
    if (continuousProgress) {
      progressingTool(Number.POSITIVE_INFINITY, Number(continuousProgress[1]));
      return;
    }
    if (
      command.message === "wait-for-abort" ||
      command.message === "wait-for-abort-timeout" ||
      command.message === "wait-for-abort-write-failure"
    ) {
      pendingSlow = true;
      abortMode = command.message.endsWith("timeout")
        ? "timeout"
        : command.message.endsWith("write-failure")
          ? "write-failure"
          : "success";
      send({ type: "agent_start" });
      if (abortMode === "write-failure") {
        setInterval(() => {}, 1_000);
        process.stdin.destroy();
      }
      return;
    }
    if (command.message === "timeline-events") {
      queueMicrotask(timelineAssistant);
    } else {
      queueMicrotask(() => assistant(promptOutput(command.message)));
    }
    return;
  }
  if (command.type === "abort") {
    if (abortMode === "timeout") return;
    send({
      id: command.id,
      type: "response",
      command: "abort",
      success: true,
    });
    if (pendingSlow) {
      pendingSlow = false;
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = undefined;
      queueMicrotask(() => assistant("aborted", "aborted"));
    }
    return;
  }
  send({
    id: command.id,
    type: "response",
    command: command.type,
    success: false,
    error: `unsupported:${command.type}`,
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line)
      handle(JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line));
  }
});
