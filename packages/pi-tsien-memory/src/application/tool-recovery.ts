export interface ToolOutcome {
  toolName: string;
  isError: boolean;
}

export interface ToolRecovery {
  failedToolNames: string[];
  recoveredToolNames: string[];
}

/**
 * A failure becomes useful evidence only after the same tool succeeds later in the turn.
 * Success of an unrelated tool, or success followed by failure, is not recovery.
 */
export function recoveryFromToolOutcomes(outcomes: readonly ToolOutcome[]): ToolRecovery {
  const failed = new Set<string>();
  const recovered = new Set<string>();
  const failedToolNames: string[] = [];
  const recoveredToolNames: string[] = [];
  for (const outcome of outcomes) {
    const name = outcome.toolName.trim();
    if (!name) continue;
    if (outcome.isError) {
      if (!failed.has(name)) failedToolNames.push(name);
      failed.add(name);
      continue;
    }
    if (failed.has(name) && !recovered.has(name)) {
      recovered.add(name);
      recoveredToolNames.push(name);
    }
  }
  return { failedToolNames, recoveredToolNames };
}