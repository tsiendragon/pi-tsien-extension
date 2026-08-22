export class MemoryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MemoryError";
  }
}

export class MemoryConflictError extends MemoryError {
  constructor(message = "Memory changed concurrently") {
    super(message, "MEMORY_CONFLICT_RETRY");
    this.name = "MemoryConflictError";
  }
}

export class MemoryConfirmationRequiredError extends MemoryError {
  constructor(message = "Confirmation is required before this destructive operation") {
    super(message, "MEMORY_CONFIRMATION_REQUIRED");
    this.name = "MemoryConfirmationRequiredError";
  }
}

export class MemoryNotFoundError extends MemoryError {
  constructor(message = "Memory target was not found") {
    super(message, "MEMORY_NOT_FOUND");
    this.name = "MemoryNotFoundError";
  }
}

export function errorText(error: unknown): string {
  if (error instanceof MemoryError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
