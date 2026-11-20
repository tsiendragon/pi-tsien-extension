import { describe, expect, it, vi } from "vitest";
import { evaluateGoal, evaluatorModels, handoffAction, DEFAULT_GOAL_EVALUATORS } from "pi-tsien-goal/src/evaluator.ts";
import { registerGoalRuntime } from "pi-tsien-goal/src/runtime.ts";
import { saveGoalState } from "pi-tsien-goal/src/state.ts";

describe("goal evaluator", () => {
	it("falls back on a quota error and invalid decision in configured order", async () => {
		const models = evaluatorModels(DEFAULT_GOAL_EVALUATORS);
		const ask = vi.fn().mockRejectedValueOnce(new Error("quota")).mockResolvedValueOnce('{"decision":"wait","reason":"no wake condition"}').mockResolvedValueOnce('{"decision":"continue","reason":"new evidence","action":"collect result"}');
		const answer = await evaluateGoal(models, "{}", new AbortController().signal, ask);
		expect(ask.mock.calls.map(call => call[0])).toEqual(models);
		expect(answer).toEqual({ decision: "continue", reason: "new evidence", action: "collect result", model: models[2] });
	});

	it("falls back after a hung provider and never switches provider after cancellation", async () => {
		const models = ["a/m", "b/m"];
		const control = new AbortController();
		const ask = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce('{"decision":"wait","reason":"job pending","wake":"job j finishes"}');
		expect((await evaluateGoal(models, "{}", control.signal, ask, 5))?.model).toBe(models[1]);
		expect(ask.mock.calls[0][2].aborted).toBe(true);
		const hanging = vi.fn(() => new Promise<string>(() => {}));
		const pending = evaluateGoal(models, "{}", control.signal, hanging);
		await Promise.resolve();
		control.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(hanging).toHaveBeenCalledOnce();
	});

	it("only accepts a checkpoint handoff with a currently ready item", () => {
		const line = 'GOAL_NEXT: {"end":"checkpoint","itemId":"w1","action":"Test a different route"}';
		expect(handoffAction(line, ["w1"])).toBe("Test a different route");
		expect(handoffAction(line, ["w2"])).toBeUndefined();
		expect(handoffAction(line, ["w1"], true)).toBeUndefined();
		expect(handoffAction(line.replace(/}$/, ',"proofJobDependencies":[]}'), ["w1"], true)).toBe("Test a different route");
		expect(handoffAction(line.replace(/}$/, ',"proofJobDependencies":["pj-1"]}'), ["w1"], true)).toBeUndefined();
		expect(handoffAction(line.replace("checkpoint", "wait"), ["w1"])).toBeUndefined();
		expect(handoffAction(`${line}\n${line}`, ["w1"])).toBeUndefined();
	});

	it.each(["wait", "continue", "unavailable", "handoff"]) ("collects a matching terminal event once after evaluator %s", async (decision) => {
		const independent = decision === "continue";
		const fallback = decision === "handoff";
		const branch: unknown[] = [];
		saveGoalState({ appendEntry(customType, data) { branch.push({ type: "custom", id: "goal-entry", customType, data }); } }, {
			action: "create", goalId: "g", now: 1, objective: "Finish proof review", acceptanceCriteria: ["Inspect the review"],
		}, null);
		const handlers = new Map<string, Function>();
		const events = new Map<string, Function>();
		const sendUserMessage = vi.fn();
		const appendEntry = vi.fn();
		const stream = vi.fn(() => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: decision === "unavailable" || fallback ? 'malformed' : independent ? '{"decision":"continue","reason":"Independent work remains","action":"Check the diagonal case"}' : '{"decision":"wait","reason":"Review needed","wake":"Job j finishes"}' }] }) }));
		const ctx = {
			isIdle: () => true,
			sessionManager: { getBranch: () => branch, getSessionId: () => "session", getLeafId: () => "leaf" },
			modelRegistry: { find: () => ({}), getProvider: () => ({ stream }), getApiKeyAndHeaders: async () => ({ ok: true }), getProviderAuth: async () => undefined },
		};
		registerGoalRuntime({
			on: (name: string, handler: Function) => handlers.set(name, handler),
			events: { on: (name: string, handler: Function) => events.set(name, handler) },
			getFlag: (flag: string) => flag === "goal-evaluator-models" ? "provider/model" : undefined,
			sendUserMessage, appendEntry,
		} as never);
		try {
			await handlers.get("session_start")!({}, ctx);
			const statusOnly = await handlers.get("before_agent_start")!({ prompt: "Only report status", systemPrompt: "original" }, ctx);
			expect(statusOnly.systemPrompt).toBeUndefined();
			const started = await handlers.get("before_agent_start")!({ prompt: "继续目标", systemPrompt: "original" }, ctx);
			expect(started.systemPrompt).toContain("original\n\nAt the end of a goal execution run");
			await handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Unrelated analysis\nGOAL_HANDOFF\nReady now: none until review j finishes" }] }] }, ctx);
			const job = events.get("pimatrix:proof-job")!;
			if (fallback) {
				const ready = /\(([^()]+)\)$/m.exec(started.message.content.split("Work items:")[1].split("Structured blockers:")[0])?.[1];
				expect(ready).toBeTruthy();
				job({ sessionId: "session", id: "j", label: "review T", state: "pending" });
				const handoff = async (action: string) => {
					await handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `GOAL_HANDOFF\nGOAL_NEXT: ${JSON.stringify({ end: "checkpoint", itemId: ready, action, proofJobDependencies: [] })}` }] }] }, ctx);
					await handlers.get("agent_settled")!({}, ctx);
				};
				await handoff("Test the diagonal case");
				await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
				expect(appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ source: "handoff" }));
				await handlers.get("input")!({ text: "继续目标", source: "extension" }, ctx);
				await handoff("Test a different case");
				await vi.waitFor(() => expect(appendEntry).toHaveBeenCalledWith("goal-evaluation", expect.objectContaining({ decision: "unavailable", action: undefined })));
				expect(sendUserMessage).toHaveBeenCalledOnce();
				return;
			}
			job({ sessionId: "session", id: "j", label: "review T", state: "pending" });
			await handlers.get("agent_settled")!({}, ctx);
			await vi.waitFor(() => expect(appendEntry).toHaveBeenCalledWith("goal-evaluation", expect.objectContaining({ decision })));
			if (decision === "unavailable") expect(appendEntry).toHaveBeenCalledWith("goal-evaluation", expect.objectContaining({ failures: [{ model: "provider/model", kind: "invalid-response" }] }));
			if (independent) {
				expect(sendUserMessage).toHaveBeenCalledOnce();
				await handlers.get("input")!({ text: "继续目标", source: "extension" }, ctx);
				sendUserMessage.mockClear();
			} else expect(sendUserMessage).not.toHaveBeenCalled();
			job({ sessionId: "other", id: "j", state: "finished" });
			expect(sendUserMessage).not.toHaveBeenCalled();
			job({ sessionId: "session", id: "j", state: "finished" });
			job({ sessionId: "session", id: "j", state: "finished" });
			await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
			expect(stream).toHaveBeenCalledOnce();
			const [, request] = stream.mock.calls[0] as unknown as [unknown, { messages: { content: string }[] }];
			const snapshot = JSON.parse(request.messages[0].content);
			expect(snapshot.latestAssistantHandoff).toBe("GOAL_HANDOFF\nReady now: none until review j finishes");
			expect(snapshot.jobs).toEqual([{ id: "j", label: "review T", state: "pending" }]);
			expect(appendEntry).toHaveBeenCalledWith("goal-continuation", expect.objectContaining({ action: "queued", source: "proof-job" }));
			expect(sendUserMessage).toHaveBeenCalledWith("继续目标", { deliverAs: "followUp" });
		} finally {
			await handlers.get("session_shutdown")!({}, ctx);
		}
	});
});
