import assert from "node:assert/strict";
import test from "node:test";
import { serializeTraceContext } from "pi-tsien-subagent-workbench/src/providers/pi-rpc-process-provider.ts";
import { parseTraceContext } from "pi-tsien-trajectory-recorder/src/index.ts";

test("serializes the parent/workflow trace context for child Pi processes", () => {
  const serialized = serializeTraceContext({
    parentSessionId: "parent-session",
    parentToolCallId: "parent-tool-call",
    parentWorkflowId: "ancestor-workflow",
    parentWorkId: "ancestor-work",
    parentTaskId: "ancestor-task",
    workflowId: "workflow-1",
    workId: "work-1",
    taskKey: "task-a",
    stageIndex: 2,
    iterationIndex: 1,
  });
  assert.ok(serialized);
  assert.deepEqual(JSON.parse(serialized), {
    parentSessionId: "parent-session",
    parentToolCallId: "parent-tool-call",
    parentWorkflowId: "ancestor-workflow",
    parentWorkId: "ancestor-work",
    parentTaskId: "ancestor-task",
    workflowId: "workflow-1",
    workId: "work-1",
    taskKey: "task-a",
    stageIndex: 2,
    iterationIndex: 1,
  });
  assert.equal(serializeTraceContext(undefined), undefined);
  assert.deepEqual(parseTraceContext(serialized), {
    parentSessionId: "parent-session",
    parentToolCallId: "parent-tool-call",
    parentWorkflowId: "ancestor-workflow",
    parentWorkId: "ancestor-work",
    parentTaskId: "ancestor-task",
    workflowId: "workflow-1",
    workId: "work-1",
    taskKey: "task-a",
    stageIndex: 2,
    iterationIndex: 1,
  });
  assert.equal(parseTraceContext("not-json"), undefined);
});
