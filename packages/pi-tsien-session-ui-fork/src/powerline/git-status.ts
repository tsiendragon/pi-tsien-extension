import { spawn } from "node:child_process";
import type { GitStatus } from "./types.ts";

interface CachedGitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
}

interface CachedBranch {
  branch: string | null;
}

/** Git data is refreshed from lifecycle events, never from status-bar renders. */
export type GitPollingMode = "event" | "branch" | "off";

/** Known git hosting providers we render a dedicated icon for. */
export type GitHost = "github" | "gitlab" | "bitbucket" | "other";

interface CachedRemoteHost {
  host: GitHost | null;
  timestamp: number;
}

const REMOTE_TTL_MS = 60_000; // Origin remote almost never changes within a session
let cachedStatus: CachedGitStatus | null = null;
let cachedBranch: CachedBranch | null = null;
let cachedRemoteHost: CachedRemoteHost | null = null;
let pendingRemoteFetch: Promise<void> | null = null;
let pendingFetch: Promise<void> | null = null;
let pendingBranchFetch: Promise<void> | null = null;
let statusRefreshQueued = false;
let branchRefreshQueued = false;
let invalidationCounter = 0; // Track invalidations to prevent stale updates
let branchInvalidationCounter = 0;
const updateListeners = new Set<() => void>();

function notifyGitUpdate(): void {
  for (const listener of updateListeners) listener();
}

export function subscribeGitUpdates(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

/**
 * Parse git status --porcelain output.
 *
 * Format: XY filename
 * X = index status, Y = working tree status
 * ?? = untracked
 * Other X values = staged
 * Other Y values = unstaged
 */
function parseGitStatusOutput(output: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];

    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }
    if (x && x !== " " && x !== "?") staged++;
    if (y && y !== " ") unstaged++;
  }

  return { staged, unstaged, untracked };
}

function runGit(args: string[], timeoutMs = 200): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let resolved = false;
    const timeoutId = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.on("close", (code) => {
      finish(code === 0 ? stdout.trim() : null);
    });
    proc.on("error", () => {
      finish(null);
    });
  });
}

/**
 * Fetch current git branch asynchronously.
 * For detached HEAD, returns the short commit SHA (matches provider's "detached" behavior).
 */
async function fetchGitBranch(): Promise<string | null> {
  const branch = await runGit(["branch", "--show-current"]);
  if (branch === null) return null;
  if (branch) return branch;

  const sha = await runGit(["rev-parse", "--short", "HEAD"]);
  return sha ? `${sha} (detached)` : "detached";
}

/**
 * Classify an origin remote URL into a known hosting provider. Handles both
 * SSH (`git@host:owner/repo`, `ssh://git@host/…`) and HTTP(S) forms, and
 * treats sub-domains (e.g. `www.github.com`) and any non-empty remote we
 * don't recognize as a generic git host.
 */
export function detectGitHost(remoteUrl: string | null): GitHost | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  let host: string;
  const scpLike = /^[^/@]+@([^:/]+):/.exec(trimmed);
  if (scpLike) {
    host = scpLike[1]!;
  } else {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return "other";
    }
  }

  host = host.toLowerCase().replace(/^www\./, "");
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return "gitlab";
  if (host === "bitbucket.org" || host.endsWith(".bitbucket.org")) return "bitbucket";
  return "other";
}

async function fetchRemoteHost(): Promise<GitHost | null> {
  const url = await runGit(["remote", "get-url", "origin"]);
  return detectGitHost(url);
}

/**
 * Get the origin remote's hosting provider with a long TTL cache. This only
 * runs when hostIcon is enabled; Git status itself is always event-driven.
 */
export function getGitRemoteHost(): GitHost | null {
  const now = Date.now();
  if (cachedRemoteHost && now - cachedRemoteHost.timestamp < REMOTE_TTL_MS) {
    return cachedRemoteHost.host;
  }

  if (!pendingRemoteFetch) {
    pendingRemoteFetch = fetchRemoteHost()
      .then((host) => {
        cachedRemoteHost = { host, timestamp: Date.now() };
        notifyGitUpdate();
      })
      .catch(() => {
        cachedRemoteHost = { host: null, timestamp: Date.now() };
        notifyGitUpdate();
      })
      .finally(() => {
        pendingRemoteFetch = null;
      });
  }

  return cachedRemoteHost ? cachedRemoteHost.host : null;
}

async function fetchGitStatus(): Promise<{ staged: number; unstaged: number; untracked: number } | null> {
  const output = await runGit(["status", "--porcelain"], 500);
  return output === null ? null : parseGitStatusOutput(output);
}

/**
 * Return the latest event-refreshed branch, falling back to Pi's provider
 * before the first refresh. Rendering never starts a Git subprocess.
 */
export function getCurrentBranch(providerBranch: string | null): string | null {
  return cachedBranch ? cachedBranch.branch : providerBranch;
}

function startStatusRefresh(): void {
  if (pendingFetch) return;
  statusRefreshQueued = false;
  const fetchId = invalidationCounter;
  pendingFetch = fetchGitStatus()
    .then((result) => {
      if (fetchId !== invalidationCounter) return;
      cachedStatus = result
        ? { staged: result.staged, unstaged: result.unstaged, untracked: result.untracked }
        : { staged: 0, unstaged: 0, untracked: 0 };
      notifyGitUpdate();
    })
    .finally(() => {
      pendingFetch = null;
      if (statusRefreshQueued) startStatusRefresh();
    });
}

/** Request one status refresh after a safe lifecycle event. */
export function refreshGitStatus(): void {
  invalidationCounter++;
  statusRefreshQueued = true;
  startStatusRefresh();
}

function startBranchRefresh(): void {
  if (pendingBranchFetch) return;
  branchRefreshQueued = false;
  const fetchId = branchInvalidationCounter;
  pendingBranchFetch = fetchGitBranch()
    .then((branch) => {
      if (fetchId !== branchInvalidationCounter) return;
      cachedBranch = { branch };
      notifyGitUpdate();
    })
    .finally(() => {
      pendingBranchFetch = null;
      if (branchRefreshQueued) startBranchRefresh();
    });
}

/** Request one branch refresh after a safe lifecycle event. */
export function refreshGitBranch(): void {
  branchInvalidationCounter++;
  branchRefreshQueued = true;
  cachedRemoteHost = null;
  startBranchRefresh();
}

/**
 * Read the last event-refreshed Git state. This function deliberately never
 * starts Git work, so status-bar rendering cannot contend with Git writers.
 */
export function getGitStatus(providerBranch: string | null, pollingMode: GitPollingMode = "event"): GitStatus {
  const branch = pollingMode === "off" ? providerBranch : getCurrentBranch(providerBranch);
  if (pollingMode !== "event" || !cachedStatus) {
    return { branch, staged: 0, unstaged: 0, untracked: 0 };
  }
  return {
    branch,
    staged: cachedStatus.staged,
    unstaged: cachedStatus.unstaged,
    untracked: cachedStatus.untracked,
  };
}
