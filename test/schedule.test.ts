import assert from "node:assert/strict";
import test from "node:test";

import scheduleExtension, {
	deliverScheduledTask,
	parseScheduleCommand,
	reminderMessage,
	SCHEDULE_TRIGGER_STATUS_KEY,
	SessionScheduleManager,
	type ScheduleClock,
	updateScheduleTriggerStatus,
} from "../extensions/schedule.ts";

type Timer = {
	at: number;
	callback: () => void;
	cancelled: boolean;
};

class FakeClock implements ScheduleClock {
	private current = 0;
	private readonly timers = new Set<Timer>();

	now(): number {
		return this.current;
	}

	setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
		const timer: Timer = { at: this.current + delayMs, callback, cancelled: false };
		this.timers.add(timer);
		return timer as unknown as ReturnType<typeof setTimeout>;
	}

	clearTimeout(handle: ReturnType<typeof setTimeout>): void {
		(handle as unknown as Timer).cancelled = true;
	}

	advance(delayMs: number): void {
		const target = this.current + delayMs;
		while (true) {
			const next = [...this.timers]
				.filter((timer) => !timer.cancelled && timer.at <= target)
				.sort((left, right) => left.at - right.at)[0];
			if (!next) break;
			this.timers.delete(next);
			this.current = next.at;
			next.callback();
		}
		this.current = target;
	}
}

test("one-shot task fires once and is removed", () => {
	const clock = new FakeClock();
	const delivered: string[] = [];
	const schedules = new SessionScheduleManager((task) => delivered.push(task.id), clock);

	const task = schedules.create({ instruction: "检查当前目标", delayMs: 30_000 });
	assert.equal(task.id, "schedule-1");
	assert.equal(schedules.list().length, 1);

	clock.advance(29_999);
	assert.deepEqual(delivered, []);
	clock.advance(1);
	assert.deepEqual(delivered, ["schedule-1"]);
	assert.deepEqual(schedules.list(), []);
});

test("recurring task schedules the next run and cancellation stops it", () => {
	const clock = new FakeClock();
	let delivered = 0;
	const schedules = new SessionScheduleManager(() => { delivered += 1; }, clock);
	const task = schedules.create({ instruction: "汇报进度", delayMs: 10, intervalMs: 10 });

	clock.advance(10);
	clock.advance(10);
	assert.equal(delivered, 2);
	assert.equal(schedules.cancel(task.id), true);
	clock.advance(100);
	assert.equal(delivered, 2);
});

test("dispose cancels all outstanding session tasks", () => {
	const clock = new FakeClock();
	let delivered = 0;
	const schedules = new SessionScheduleManager(() => { delivered += 1; }, clock);
	schedules.create({ instruction: "不应触发", delayMs: 10 });
	schedules.dispose();
	clock.advance(10);
	assert.equal(delivered, 0);
	assert.deepEqual(schedules.list(), []);
});

test("scheduled instructions wake idle agents and queue behind busy agents", () => {
	const sent: Array<{ message: string; options?: { deliverAs: "followUp" } }> = [];
	const pi = {
		sendUserMessage(message: string, options?: { deliverAs: "followUp" }) {
			sent.push({ message, options });
		},
	};
	const task = {
		id: "schedule-1",
		title: "继续目标",
		instruction: "继续当前目标的下一步。",
		createdAt: 0,
		nextRunAt: 30_000,
	};

	deliverScheduledTask(pi, { isIdle: () => true }, task);
	deliverScheduledTask(pi, { isIdle: () => false }, task);

	assert.match(sent[0]!.message, /schedule-1/);
	assert.match(reminderMessage(task), /完成或不再适用/);
	assert.equal(sent[0]!.options, undefined);
	assert.deepEqual(sent[1]!.options, { deliverAs: "followUp" });
});

test("pending tasks publish and clear a Powerline extension status", () => {
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const ctx = {
		ui: {
			theme: { fg: (color: string, text: string) => `${color}:${text}` },
			setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
		},
	};
	const first = {
		id: "schedule-1",
		title: "first",
		instruction: "first",
		createdAt: 0,
		nextRunAt: 60_000,
	};
	const second = { ...first, id: "schedule-2", title: "second" };

	updateScheduleTriggerStatus(ctx as never, [first], 0);
	updateScheduleTriggerStatus(ctx as never, [first, second], 0);
	updateScheduleTriggerStatus(ctx as never, [], 0);

	assert.deepEqual(statuses, [
		{ key: SCHEDULE_TRIGGER_STATUS_KEY, value: "warning:⏰ schedule-1 · 1m" },
		{ key: SCHEDULE_TRIGGER_STATUS_KEY, value: "warning:⏰ 2 schedules" },
		{ key: SCHEDULE_TRIGGER_STATUS_KEY, value: undefined },
	]);
});

test("extension shows pending status immediately and clears it when one-shot fires", async () => {
	const tools = new Map<string, any>();
	const events = new Map<string, (...args: any[]) => any>();
	const statuses: Array<string | undefined> = [];
	const sent: string[] = [];
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler),
		sendUserMessage: (message: string) => sent.push(message),
	};
	const ctx = {
		isIdle: () => true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: () => {},
		},
	};

	scheduleExtension(pi as never);
	await events.get("session_start")!({}, ctx);
	await tools.get("schedule").execute("trigger-status", {
		action: "create",
		instruction: "验证状态标记",
		delayMinutes: 0.0002,
	});

	assert.match(statuses.at(-1)!, /^⏰ schedule-1 · 1m$/);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(sent.length, 1);
	assert.equal(statuses.at(-1), undefined);
	await events.get("session_shutdown")!({}, ctx);
});

test("slash list opens a focusable selector for multiple schedules", async () => {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const events = new Map<string, (...args: any[]) => any>();
	const notices: string[] = [];
	let selectorOptions: string[] = [];
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler),
		sendUserMessage: () => {},
	};
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: () => {},
			notify: (message: string) => notices.push(message),
			select: async (_title: string, options: string[]) => {
				selectorOptions = options;
				return options[1];
			},
		},
	};

	scheduleExtension(pi as never);
	await events.get("session_start")!({}, ctx);
	await tools.get("schedule").execute("first", {
		action: "create",
		title: "first",
		instruction: "第一项完整指令",
		delayMinutes: 10,
	});
	await tools.get("schedule").execute("second", {
		action: "create",
		title: "second",
		instruction: "第二项完整指令",
		delayMinutes: 20,
	});
	await commands.get("schedule").handler("list", ctx);

	assert.equal(selectorOptions.length, 2);
	assert.match(selectorOptions[0]!, /schedule-1/);
	assert.match(selectorOptions[1]!, /schedule-2/);
	assert.match(notices.at(-1)!, /第二项完整指令/);
	await events.get("session_shutdown")!({}, ctx);
});

test("tool prompt authorizes proactive long-running monitoring without explicit user request", () => {
	let registeredTool: any;
	const pi = {
		registerTool: (tool: any) => { registeredTool = tool; },
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: () => {},
	};

	scheduleExtension(pi as never);
	assert.match(registeredTool.description, /proactively.*long-running work monitoring/i);
	assert.match(registeredTool.description, /Do not use schedule for work that can be completed immediately/);
});

test("slash command parser supports one-shot, recurring, list, and cancel", () => {
	assert.deepEqual(parseScheduleCommand("list"), { action: "list" });
	assert.deepEqual(parseScheduleCommand("cancel schedule-7"), { action: "cancel", id: "schedule-7" });
	assert.deepEqual(parseScheduleCommand("in 30m 检查目标"), {
		action: "create",
		delayMs: 1_800_000,
		instruction: "检查目标",
	});
	assert.deepEqual(parseScheduleCommand("every 2h 汇报进度"), {
		action: "create",
		delayMs: 7_200_000,
		intervalMs: 7_200_000,
		instruction: "汇报进度",
	});
	assert.equal(parseScheduleCommand("tomorrow 做事"), undefined);
});
