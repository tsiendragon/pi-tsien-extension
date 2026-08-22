import assert from "node:assert/strict";
import test from "node:test";

import { shouldContinueAfterCompaction } from "../extensions/compact-continue.ts";

function context({ idle = false, pending = false } = {}) {
	return {
		isIdle: () => idle,
		hasPendingMessages: () => pending,
	};
}

test("continues after active threshold compaction with no queued message", () => {
	assert.equal(
		shouldContinueAfterCompaction(
			{ reason: "threshold", willRetry: false },
			context(),
		),
		true,
	);
});

test("does not duplicate built-in retries or queued continuations", () => {
	assert.equal(
		shouldContinueAfterCompaction(
			{ reason: "overflow", willRetry: true },
			context(),
		),
		false,
	);
	assert.equal(
		shouldContinueAfterCompaction(
			{ reason: "threshold", willRetry: false },
			context({ pending: true }),
		),
		false,
	);
});

test("does not continue manual or idle compaction", () => {
	assert.equal(
		shouldContinueAfterCompaction(
			{ reason: "manual", willRetry: false },
			context(),
		),
		false,
	);
	assert.equal(
		shouldContinueAfterCompaction(
			{ reason: "threshold", willRetry: false },
			context({ idle: true }),
		),
		false,
	);
});
