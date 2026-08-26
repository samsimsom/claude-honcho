import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync } from "fs";
import { getContextRefreshConfig } from "./config.js";

const CACHE_DIR = join(homedir(), ".honcho");
const ID_CACHE_FILE = join(CACHE_DIR, "cache.json");
const CONTEXT_CACHE_FILE = join(CACHE_DIR, "context-cache.json");

// Ensure cache directory exists
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// ============================================
// Concurrency: every file in ~/.honcho is shared by all sessions on this
// machine, and each was updated with an unsynchronised load -> mutate -> write.
// Measured 2026-08-26: 12 concurrent SessionStarts left 1 of 12 cwd entries;
// even 2 lost 5 of 12 across six runs. A dropped entry is not cosmetic — it is
// exactly the "cwd not registered" state that the MCP server's resolver has to
// fall back from. Mutations now run under an exclusive lock and land via rename.
// ============================================

const LOCK_TIMEOUT_MS = 2000; // give up waiting and proceed unlocked (never block a hook)
const LOCK_STALE_MS = 5000;   // a lock older than this belonged to a process that died

function sleepSync(ms: number): void {
  // Real sleep, not a spin: hooks are short-lived and must not burn CPU waiting.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive lock on `file`. mkdir is atomic on POSIX,
 * so it doubles as the mutex. If the lock cannot be taken within the timeout we
 * run anyway — degrading to the old racy behaviour is strictly better than
 * failing a hook or hanging a session start.
 */
function withCacheLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue; // retry immediately; whoever wins the next mkdir owns it
        }
      } catch {
        continue; // lock vanished between the failed mkdir and the stat
      }
      sleepSync(5 + Math.floor(Math.random() * 10)); // jitter so waiters don't sync up
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try { rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/** Write JSON so a reader never observes a half-written file. */
function writeJsonAtomic(file: string, data: unknown): void {
  ensureCacheDir();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new Error(`failed to write ${file}`);
  }
}

// ============================================
// ID Cache - workspace, session, peer IDs
// ============================================

interface IdCache {
  workspace?: { name: string; id: string };
  peers?: Record<string, string>; // peerName -> peerId
  sessions?: Record<string, { name: string; id: string; updatedAt: string; instanceId?: string }>; // cwd -> session info
}

export function loadIdCache(): IdCache {
  ensureCacheDir();
  if (!existsSync(ID_CACHE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(ID_CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveIdCache(cache: IdCache): void {
  writeJsonAtomic(ID_CACHE_FILE, cache);
}

/** Load, mutate and persist the ID cache as one locked step. */
function updateIdCache<T>(mutate: (cache: IdCache) => T): T {
  return withCacheLock(ID_CACHE_FILE, () => {
    const cache = loadIdCache();
    const result = mutate(cache);
    saveIdCache(cache);
    return result;
  });
}

export function getCachedWorkspaceId(workspaceName: string): string | null {
  const cache = loadIdCache();
  if (cache.workspace?.name === workspaceName) {
    return cache.workspace.id;
  }
  return null;
}

export function setCachedWorkspaceId(name: string, id: string): void {
  updateIdCache((cache) => {
    cache.workspace = { name, id };
  });
}

export function getCachedPeerId(peerName: string): string | null {
  const cache = loadIdCache();
  return cache.peers?.[peerName] || null;
}

export function setCachedPeerId(peerName: string, peerId: string): void {
  updateIdCache((cache) => {
    if (!cache.peers) cache.peers = {};
    cache.peers[peerName] = peerId;
  });
}

export function getCachedSessionId(cwd: string): string | null {
  const cache = loadIdCache();
  return cache.sessions?.[cwd]?.id || null;
}

export function setCachedSessionId(cwd: string, name: string, id: string, instanceId?: string): void {
  updateIdCache((cache) => {
    if (!cache.sessions) cache.sessions = {};
    cache.sessions[cwd] = { name, id, updatedAt: new Date().toISOString(), instanceId };
  });
}

/** Find the most recently active CWD from cached sessions (fallback for MCP servers without project dir) */
export function getLastActiveCwd(): string | null {
  const cache = loadIdCache();
  if (!cache.sessions) return null;
  let latest: { cwd: string; updatedAt: string } | null = null;
  for (const [cwd, entry] of Object.entries(cache.sessions)) {
    if (!latest || entry.updatedAt > latest.updatedAt) {
      latest = { cwd, updatedAt: entry.updatedAt };
    }
  }
  return latest?.cwd || null;
}

// Claude instance tracking for parallel session support.
// Always per-cwd: a single machine-global field is last-writer-wins across every
// concurrent session, which is the same class of bug as the cwd race (#38).

/** Get the instance ID stored for a specific cwd (scoped, no cross-session collision) */
export function getInstanceIdForCwd(cwd: string): string | null {
  const cache = loadIdCache();
  return cache.sessions?.[cwd]?.instanceId ?? null;
}

/**
 * Record a cwd's instance ID without disturbing its cached session name/id.
 * Called at session start, before the session's own id is known, so that
 * callers with no hook input (the MCP server) can resolve the right instance
 * during the window before setCachedSessionId() lands.
 */
export function setInstanceIdForCwd(cwd: string, instanceId: string): void {
  updateIdCache((cache) => {
    if (!cache.sessions) cache.sessions = {};
    const existing = cache.sessions[cwd];
    cache.sessions[cwd] = {
      name: existing?.name ?? "",
      id: existing?.id ?? "",
      updatedAt: new Date().toISOString(),
      instanceId,
    };
  });
}

// ============================================
// Context Cache - user + claude context with TTL
// ============================================

interface ContextCache {
  userContext?: { data: any; fetchedAt: number };
  claudeContext?: { data: any; fetchedAt: number };
  summaries?: { data: any; fetchedAt: number };
  messageCounts?: Record<string, number>; // cwd -> messages since that session started
}

// Now configurable via config.json, with defaults in getContextRefreshConfig()
function getContextTTL(): number {
  const config = getContextRefreshConfig();
  return (config.ttlSeconds ?? 300) * 1000; // Convert to ms
}

// Known keys in ContextCache — anything else is a ghost from older versions
// Anything outside this set is stripped on load as a ghost from an older
// version — which is how the pre-2026-08-26 machine-global "messageCount"
// integer removes itself once this build runs.
const CONTEXT_CACHE_KNOWN_KEYS = new Set([
  "claudeContext", "summaries", "messageCounts",
]);

export function loadContextCache(): ContextCache {
  ensureCacheDir();
  if (!existsSync(CONTEXT_CACHE_FILE)) {
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(CONTEXT_CACHE_FILE, "utf-8"));
    // Strip ghost keys left by older plugin versions (e.g. "aiContext")
    let cleaned = false;
    for (const key of Object.keys(raw)) {
      if (!CONTEXT_CACHE_KNOWN_KEYS.has(key)) {
        delete raw[key];
        cleaned = true;
      }
    }
    if (cleaned) {
      writeJsonAtomic(CONTEXT_CACHE_FILE, raw);
    }
    return raw;
  } catch {
    return {};
  }
}

export function saveContextCache(cache: ContextCache): void {
  writeJsonAtomic(CONTEXT_CACHE_FILE, cache);
}

/** Load, mutate and persist the context cache as one locked step. */
function updateContextCache<T>(mutate: (cache: ContextCache) => T): T {
  return withCacheLock(CONTEXT_CACHE_FILE, () => {
    const cache = loadContextCache();
    const result = mutate(cache);
    saveContextCache(cache);
    return result;
  });
}

export function getCachedClaudeContext(): any | null {
  const cache = loadContextCache();
  if (cache.claudeContext && Date.now() - cache.claudeContext.fetchedAt < getContextTTL()) {
    return cache.claudeContext.data;
  }
  return null;
}

export function setCachedClaudeContext(data: any): void {
  updateContextCache((cache) => {
    cache.claudeContext = { data, fetchedAt: Date.now() };
  });
}

// Messages seen in this cwd's session. Scoped per cwd: a single machine-wide
// counter let a second window suppress the first-prompt hint of the first one
// (its SessionStart reset the shared value) and replay it in a session that was
// already several prompts in — both measured 2026-08-26.
export function incrementMessageCount(cwd: string): number {
  return updateContextCache((cache) => {
    if (!cache.messageCounts) cache.messageCounts = {};
    cache.messageCounts[cwd] = (cache.messageCounts[cwd] || 0) + 1;
    return cache.messageCounts[cwd];
  });
}

export function getMessageCount(cwd: string): number {
  return loadContextCache().messageCounts?.[cwd] || 0;
}

export function resetMessageCount(cwd: string): void {
  updateContextCache((cache) => {
    if (!cache.messageCounts) cache.messageCounts = {};
    cache.messageCounts[cwd] = 0;
  });
}

// ============================================
// Git State Cache - track git state per directory
// ============================================

const GIT_STATE_FILE = join(CACHE_DIR, "git-state.json");

export interface GitState {
  branch: string;
  commit: string; // Short SHA
  commitMessage: string;
  isDirty: boolean;
  dirtyFiles: string[];
  timestamp: string;
}

interface GitStateCache {
  [cwd: string]: GitState;
}

export function loadGitStateCache(): GitStateCache {
  ensureCacheDir();
  if (!existsSync(GIT_STATE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(GIT_STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveGitStateCache(cache: GitStateCache): void {
  writeJsonAtomic(GIT_STATE_FILE, cache);
}

/** Load, mutate and persist the git-state cache as one locked step. */
function updateGitStateCache<T>(mutate: (cache: GitStateCache) => T): T {
  return withCacheLock(GIT_STATE_FILE, () => {
    const cache = loadGitStateCache();
    const result = mutate(cache);
    saveGitStateCache(cache);
    return result;
  });
}

export function getCachedGitState(cwd: string): GitState | null {
  const cache = loadGitStateCache();
  return cache[cwd] || null;
}

export function setCachedGitState(cwd: string, state: GitState): void {
  updateGitStateCache((cache) => {
    cache[cwd] = state;
  });
}

export interface GitFeatureContext {
  type: "feature" | "fix" | "refactor" | "docs" | "test" | "chore" | "unknown";
  description: string;
  keywords: string[];
  areas: string[]; // e.g., ["api", "auth", "ui"]
  confidence: "high" | "medium" | "low";
}

export interface GitStateChange {
  type: "branch_switch" | "new_commits" | "files_changed" | "initial";
  description: string;
  from?: string;
  to?: string;
}

export function detectGitChanges(previous: GitState | null, current: GitState): GitStateChange[] {
  const changes: GitStateChange[] = [];

  if (!previous) {
    changes.push({
      type: "initial",
      description: `Session started on branch '${current.branch}' at ${current.commit}`,
    });
    return changes;
  }

  // Branch switch
  if (previous.branch !== current.branch) {
    changes.push({
      type: "branch_switch",
      description: `Branch switched from '${previous.branch}' to '${current.branch}'`,
      from: previous.branch,
      to: current.branch,
    });
  }

  // New commits (different SHA on same branch, or any commit change)
  if (previous.commit !== current.commit) {
    changes.push({
      type: "new_commits",
      description: `New commit: ${current.commit} - ${current.commitMessage}`,
      from: previous.commit,
      to: current.commit,
    });
  }

  // Dirty state changed
  if (!previous.isDirty && current.isDirty) {
    changes.push({
      type: "files_changed",
      description: `Uncommitted changes detected: ${current.dirtyFiles.slice(0, 5).join(", ")}${current.dirtyFiles.length > 5 ? "..." : ""}`,
    });
  }

  return changes;
}

// ============================================
// Message Chunking - split large messages for API limits
// ============================================

// Under Honcho's 25k-char per-message cap, with headroom for the [Part i/N] prefix.
const MAX_MESSAGE_SIZE = 24000;

export function chunkContent(content: string, maxSize: number = MAX_MESSAGE_SIZE): string[] {
  if (content.length <= maxSize) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline boundary
    let splitIndex = remaining.lastIndexOf('\n', maxSize);
    if (splitIndex <= 0 || splitIndex < maxSize * 0.25) {
      // No good newline boundary, split at space
      splitIndex = remaining.lastIndexOf(' ', maxSize);
    }
    if (splitIndex <= 0 || splitIndex < maxSize * 0.25) {
      // No good boundary, hard split
      splitIndex = maxSize;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (chunks.length > 1) {
    return chunks.map((chunk, i) => `[Part ${i + 1}/${chunks.length}] ${chunk}`);
  }

  return chunks;
}

export const HONCHO_MAX_BATCH = 100;

type SessionLike = { addMessages: (messages: any[]) => Promise<unknown> };

/**
 * Upload messages, split across calls of ≤100 to stay under Honcho's batch cap.
 *
 * When `resolveFallback` is given, a batch failure resolves an alternate session
 * once and retries only the failed batch (and any remaining ones) on it. This
 * lets callers front a fast noEnsure session and fall back to get-or-create
 * without ever replaying batches the first session already accepted.
 */
export async function addMessagesBatched(
  session: SessionLike,
  messages: any[],
  resolveFallback?: (error: unknown) => Promise<SessionLike>,
): Promise<void> {
  let active = session;
  let usedFallback = false;
  for (let i = 0; i < messages.length; i += HONCHO_MAX_BATCH) {
    const batch = messages.slice(i, i + HONCHO_MAX_BATCH);
    try {
      await active.addMessages(batch);
    } catch (e) {
      if (usedFallback || !resolveFallback) throw e;
      active = await resolveFallback(e);
      usedFallback = true;
      await active.addMessages(batch);
    }
  }
}

// ============================================
// Utility: Clear all caches (for debugging)
// ============================================

export function clearAllCaches(): void {
  ensureCacheDir();
  for (const file of [ID_CACHE_FILE, CONTEXT_CACHE_FILE, GIT_STATE_FILE]) {
    if (existsSync(file)) withCacheLock(file, () => writeJsonAtomic(file, {}));
  }
}

/** Clear only the ID cache (workspace, peer, session IDs) */
export function clearIdCache(): void {
  withCacheLock(ID_CACHE_FILE, () => writeJsonAtomic(ID_CACHE_FILE, {}));
}

/** Clear only peer IDs from the ID cache */
export function clearPeerCache(): void {
  updateIdCache((cache) => {
    delete cache.peers;
  });
}

/** Clear only userContext from the context cache */
export function clearUserContextOnly(): void {
  updateContextCache((cache) => {
    delete cache.userContext;
  });
}

/** Clear only claudeContext from the context cache */
export function clearClaudeContextOnly(): void {
  updateContextCache((cache) => {
    delete cache.claudeContext;
  });
}
