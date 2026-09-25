/**
 * classify-text capability implementation.
 *
 * Runs inside the sandbox: it reads a job frame from stdin, asks the host for a
 * classification through the RPC protocol, prints one result frame, exits.
 * It has no filesystem or network access of its own.
 */
import { createInterface } from "node:readline";

const PROMPT_ID = "classify";
const LABELS = ["error", "warning", "info", "debug"];

const reader = createInterface({ input: process.stdin });
const waiters = new Map();
let nextId = 1;

let resolveJob;
const job = new Promise((resolve) => {
	resolveJob = resolve;
});

reader.on("line", (line) => {
	let frame;
	try {
		frame = JSON.parse(line);
	} catch {
		return;
	}
	if (frame.__frame__ === "job") {
		resolveJob(frame.input);
		return;
	}
	if (frame.__frame__ === "rpc_result") {
		const waiter = waiters.get(frame.id);
		if (waiter) {
			waiters.delete(frame.id);
			waiter(frame);
		}
	}
});

function askHost(promptId, input, maxTokens) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		waiters.set(id, (frame) => (frame.ok ? resolve(frame.data) : reject(new Error(String(frame.error)))));
		process.stdout.write(
			`${JSON.stringify({ __frame__: "rpc", id, prompt_id: promptId, input, max_tokens: maxTokens })}\n`,
		);
	});
}

function emit(output) {
	process.stdout.write(`${JSON.stringify({ __frame__: "result", output })}\n`);
}

const input = await job;
const text = String(input?.text ?? "");

if (text.length === 0) {
	emit({ label: "unknown", reason: "empty_input" });
	reader.close();
	process.exit(0);
}

const answer = await askHost(PROMPT_ID, { text, labels: LABELS }, 64);
const label = typeof answer?.label === "string" && LABELS.includes(answer.label) ? answer.label : "unknown";

emit({ label, inputLength: text.length });
reader.close();
process.exit(0);