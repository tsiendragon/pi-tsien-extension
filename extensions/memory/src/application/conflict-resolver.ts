import type { MemoryAggregate, MemoryScope } from "../domain/types.ts";
import type { MemoryRepository } from "../ports/memory.ts";

export interface SourceConflictInput {
  memoryId: string;
  sourceUri: string;
  sourceSummary: string;
  sourceHash?: string;
}

export class ConflictResolver {
  constructor(private readonly repository: MemoryRepository) {}

  async markAuthoritativeConflict(input: SourceConflictInput): Promise<MemoryAggregate | undefined> {
    const memory = await this.repository.getById(input.memoryId);
    if (!memory || memory.status !== "active") return undefined;
    return this.repository.transition(memory.id, "stale", "system", "authoritative_source_conflict");
  }

  async isBranchOverride(memory: MemoryAggregate, scope: MemoryScope): Promise<boolean> {
    return memory.scope.type === "repository" && scope.type === "branch" && memory.scope.repositoryId === scope.repositoryId;
  }
}
