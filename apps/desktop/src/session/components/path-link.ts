import {
  type PathProbe,
  probeProjectPaths,
  probeTaskPaths,
} from "@/lib/project-client";
import { looksLikeFilePath } from "./file-path-utils";

/**
 * Turning a path-like string in agent output into a link, in two tiers.
 *
 * Tier one is {@link looksLikeFilePath}: a synchronous shape test that costs
 * nothing and rejects the overwhelming majority of code spans (`npm run build`,
 * `useState`). Tier two asks the server whether the surviving candidate names
 * something that exists, and where. Only tier-two hits are decorated as links,
 * so a link that is shown always opens, and opening it needs no further
 * resolution.
 *
 * Probes are coalesced: every candidate requested within the same tick becomes
 * one batched request per scope, which keeps a long conversation from opening
 * one connection per code span.
 */

/**
 * Where a reference is resolved from: a task's roots, or a project.
 *
 * Resolution is keyed by task, not run: every run of a task shares its
 * worktree, so a follow-up must not invalidate what the conversation already
 * resolved. The run is carried only for *opening* a resolved target, which
 * reads through the run's file service.
 */
export type PathLinkScope = {
  taskId?: string | null;
  taskRunId?: string | null;
  projectId?: string | null;
};

/** A reference that was confirmed to exist. */
export type PathLinkTarget = {
  kind: "file" | "directory";
  absolutePath: string;
  /** The workspace root it lives under, absent when outside every root. */
  root: string | null;
  line: number | null;
  column: number | null;
};

type CacheEntry = {
  target: PathLinkTarget | null;
  /** Absent for hits: a resolved path stays resolved for the session. */
  expiresAt?: number;
};

/**
 * A miss is remembered only briefly. An agent routinely writes a file moments
 * after naming it, and a permanently cached miss would leave that reference
 * dead for the rest of the session.
 */
const MISS_TTL_MS = 30_000;

/** Conversations can name unbounded distinct paths; keep the recent ones. */
const CACHE_MAX_ENTRIES = 2048;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<PathLinkTarget | null>>();

type PendingBatch = {
  scope: PathLinkScope;
  /** Raw reference text → the resolvers waiting on it. */
  requests: Map<string, ((target: PathLinkTarget | null) => void)[]>;
  timer: ReturnType<typeof setTimeout>;
};

const pendingBatches = new Map<string, PendingBatch>();

const scopeKey = (scope: PathLinkScope): string | null => {
  if (scope.taskId) return `task:${scope.taskId}`;
  if (scope.projectId) return `project:${scope.projectId}`;
  return null;
};

const cacheKey = (scope: string, text: string): string =>
  `${scope}\u0000${text}`;

const readCache = (key: string): CacheEntry | undefined => {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Refresh recency so the LRU keeps what the visible conversation uses.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
};

const writeCache = (key: string, target: PathLinkTarget | null): void => {
  cache.delete(key);
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(
    key,
    target ? { target } : { target: null, expiresAt: Date.now() + MISS_TTL_MS },
  );
};

const toTarget = (probe: PathProbe | undefined): PathLinkTarget | null => {
  if (!probe?.exists || !probe.absolute_path || !probe.kind) return null;
  return {
    kind: probe.kind,
    absolutePath: probe.absolute_path,
    root: probe.root ?? null,
    line: probe.line ?? null,
    column: probe.column ?? null,
  };
};

const runBatch = async (key: string, batch: PendingBatch): Promise<void> => {
  pendingBatches.delete(key);
  const texts = [...batch.requests.keys()];
  let probes: PathProbe[] = [];
  try {
    probes = batch.scope.taskId
      ? await probeTaskPaths(batch.scope.taskId, texts)
      : await probeProjectPaths(batch.scope.projectId ?? "", texts);
  } catch (error) {
    // A failed probe must not poison the cache: the reference simply stays
    // plain text and the next render retries.
    console.error("[path-link] probe failed:", error);
  }

  texts.forEach((text, index) => {
    const target = toTarget(probes[index]);
    const entryKey = cacheKey(key, text);
    if (probes.length > 0) {
      writeCache(entryKey, target);
    }
    inFlight.delete(entryKey);
    for (const resolve of batch.requests.get(text) ?? []) {
      resolve(target);
    }
  });
};

const enqueue = (
  scope: PathLinkScope,
  key: string,
  text: string,
): Promise<PathLinkTarget | null> =>
  new Promise((resolve) => {
    const existing = pendingBatches.get(key);
    const batch: PendingBatch = existing ?? {
      scope,
      requests: new Map(),
      timer: setTimeout(() => {
        const pending = pendingBatches.get(key);
        if (pending) void runBatch(key, pending);
      }, 0),
    };
    const waiting = batch.requests.get(text) ?? [];
    waiting.push(resolve);
    batch.requests.set(text, waiting);
    pendingBatches.set(key, batch);
  });

/**
 * Resolve `text` to something that exists, or `null`.
 *
 * Returns `null` synchronously-cheaply for non-candidates and for scopes that
 * cannot be resolved against (no task, no project).
 */
export const resolvePathLink = async (
  text: string,
  scope: PathLinkScope,
): Promise<PathLinkTarget | null> => {
  if (!looksLikeFilePath(text)) return null;
  const key = scopeKey(scope);
  if (!key) return null;

  const entryKey = cacheKey(key, text.trim());
  const cached = readCache(entryKey);
  if (cached) return cached.target;

  const pending = inFlight.get(entryKey);
  if (pending) return pending;

  const request = enqueue(scope, key, text.trim());
  inFlight.set(entryKey, request);
  return request;
};

/** Test seam: drop every cached and in-flight probe. */
export const resetPathLinkCache = (): void => {
  cache.clear();
  inFlight.clear();
  for (const batch of pendingBatches.values()) {
    clearTimeout(batch.timer);
  }
  pendingBatches.clear();
};
