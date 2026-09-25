import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clearLiveFeature, publishLiveFeature } from "pi-tsien-shared/src/lib/live-observer.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const SCHEDULE_TRIGGER_STATUS_KEY = "schedule-trigger";

type ScheduleToolDetails = {
	tasks?: ScheduleTask[];
	task?: ScheduleTask;
	id?: string;
	cancelled?: boolean;
};

type ScheduleToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: ScheduleToolDetails;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type ScheduleTask = {
	id: string;
	title: string;
	instruction: string;
	createdAt: number;
	nextRunAt: number;
	intervalMs?: number;
};

export type CreateScheduleTask = {
	title?: string;
	instruction: string;
	delayMs: number;
	intervalMs?: number;
};

export interface ScheduleClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

const systemClock: ScheduleClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle),
};

function copyTask(task: ScheduleTask): ScheduleTask {
	return { ...task };
}

function defaultTitle(instruction: string): string {
	const firstLine = instruction.trim().split(/\r?\n/, 1)[0] ?? "定时任务";
	return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

/** In-memory task scheduler scoped to one live Pi session. */
export class SessionScheduleManager {
	private readonly tasks = new Map<string, ScheduleTask>();
	private readonly timers = new Map<string, TimerHandle>();
	private nextId = 1;
	private disposed = false;

	constructor(
		private readonly onDue: (task: ScheduleTask) => void,
		private readonly clock: ScheduleClock = systemClock,
		private readonly onChanged: (tasks: ScheduleTask[]) => void = () => {},
	) {}

	create(input: CreateScheduleTask): ScheduleTask {
		if (!Number.isFinite(input.delayMs) || input.delayMs <= 0) {
			throw new Error("delayMs 必须是大于 0 的有限数值。");
		}
		if (input.intervalMs !== undefined && (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0)) {
			throw new Error("intervalMs 必须是大于 0 的有限数值。");
		}
		if (!input.instruction.trim()) throw new Error("instruction 不能为空。");
		if (this.disposed) throw new Error("当前 schedule session 已关闭。");

		const createdAt = this.clock.now();
		const task: ScheduleTask = {
			id: `schedule-${this.nextId++}`,
			title: input.title?.trim() || defaultTitle(input.instruction),
			instruction: input.instruction.trim(),
			createdAt,
			nextRunAt: createdAt + input.delayMs,
			...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
		};
		this.tasks.set(task.id, task);
		this.arm(task);
		this.emitChanged();
		return copyTask(task);
	}

	list(): ScheduleTask[] {
		return [...this.tasks.values()]
			.sort((left, right) => left.nextRunAt - right.nextRunAt)
			.map(copyTask);
	}

	cancel(id: string): boolean {
		const timer = this.timers.get(id);
		if (timer) this.clock.clearTimeout(timer);
		this.timers.delete(id);
		const cancelled = this.tasks.delete(id);
		if (cancelled) this.emitChanged();
		return cancelled;
	}

	dispose(): void {
		this.disposed = true;
		for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
		this.timers.clear();
		this.tasks.clear();
		this.emitChanged();
	}

	private arm(task: ScheduleTask): void {
		const delayMs = Math.max(0, task.nextRunAt - this.clock.now());
		const timer = this.clock.setTimeout(() => this.fire(task.id), delayMs);
		this.timers.set(task.id, timer);
	}

	private fire(id: string): void {
		this.timers.delete(id);
		const task = this.tasks.get(id);
		if (!task || this.disposed) return;

		const dueTask = copyTask(task);
		if (task.intervalMs === undefined) {
			this.tasks.delete(id);
			this.emitChanged();
		}

		try {
			this.onDue(dueTask);
		} finally {
			if (task.intervalMs !== undefined && !this.disposed && this.tasks.has(id)) {
				task.nextRunAt = this.clock.now() + task.intervalMs;
				this.arm(task);
				this.emitChanged();
			}
		}
	}

	private emitChanged(): void {
		this.onChanged(this.list());
	}
}

export type ScheduleCommand =
	| { action: "list" }
	| { action: "cancel"; id: string }
	| { action: "create"; delayMs: number; intervalMs?: number; instruction: string };

export function parseScheduleCommand(args: string): ScheduleCommand | undefined {
	const text = args.trim();
	if (!text || text === "list" || text === "列表") return { action: "list" };

	const cancel = text.match(/^(?:cancel|取消)\s+(.+)$/i);
	if (cancel) return { action: "cancel", id: cancel[1]!.trim() };

	const create = text.match(/^(in|after|every)\s+(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?)\s+(.+)$/i);
	if (!create) return undefined;

	const [, mode, amountText, unit, instruction] = create;
	const amount = Number(amountText);
	const unitMs = unit!.toLowerCase().startsWith("h") ? HOUR_MS : MINUTE_MS;
	const delayMs = amount * unitMs;
	if (!Number.isFinite(delayMs) || delayMs <= 0 || !instruction?.trim()) return undefined;

	return {
		action: "create",
		delayMs,
		...(mode!.toLowerCase() === "every" ? { intervalMs: delayMs } : {}),
		instruction: instruction.trim(),
	};
}

export function formatScheduleTask(task: ScheduleTask, now = Date.now()): string {
	const remainingMinutes = Math.max(0, Math.ceil((task.nextRunAt - now) / MINUTE_MS));
	const recurrence = task.intervalMs === undefined ? "一次性" : `每 ${Math.ceil(task.intervalMs / MINUTE_MS)} 分钟`;
	return `${task.id} · ${recurrence} · ${remainingMinutes} 分钟后：${task.title}`;
}

export function formatScheduleTasks(tasks: ScheduleTask[], now = Date.now()): string {
	if (tasks.length === 0) return "当前会话没有定时任务。";
	return tasks.map((task) => formatScheduleTask(task, now)).join("\n");
}

export function reminderMessage(task: ScheduleTask): string {
	const recurrence = task.intervalMs === undefined ? "一次性任务" : "周期任务";
	return [
		`[定时任务触发：${task.id} · ${recurrence}]`,
		task.instruction,
		"请结合当前会话和目标立即处理；若该周期任务已完成或不再适用，请调用 schedule 取消它。",
	].join("\n");
}

export function deliverScheduledTask(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	ctx: Pick<ExtensionContext, "isIdle">,
	task: ScheduleTask,
): void {
	const message = reminderMessage(task);
	if (ctx.isIdle()) {
		pi.sendUserMessage(message);
		return;
	}
	pi.sendUserMessage(message, { deliverAs: "followUp" });
}

function formatCreatedTask(task: ScheduleTask): string {
	const recurrence = task.intervalMs === undefined ? "一次性" : `每 ${Math.ceil(task.intervalMs / MINUTE_MS)} 分钟`;
	return `已创建 ${task.id}（${recurrence}）：${task.title}`;
}

export function updateScheduleTriggerStatus(
	ctx: Pick<ExtensionContext, "ui">,
	tasks: readonly ScheduleTask[],
	now = Date.now(),
): void {
	if (tasks.length === 0) {
		ctx.ui.setStatus(SCHEDULE_TRIGGER_STATUS_KEY, undefined);
		return;
	}
	const label = tasks.length === 1
		? `⏰ ${tasks[0]!.id} · ${Math.max(1, Math.ceil((tasks[0]!.nextRunAt - now) / MINUTE_MS))}m`
		: `⏰ ${tasks.length} schedules`;
	ctx.ui.setStatus(SCHEDULE_TRIGGER_STATUS_KEY, ctx.ui.theme.fg("warning", label));
}

export default function scheduleExtension(pi: ExtensionAPI): void {
	let activeContext: Pick<ExtensionContext, "isIdle" | "ui"> | undefined;
	const schedules = new SessionScheduleManager(
		(task) => {
			if (!activeContext) return;
			try {
				deliverScheduledTask(pi, activeContext, task);
				activeContext.ui.notify(`定时任务 ${task.id} 已触发。`, "info");
			} catch (error) {
				activeContext.ui.notify(
					`定时任务 ${task.id} 注入失败：${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
		systemClock,
		(tasks) => {
			if (activeContext) updateScheduleTriggerStatus(activeContext, tasks);
			publishLiveFeature("schedule", { tasks, generatedAt: Date.now() });
		},
	);

	const create = (input: CreateScheduleTask): ScheduleTask => schedules.create(input);

	pi.registerTool({
		name: "schedule",
		label: "Schedule",
		description: "Create, list, or cancel current-session one-shot and recurring tasks. Use it proactively for periodic execution, long-running work monitoring, background-job follow-up, retries, or progress checks; due tasks send their instruction back to the agent. Do not use schedule for work that can be completed immediately or for aggressive polling; choose a practical interval, avoid duplicate tasks, and cancel recurring tasks once their purpose is complete.",
		promptSnippet: "Proactively schedule current-session periodic work, long-running monitoring, follow-ups, retries, or progress checks",
		parameters: Type.Object({
			action: StringEnum(["create", "list", "cancel"] as const),
			title: Type.Optional(Type.String({ minLength: 1 })),
			instruction: Type.Optional(Type.String({ minLength: 1 })),
			delayMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
			intervalMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
			id: Type.Optional(Type.String({ minLength: 1 })),
		}),
		async execute(_toolCallId, params): Promise<ScheduleToolResult> {
			if (params.action === "list") {
				const tasks = schedules.list();
				return {
					content: [{ type: "text", text: formatScheduleTasks(tasks) }],
					details: { tasks },
				};
			}

			if (params.action === "cancel") {
				if (!params.id) throw new Error("取消定时任务需要 id。");
				const cancelled = schedules.cancel(params.id);
				return {
					content: [{ type: "text", text: cancelled ? `已取消 ${params.id}。` : `未找到 ${params.id}。` }],
					details: { id: params.id, cancelled },
				};
			}

			if (!params.instruction?.trim()) throw new Error("创建定时任务需要 instruction。");
			const delayMinutes = params.delayMinutes ?? params.intervalMinutes;
			if (delayMinutes === undefined) throw new Error("创建定时任务需要 delayMinutes 或 intervalMinutes。");
			const task = create({
				title: params.title,
				instruction: params.instruction,
				delayMs: delayMinutes * MINUTE_MS,
				...(params.intervalMinutes === undefined ? {} : { intervalMs: params.intervalMinutes * MINUTE_MS }),
			});
			return {
				content: [{ type: "text", text: formatCreatedTask(task) }],
				details: { task },
			};
		},
	});

	pi.registerCommand("schedule", {
		description: "管理当前会话定时任务：in 30m <指令> | every 30m <指令> | list | cancel <id>",
		handler: async (args, ctx) => {
			const command = parseScheduleCommand(args);
			if (!command) {
				ctx.ui.notify("用法：/schedule in 30m <指令> | every 30m <指令> | list | cancel <id>", "warning");
				return;
			}
			if (command.action === "list") {
				const tasks = schedules.list();
				if (tasks.length === 0 || !ctx.hasUI) {
					ctx.ui.notify(formatScheduleTasks(tasks), "info");
					return;
				}
				const now = Date.now();
				const labels = tasks.map((task) => formatScheduleTask(task, now));
				const selected = await ctx.ui.select(
					"当前会话定时任务（↑/↓ 切换，Enter 查看，Esc 关闭）",
					labels,
				);
				if (!selected) return;
				const selectedTask = tasks[labels.indexOf(selected)];
				if (selectedTask) {
					ctx.ui.notify(`${selected}\n${selectedTask.instruction}`, "info");
				}
				return;
			}
			if (command.action === "cancel") {
				ctx.ui.notify(
					schedules.cancel(command.id) ? `已取消 ${command.id}。` : `未找到 ${command.id}。`,
					"info",
				);
				return;
			}

			ctx.ui.notify(formatCreatedTask(create(command)), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeContext = ctx;
		const tasks = schedules.list();
		updateScheduleTriggerStatus(ctx, tasks);
		publishLiveFeature("schedule", { tasks, generatedAt: Date.now() });
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(SCHEDULE_TRIGGER_STATUS_KEY, undefined);
		activeContext = undefined;
		schedules.dispose();
		clearLiveFeature("schedule");
	});
}
