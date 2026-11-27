/**
 * Host-side TypeScript type stripping for Code Mode programs.
 *
 * The sandboxed runtime child runs with `--permission`, an empty environment and a bare `vm`
 * context, so it must not depend on Node's built-in TypeScript support: several Node builds ship
 * `node:module` without it (`node_use_amaro=0`, e.g. the shared-`libnode` builds used by
 * Debian/Ubuntu) and throw `Node.js is not compiled with TypeScript support` on first use.
 *
 * Programs are therefore stripped on the host, before they cross into the child, using the same
 * SWC engine that Node bundles (`amaro`, strip-only mode), so semantics and diagnostics match
 * Node's own type stripping: only erasable syntax is accepted, and `enum`/`namespace` are
 * rejected. `node:module.stripTypeScriptTypes` is kept as a fallback for installs where the
 * dependency is missing.
 *
 * Stripping happens on the wrapped program, so the rewritten source keeps the original line
 * layout: reported line numbers stay valid, with the wrapper occupying line 1.
 */
import { createRequire } from "node:module";

/** Filename used for the compiled program, so stack traces and SWC diagnostics name the script. */
export const PROGRAM_FILENAME = "ptc-program.ts";

const WRAPPER_PREFIX = "async function __ptc_main(tools, console) {\n";
const WRAPPER_SUFFIX = "\n}\n__ptc_main(tools, console)";

const requireFromHere = createRequire(import.meta.url);

type AmaroModule = {
  transformSync(code: string, options?: { mode?: string; filename?: string }): { code: string };
};

type NativeModuleModule = {
  stripTypeScriptTypes?: (source: string, options?: { mode?: string }) => string;
};

/** Thrown when a program uses syntax that strip-only TypeScript erasure cannot handle. */
export class TypeScriptStripError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TypeScriptStripError";
  }
}

export type TypeStripper = {
  source: "amaro" | "node";
  strip(source: string): string;
};

let cachedStripper: TypeStripper | null | undefined;

function loadAmaroStripper(): TypeStripper | undefined {
  let amaro: AmaroModule;
  try {
    amaro = requireFromHere("amaro") as AmaroModule;
  } catch {
    return undefined;
  }
  if (typeof amaro.transformSync !== "function") return undefined;
  try {
    const probe = amaro.transformSync(`${WRAPPER_PREFIX}const probe: number = 1;${WRAPPER_SUFFIX}`, {
      mode: "strip-only",
      filename: PROGRAM_FILENAME,
    });
    if (typeof probe?.code !== "string") return undefined;
  } catch {
    return undefined;
  }
  return {
    source: "amaro",
    strip: (source) => amaro.transformSync(source, { mode: "strip-only", filename: PROGRAM_FILENAME }).code,
  };
}

function loadNodeStripper(): TypeStripper | undefined {
  let mod: NativeModuleModule;
  try {
    mod = requireFromHere("node:module") as NativeModuleModule;
  } catch {
    return undefined;
  }
  const stripTypeScriptTypes = mod.stripTypeScriptTypes;
  if (typeof stripTypeScriptTypes !== "function") return undefined;
  try {
    // Some Node builds export the function but throw on use; a probe decides once, here. It emits
    // an ExperimentalWarning when it works, which is why amaro is preferred above.
    stripTypeScriptTypes(`${WRAPPER_PREFIX}const probe: number = 1;${WRAPPER_SUFFIX}`, { mode: "strip" });
  } catch {
    return undefined;
  }
  return {
    source: "node",
    strip: (source) => stripTypeScriptTypes(source, { mode: "strip" }),
  };
}

/** Resolves the stripper once per process; `null` means no TypeScript erasure is available. */
export function getTypeStripper(): TypeStripper | null {
  if (cachedStripper === undefined) {
    cachedStripper = loadAmaroStripper() ?? loadNodeStripper() ?? null;
  }
  return cachedStripper;
}

/** True when programs can be stripped on the host, i.e. when Code Mode can expose its tool. */
export function isTypeStripperAvailable(): boolean {
  return getTypeStripper() !== null;
}

/** Line numbers are reported against the wrapped source, whose first line is the wrapper. */
function userFacingLocation(error: { startLine?: unknown; startColumn?: unknown }): string {
  const line = typeof error.startLine === "number" && error.startLine > 1 ? error.startLine - 1 : undefined;
  const column = typeof error.startColumn === "number" && error.startColumn > 0 ? error.startColumn : undefined;
  if (line === undefined) return "";
  return column === undefined ? ` (line ${line})` : ` (line ${line}, column ${column})`;
}

/**
 * SWC (through amaro) throws a plain object rather than an `Error`, so the message, location and
 * code frame are lifted explicitly; Node's own stripper already throws a formatted `Error`.
 */
function toStripError(error: unknown): TypeScriptStripError {
  if (error instanceof Error) return new TypeScriptStripError(error.message, { cause: error });
  const record = (error ?? {}) as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : String(error);
  const snippet = typeof record.snippet === "string" && record.snippet.trim() ? `\n${record.snippet.trimEnd()}` : "";
  return new TypeScriptStripError(`${message}${userFacingLocation(record)}${snippet}`, { cause: error });
}

/**
 * Wraps a Code Mode program body in the runtime's async entry point and erases its type
 * annotations, returning plain JavaScript ready for `vm.Script`; the script's value is the
 * promise returned by the entry point.
 *
 * Throws {@link TypeScriptStripError} for syntax errors and for non-erasable TypeScript
 * (`enum`, `namespace`, parameter properties), and a plain `Error` when no stripper exists.
 */
export function compileProgram(code: string): string {
  const stripper = getTypeStripper();
  if (!stripper) {
    throw new Error("Code Mode requires TypeScript type stripping, but neither amaro nor node:module support is available");
  }
  try {
    return stripper.strip(`${WRAPPER_PREFIX}${code}${WRAPPER_SUFFIX}`);
  } catch (error) {
    throw toStripError(error);
  }
}