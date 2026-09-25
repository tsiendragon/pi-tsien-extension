import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export const PRE_POWERLINE_HOST_SYMBOL_KEY = "pi.zero.pre-powerline.v1";
export const PRE_POWERLINE_HOST_SYMBOL = Symbol.for(PRE_POWERLINE_HOST_SYMBOL_KEY);

export type PrePowerlineComponent = Component & { dispose?(): void };
export type PrePowerlineComponentFactory = (tui: TUI, theme: Theme) => PrePowerlineComponent;

export interface PrePowerlineHostV1 {
  readonly version: 1;
  register(key: string, factory: PrePowerlineComponentFactory): () => void;
  requestRender(): void;
}

interface HostEntry {
  token: symbol;
  factory: PrePowerlineComponentFactory;
  component?: PrePowerlineComponent;
  tui?: TUI;
  theme?: Theme;
  failed: boolean;
}

export interface PrePowerlineHostOptions {
  requestRender: () => void;
  onError?: (key: string, error: unknown) => void;
}

export class PrePowerlineHost implements PrePowerlineHostV1 {
  readonly version = 1 as const;

  private readonly entries = new Map<string, HostEntry>();

  constructor(private readonly options: PrePowerlineHostOptions) {}

  register(key: string, factory: PrePowerlineComponentFactory): () => void {
    const normalizedKey = key.trim();
    if (!normalizedKey) throw new Error("pre-powerline component key must not be empty");

    const previous = this.entries.get(normalizedKey);
    if (previous) this.disposeEntry(previous);

    const token = Symbol(normalizedKey);
    this.entries.set(normalizedKey, {
      token,
      factory,
      failed: false,
    });
    this.requestRender();

    return () => {
      const current = this.entries.get(normalizedKey);
      if (!current || current.token !== token) return;
      this.disposeEntry(current);
      this.entries.delete(normalizedKey);
      this.requestRender();
    };
  }

  requestRender(): void {
    this.options.requestRender();
  }

  render(width: number, tui: TUI, theme: Theme): string[] {
    const lines: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.failed) continue;

      try {
        if (!entry.component || entry.tui !== tui || entry.theme !== theme) {
          this.disposeEntry(entry);
          entry.component = entry.factory(tui, theme);
          entry.tui = tui;
          entry.theme = theme;
        }

        const rendered = entry.component.render(width);
        if (!Array.isArray(rendered)) {
          throw new Error("pre-powerline component render() must return string[]");
        }
        lines.push(...rendered.filter((line): line is string => typeof line === "string"));
      } catch (error) {
        entry.failed = true;
        this.disposeEntry(entry);
        this.options.onError?.(key, error);
      }
    }
    return lines;
  }

  invalidate(): void {
    for (const [key, entry] of this.entries) {
      if (!entry.component || entry.failed) continue;
      try {
        entry.component.invalidate();
      } catch (error) {
        entry.failed = true;
        this.disposeEntry(entry);
        this.options.onError?.(key, error);
      }
    }
  }

  disposeComponents(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
  }

  reset(): void {
    this.disposeComponents();
    this.entries.clear();
    this.requestRender();
  }

  private disposeEntry(entry: HostEntry): void {
    try {
      entry.component?.dispose?.();
    } catch {
      // A child failure must not affect the Powerline host.
    }
    entry.component = undefined;
    entry.tui = undefined;
    entry.theme = undefined;
  }
}
