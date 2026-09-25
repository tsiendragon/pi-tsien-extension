import {
  UserMessageComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const PATCH_OWNER = Symbol.for("pi.zero.user-message-style-owner");
const BLUE = "\x1b[38;5;75m";
const RESET_FOREGROUND = "\x1b[39m";
const PREFIX = "\u200b>>> ";

type PatchOwner = {
  restore(): void;
};

type UserMessageInternals = {
  text?: string;
  children?: Array<{
    paddingY?: number;
    children?: Array<{
      defaultTextStyle?: Record<string, unknown>;
      setText?: (text: string) => void;
      invalidate?: () => void;
    }>;
    invalidate?: () => void;
  }>;
};

function blue(text: string): string {
  return `${BLUE}${text}${RESET_FOREGROUND}`;
}

export function installUserMessageStyle(pi: ExtensionAPI): void {
  const host = globalThis as typeof globalThis & {
    [PATCH_OWNER]?: PatchOwner;
  };
  host[PATCH_OWNER]?.restore();

  const prototype = UserMessageComponent.prototype as unknown as {
    rebuild?: (this: UserMessageInternals) => void;
  };
  const originalRebuild = prototype.rebuild;
  if (typeof originalRebuild !== "function") return;

  const patchedRebuild = function patchedUserMessageRebuild(
    this: UserMessageInternals,
  ): void {
    originalRebuild.call(this);

    const contentBox = this.children?.[0];
    const markdown = contentBox?.children?.[0];
    if (!contentBox || !markdown || typeof markdown.setText !== "function") return;

    contentBox.paddingY = 0;
    markdown.defaultTextStyle = {
      ...(markdown.defaultTextStyle ?? {}),
      color: blue,
    };
    markdown.setText(`${PREFIX}${this.text ?? ""}`);
    markdown.invalidate?.();
    contentBox.invalidate?.();
  };

  prototype.rebuild = patchedRebuild;

  const owner: PatchOwner = {
    restore(): void {
      if (prototype.rebuild === patchedRebuild) {
        prototype.rebuild = originalRebuild;
      }
      if (host[PATCH_OWNER] === owner) {
        delete host[PATCH_OWNER];
      }
    },
  };
  host[PATCH_OWNER] = owner;

  pi.on("session_shutdown", () => owner.restore());
}
