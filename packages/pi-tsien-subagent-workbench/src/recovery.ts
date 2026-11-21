import { classifyError } from "./model-router.ts";

export const SUBAGENT_START_GUIDELINES = [
  "Use subagent_start for one independent, verifiable task: challenge one lemma, check one baseline, or audit one saved result. Run independent checks in parallel only when useful; give writing tasks disjoint paths. Do a trivial read or check directly instead of delegating it.",
  "For subagent_start, name the minimum inputs, exact question, expected evidence, and stopping condition. timeoutMs covers reading, reasoning, tools, and handoff, not just script runtime. Reserve short budgets for single checks; when work cannot fit, narrow the scope or use subagent_workflow instead of merely raising the timeout.",
];

export const SUBAGENT_WORKFLOW_GUIDELINES = [
  "Use subagent_workflow for dependent steps, resumable work, or a single task that benefits from targeted retry. Split stages by dependency (e.g. freeze the protocol, execute the replay, independently verify); parallelize only independent tasks within a stage. Pass stable artifact paths and compact findings to later stages rather than making them rediscover inputs.",
  "For subagent_workflow, agree on deliverables and save a verifiable checkpoint before the final report. For long deterministic experiments, separate preparation, bounded background execution, and verification; do not spend a child turn waiting on compute that a background command can track. Before retry_task, check live commands and saved evidence, then pass verified checkpoint paths in resumeContext and reuse finished siblings.",
];

export const SUBAGENT_RESULTS_GUIDELINES = [
  "Use subagent_results by workId to collect a finished job once; continue independent work instead of polling repeatedly. Use a bounded wait only when the result is the next dependency. Treat partial text as unverified, and distinguish a timeout or quota failure from a negative result.",
];

export function diagnoseFailure(error: string | undefined, taskKey?: string) {
  const code = classifyError(error).errorClass;
  if (code === "timeout") {
    const ms = /exceeded hard wall time (\d+) ms/i.exec(error ?? "")?.[1];
    return {
      code,
      ...(ms ? { wallTimeMs: Number(ms) } : {}),
      checkpoint: "unknown" as const,
      advice: "The whole child turn exceeded its budget; this is not a negative research result. Check saved files and any running commands first. If needed, request bounded partial output with explicit workIds (unverified). Split the remaining work or allow a justified larger budget." +
        (taskKey ? ` Retry only ${taskKey} with retry_task and pass verified checkpoint paths in resumeContext; completed siblings are reused.` : " Resume from verified artifacts in a fresh task; do not blindly rerun."),
    };
  }
  if (code === "quota_exhausted" || code === "rate_limited") {
    return { code, advice: "Inspect /subagent-models for cooldowns or an authorized candidate with an independent quota. Do not retry immediately against the same exhausted quota." };
  }
  if (code === "auth" || code === "not_found") {
    return { code, advice: "Verify credentials and model configuration before retrying." };
  }
  return undefined;
}
