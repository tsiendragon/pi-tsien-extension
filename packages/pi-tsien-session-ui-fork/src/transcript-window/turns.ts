export type TranscriptLikeItem = {
  role?: unknown;
};

export type TranscriptSelection<T> = {
  visibleItems: readonly T[];
  hiddenTurns: number;
};

function isUserMessage(value: unknown): value is TranscriptLikeItem {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as TranscriptLikeItem).role === "user"
  );
}

/**
 * Keep a suffix of user-started conversation turns. A null limit means that the
 * caller has explicitly expanded the complete transcript.
 */
export function selectTranscriptWindow<T>(
  items: readonly T[],
  recentTurns: number | null,
): TranscriptSelection<T> {
  if (recentTurns === null || !Number.isFinite(recentTurns)) {
    return { visibleItems: items, hiddenTurns: 0 };
  }

  const userMessageIndexes: number[] = [];
  for (let index = 0; index < items.length; index++) {
    if (isUserMessage(items[index])) userMessageIndexes.push(index);
  }

  if (userMessageIndexes.length === 0) {
    return { visibleItems: items, hiddenTurns: 0 };
  }

  const limit = Math.max(1, Math.floor(recentTurns));
  if (userMessageIndexes.length <= limit) {
    return { visibleItems: items, hiddenTurns: 0 };
  }

  const cutoff = userMessageIndexes[userMessageIndexes.length - limit];
  return {
    visibleItems: items.slice(cutoff),
    hiddenTurns: userMessageIndexes.length - limit,
  };
}
