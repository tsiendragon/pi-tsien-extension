import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export const PRE_POWERLINE_HOST_SYMBOL_KEY = "pi.zero.pre-powerline.v1";
const PRE_POWERLINE_HOST_SYMBOL = Symbol.for(PRE_POWERLINE_HOST_SYMBOL_KEY);

export type PrePowerlineComponent = Component & { dispose?(): void };
export type PrePowerlineComponentFactory = (tui: TUI, theme: Theme) => PrePowerlineComponent;

export interface PrePowerlineHostV1 {
  readonly version: 1;
  register(key: string, factory: PrePowerlineComponentFactory): () => void;
  requestRender(): void;
}

export function getPrePowerlineHost(): PrePowerlineHostV1 | undefined {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const candidate = globals[PRE_POWERLINE_HOST_SYMBOL] as Partial<PrePowerlineHostV1> | undefined;
  if (
    candidate?.version !== 1 ||
    typeof candidate.register !== "function" ||
    typeof candidate.requestRender !== "function"
  ) {
    return undefined;
  }
  return candidate as PrePowerlineHostV1;
}
