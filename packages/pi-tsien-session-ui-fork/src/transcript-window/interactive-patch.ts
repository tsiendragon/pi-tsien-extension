import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";
import type { TranscriptWindowController } from "./controller.ts";

type InteractiveModeInternals = {
  chatContainer?: {
    addChild(component: unknown): void;
  };
  ui?: {
    requestRender?: () => void;
  };
};

type PatchOwner = {
  restore(): void;
};

const PATCH_OWNER = Symbol.for("pi.zero.transcript-window.patch-owner");

function getPatchHost(): typeof globalThis & {
  [PATCH_OWNER]?: PatchOwner;
} {
  return globalThis as typeof globalThis & {
    [PATCH_OWNER]?: PatchOwner;
  };
}

/**
 * Install a single-owner wrapper before Pi turns session entries into TUI
 * components. The optional prototype argument keeps the behaviour testable
 * without instantiating an interactive Pi session.
 */
export function installInteractiveTranscriptPatch(
  controller: TranscriptWindowController,
  prototype: Record<string | symbol, unknown> = InteractiveMode.prototype as unknown as Record<
    string | symbol,
    unknown
  >,
): () => void {
  const host = getPatchHost();
  host[PATCH_OWNER]?.restore();

  const original = prototype.renderSessionItems;
  if (typeof original !== "function") return () => {};

  let active = true;
  const wrapped = function wrappedRenderSessionItems(
    this: InteractiveModeInternals,
    items: unknown,
    ...args: unknown[]
  ): unknown {
    if (!active || !Array.isArray(items)) {
      return original.apply(this, [items, ...args]);
    }

    try {
      controller.onInteractiveMode(this);
      const selection = controller.selectItems(items);
      if (selection.hiddenTurns > 0) {
        const container = this.chatContainer;
        if (!container || typeof container.addChild !== "function") {
          return original.apply(this, [items, ...args]);
        }
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            "[pi-zero] 已折叠 " +
              selection.hiddenTurns +
              " 轮历史；运行 /transcript expand 可展开。",
            1,
            0,
          ),
        );
      }
      return original.apply(this, [selection.visibleItems, ...args]);
    } catch {
      return original.apply(this, [items, ...args]);
    }
  };

  prototype.renderSessionItems = wrapped;
  const owner: PatchOwner = {
    restore(): void {
      active = false;
      if (prototype.renderSessionItems === wrapped) {
        prototype.renderSessionItems = original;
      }
      if (host[PATCH_OWNER] === owner) {
        delete host[PATCH_OWNER];
      }
    },
  };
  host[PATCH_OWNER] = owner;
  return owner.restore;
}
