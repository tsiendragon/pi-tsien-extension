import type {
	ExtensionAPI,
	ExtensionContext,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

type CompactionEvent = Pick<SessionCompactEvent, "reason" | "willRetry">;
type ContinuationContext = Pick<
	ExtensionContext,
	"isIdle" | "hasPendingMessages"
>;

export function shouldContinueAfterCompaction(
	event: CompactionEvent,
	ctx: ContinuationContext,
): boolean {
	return (
		event.reason === "threshold" &&
		!event.willRetry &&
		!ctx.isIdle() &&
		!ctx.hasPendingMessages()
	);
}

export default function compactContinue(pi: ExtensionAPI): void {
	pi.on("session_compact", (event, ctx) => {
		if (!shouldContinueAfterCompaction(event, ctx)) return;

		pi.sendMessage(
			{
				customType: "continue-after-auto-compaction",
				content:
					"上下文已自动压缩。请基于摘要和已完成的工具结果继续当前任务，不要重复已成功执行的操作。",
				display: false,
			},
			{ deliverAs: "followUp" },
		);
	});
}
