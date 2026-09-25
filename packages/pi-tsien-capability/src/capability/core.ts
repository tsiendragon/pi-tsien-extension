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
	};
}