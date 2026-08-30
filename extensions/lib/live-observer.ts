export type LiveFeatureName = "btw" | "schedule" | "subagent-workflow";

type Listener = (feature: LiveFeatureName, snapshot: unknown) => void;
type CommandHandler = (command: unknown) => Promise<unknown>;
type Store = {
  snapshots: Map<LiveFeatureName, unknown>;
  listeners: Set<Listener>;
  commandHandlers: Map<LiveFeatureName, CommandHandler>;
};

const STORE_SYMBOL = Symbol.for("pi.live-session.feature-observer.v1");

function store(): Store {
  const host = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = host[STORE_SYMBOL] as Store | undefined;
  if (existing) {
    existing.commandHandlers ??= new Map();
    return existing;
  }
  const created: Store = { snapshots: new Map(), listeners: new Set(), commandHandlers: new Map() };
  host[STORE_SYMBOL] = created;
  return created;
}

export function publishLiveFeature(feature: LiveFeatureName, snapshot: unknown): void {
  const current = store();
  current.snapshots.set(feature, snapshot);
  for (const listener of current.listeners) listener(feature, snapshot);
}

export function subscribeLiveFeatures(listener: Listener): () => void {
  const current = store();
  current.listeners.add(listener);
  for (const [feature, snapshot] of current.snapshots) listener(feature, snapshot);
  return () => current.listeners.delete(listener);
}

export function registerLiveFeatureCommandHandler(feature: LiveFeatureName, handler: CommandHandler): () => void {
  const current = store();
  current.commandHandlers.set(feature, handler);
  return () => {
    if (current.commandHandlers.get(feature) === handler) current.commandHandlers.delete(feature);
  };
}

export async function dispatchLiveFeatureCommand(feature: LiveFeatureName, command: unknown): Promise<unknown> {
  const handler = store().commandHandlers.get(feature);
  if (!handler) throw new Error(`${feature}_unavailable`);
  return handler(command);
}

export function clearLiveFeature(feature: LiveFeatureName): void {
  publishLiveFeature(feature, undefined);
}
