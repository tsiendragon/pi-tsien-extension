import assert from "node:assert/strict";
import test from "node:test";

import { createCompactRequestStore } from "../packages/pi-tsien-auto-compact/src/compact-request.ts";

test("request records the first request and reports a duplicate as already scheduled", () => {
	const store = createCompactRequestStore();

	assert.equal(store.request("session-a", "keep the release steps", 1_000), "scheduled");
	assert.equal(store.request("session-a", "other focus", 2_000), "already_scheduled");
	assert.equal(store.has("session-a"), true);

	assert.deepEqual(store.take("session-a"), {
		instructions: "keep the release steps",
		requestedAt: 1_000,
	});
});

test("requests are isolated per session", () => {
	const store = createCompactRequestStore();
	store.request("session-a", undefined, 1);
	store.request("session-b", undefined, 2);

	// A third session must not consume another session's request.
	assert.equal(store.take("session-c"), undefined);
	assert.equal(store.take("session-b")?.requestedAt, 2);
	assert.equal(store.take("session-a")?.requestedAt, 1);
});

test("take consumes the request exactly once", () => {
	const store = createCompactRequestStore();
	store.request("session-a", undefined, 1);

	assert.notEqual(store.take("session-a"), undefined);
	assert.equal(store.take("session-a"), undefined);
	assert.equal(store.has("session-a"), false);
});

test("clear drops a pending request without consuming it", () => {
	const store = createCompactRequestStore();
	store.request("session-a", undefined, 1);

	store.clear("session-a");

	assert.equal(store.has("session-a"), false);
	assert.equal(store.take("session-a"), undefined);
});

test("a missing request still schedules and keeps optional instructions undefined", () => {
	const store = createCompactRequestStore();

	assert.equal(store.has("session-a"), false);
	assert.equal(store.request("session-a", undefined, 1), "scheduled");
	assert.equal(store.take("session-a")?.instructions, undefined);
});