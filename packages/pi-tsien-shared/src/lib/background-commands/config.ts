import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface BackgroundCommandsSettings {
  readonly enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(path: string): string {
  return path.replace(/^~(?=$|[\\/])/u, homedir());
}

function readEnabled(path: string): boolean | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const settings = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(settings) || !isRecord(settings.backgroundCommands)) return undefined;
    return typeof settings.backgroundCommands.enabled === "boolean"
      ? settings.backgroundCommands.enabled
      : undefined;
  } catch {
    return undefined;
  }
}

export function readBackgroundCommandsSettings(
  cwd: string,
  includeProjectSettings = false,
): BackgroundCommandsSettings {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR
    ? expandHome(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  const paths = [join(agentDirectory, "settings.json")];
  if (includeProjectSettings) paths.push(join(cwd, ".pi", "settings.json"));
  let enabled = true;
  for (const path of paths) {
    const configured = readEnabled(path);
    if (configured !== undefined) enabled = configured;
  }
  return { enabled };
}
