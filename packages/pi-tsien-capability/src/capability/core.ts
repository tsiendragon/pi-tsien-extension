/**
 * Shared types for the capability layer.
 *
 * A capability is a contract plus two implementations (natural language and
 * code). The contract is what lets the layer validate input, bound cost, and
 * decide whether the code path is allowed to run at all.
 */

export type Sensitivity = "public" | "internal" | "local";
export type CapabilityStatus = "draft" | "trusted";
export type StepKind = "code" | "llm";

export interface CapabilityStep {
	readonly id: string;
	readonly kind: StepKind;
	/** Prompt template path, relative to the capability directory. `llm` steps only. */
	readonly prompt?: string;
	/** `provider/model`. `llm` steps only. */
	readonly model?: string;
	readonly maxTokens?: number;
}

export interface CapabilityLimits {
	readonly maxLlmCalls?: number;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
}

/**
 * Explicit sandbox grants, declared in `CAPABILITY.yaml`.
 *
 * The sandbox stays closed by default: an undeclared capability keeps the
 * original behaviour (read its own directory, write the job temp dir, no child
 * processes). A capability that genuinely needs more says so here, so the extra
 * reach is visible in the contract rather than implied by the implementation.
 */
export interface CapabilitySandbox {
	/** Allow `child_process`. Needed to run a command or a test suite. */
	readonly childProcess?: boolean;
	/** Input fields whose value becomes a read+write root (absolute, or `~`-relative). */
	readonly inputFsRoots?: readonly string[];
	/** Static extra read roots. */
	readonly read?: readonly string[];
	/** Static extra write roots. */
	readonly write?: readonly string[];
}

export interface CapabilityContract {
	readonly name: string;
	readonly version: string;
	readonly sensitivity: Sensitivity;
	readonly status: CapabilityStatus;
	readonly description?: string;
	/** When the agent should reach for this capability. Surfaces in capability_ls. */
	readonly when?: string;
	readonly steps: readonly CapabilityStep[];
	/** Other capabilities this one builds on. L2 may use L1; L1 must not use L2. */
	readonly uses?: readonly { readonly capability: string; readonly step: string }[];
	readonly limits?: CapabilityLimits;
	readonly sandbox?: CapabilitySandbox;
}

export interface Capability extends CapabilityContract {
	/** Absolute directory holding CAPABILITY.yaml and impl/. */
	readonly dir: string;
	/** Which root it was discovered under, e.g. `L1` or `L2`. */
	readonly layer: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringList(value: unknown): string[] {
	return (Array.isArray(value) ? value : []).filter(
		(entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
	);
}

function normalizeSandbox(raw: unknown): CapabilitySandbox | undefined {
	const source = asRecord(raw);
	if (Object.keys(source).length === 0) return undefined;
	const sandbox: CapabilitySandbox = {
		childProcess: source.child_process === true,
		inputFsRoots: asStringList(source.input_fs_roots),
		read: asStringList(source.read),
		write: asStringList(source.write),
	};
	const empty =
		!sandbox.childProcess &&
		(sandbox.inputFsRoots?.length ?? 0) === 0 &&
		(sandbox.read?.length ?? 0) === 0 &&
		(sandbox.write?.length ?? 0) === 0;
	return empty ? undefined : sandbox;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeStep(raw: unknown): CapabilityStep | undefined {
	const step = asRecord(raw);
	const id = asString(step.id);
	if (!id) return undefined;
	return {
		id,
		kind: step.kind === "llm" ? "llm" : "code",
		prompt: asString(step.prompt),
		model: asString(step.model),
		maxTokens: asNumber(step.max_tokens),
	};
}

/** Validate and normalize a parsed CAPABILITY.yaml into a contract. */
export function normalizeContract(raw: unknown): CapabilityContract | undefined {
	const source = asRecord(raw);
	const name = asString(source.name);
	if (!name) return undefined;

	const steps = (Array.isArray(source.steps) ? source.steps : [])
		.map(normalizeStep)
		.filter((step): step is CapabilityStep => step !== undefined);

	const uses = (Array.isArray(source.uses) ? source.uses : [])
		.map((entry) => asRecord(entry))
		.map((entry) => ({ capability: asString(entry.capability) ?? "", step: asString(entry.step) ?? "" }))
		.filter((entry) => entry.capability.length > 0);

	const limitsRaw = asRecord(source.limits);
	const limits: CapabilityLimits = {
		maxLlmCalls: asNumber(limitsRaw.max_llm_calls),
		timeoutMs: asNumber(limitsRaw.timeout_ms),
		maxOutputBytes: asNumber(limitsRaw.max_output_bytes),
	};

	const sensitivity = source.sensitivity;
	const status = source.status;

	return {
		name,
		version: asString(source.version) ?? "0.0.0",
		sensitivity: sensitivity === "internal" || sensitivity === "local" ? sensitivity : "public",
		status: status === "trusted" ? "trusted" : "draft",
		description: asString(source.description),
		when: asString(source.when),
		steps,
		uses: uses.length > 0 ? uses : undefined,
		limits,
		sandbox: normalizeSandbox(source.sandbox),
	};
}