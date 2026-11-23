export interface ToolOutcome {
  toolName: string;
  isError: boolean;
}

export interface ToolRecovery {
  failedToolNames: string[];
  recoveredToolNames: string[];
}

/**
 * Incremental per-turn recovery state. Keeping the sets directly avoids losing an unresolved failure
 * when a long turn produces many tool results; a truncated event list cannot provide that guarantee.
 */
export class ToolRecoveryTracker {
  private failed = new Set<string>();
  private recovered = new Set<string>();
  private failedNames: string[] = [];
  private recoveredOrder: string[] = [];

  reset(): void {
    this.failed.clear();
    this.recovered.clear();
    this.failedNames = [];
    this.recoveredOrder = [];
  }

  record(outcome: ToolOutcome): void {
    const name = outcome.toolName.trim();
    if (!name) return;
    if (outcome.isError) {
      if (!this.failed.has(name)) this.failedNames.push(name);
      this.failed.add(name);
      // A later failure revokes the earlier recovery: the final result is not verified success.
      this.recovered.delete(name);
      return;
    }
    if (this.failed.has(name) && !this.recovered.has(name)) {
      this.recovered.add(name);
      this.recoveredOrder.push(name);
    }
  }

  snapshot(): ToolRecovery {
    return {
      failedToolNames: [...this.failedNames],
      recoveredToolNames: [...new Set(this.recoveredOrder.filter((name) => this.recovered.has(name)))],
    };
  }
}

/** A failure becomes recovery evidence only when the same tool's latest result is a success. */
export function recoveryFromToolOutcomes(outcomes: readonly ToolOutcome[]): ToolRecovery {
  const tracker = new ToolRecoveryTracker();
  for (const outcome of outcomes) tracker.record(outcome);
  return tracker.snapshot();
}