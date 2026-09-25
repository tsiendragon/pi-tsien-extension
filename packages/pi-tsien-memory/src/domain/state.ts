import type { MemoryStatus } from "./types.ts";
import { MemoryError } from "./errors.ts";

const transitions: Record<MemoryStatus, readonly MemoryStatus[]> = {
  candidate: ["active", "rejected", "forgotten"],
  active: ["stale", "superseded", "forgotten"],
  stale: ["active", "superseded", "forgotten"],
  superseded: ["forgotten"],
  rejected: ["forgotten"],
  forgotten: [],
};

export function canTransition(from: MemoryStatus, to: MemoryStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: MemoryStatus, to: MemoryStatus): void {
  if (!canTransition(from, to)) {
    throw new MemoryError(`Invalid memory transition: ${from} -> ${to}`, "MEMORY_INVALID_TRANSITION");
  }
}

export function transitionReason(from: MemoryStatus, to: MemoryStatus): string {
  if (from === "candidate" && to === "active") return "candidate_confirmed";
  if (to === "stale") return "authoritative_source_conflict";
  if (to === "superseded") return "explicit_replacement";
  if (to === "forgotten") return "user_forget";
  return `${from}_to_${to}`;
}
