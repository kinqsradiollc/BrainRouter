/**
 * MAS-P5-T2 (0.4.2) — progressive result handoff.
 *
 * Generalizes the child-output OFFLOAD pattern (orchestration/tools.ts)
 * into a reusable primitive for ANY large tool result. When a result
 * exceeds the threshold the model sees a compact preview plus a
 * `resultRef` it can expand on demand via the `extract_result` tool —
 * instead of either dumping the whole blob into context or hard-truncating
 * it and losing the tail.
 *
 * Two tiers of storage:
 *   - a per-session in-memory {@link ResultCache} (TTL'd) for the common
 *     "the model wants to grep the output it just got" case — zero brain
 *     round-trip;
 *   - durable handoff via `memory_working_offload` (the brain) when the
 *     result should survive the session. The brain boundary is preserved:
 *     this module never writes cognitive records, it only formats + caches.
 *
 * Pure + injectable-clock so it unit-tests without a live brain or wall
 * clock.
 */

import { estimateTokens } from "./tokenEstimate.js";

/** ~6k chars ≈ 1.5k tokens — small reports stay inline, big blobs hand off. */
export const RESULT_HANDOFF_THRESHOLD_CHARS = 6000;
export const RESULT_PREVIEW_CHARS = 800;
/** Session cache TTL — long enough to grep a result across a few turns. */
export const RESULT_CACHE_TTL_MS = 30 * 60 * 1000;

export interface ResultHandoff {
  /** Stable id the model passes to `extract_result`. */
  resultRef: string;
  /** Head slice shown inline so the model has immediate context. */
  preview: string;
  /** Full result size in chars. */
  bytes: number;
  /** Rough token cost of the FULL result (what handoff saves). */
  estimatedTokens: number;
}

export function shouldHandoff(text: string, threshold = RESULT_HANDOFF_THRESHOLD_CHARS): boolean {
  return typeof text === "string" && text.length >= threshold;
}

let refCounter = 0;
function defaultRef(): string {
  // Monotonic + a cheap suffix; uniqueness only needs to hold within a
  // session cache. (Math.random is fine in runtime code.)
  refCounter = (refCounter + 1) % 1_000_000;
  return `res_${refCounter.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

/**
 * Build a handoff descriptor for `text`. Returns the descriptor plus the
 * untouched `full` text (the caller decides where to store it — session
 * cache and/or durable offload).
 */
export function makeResultHandoff(
  text: string,
  opts?: { previewChars?: number; idGenerator?: () => string },
): { handoff: ResultHandoff; full: string } {
  const previewChars = opts?.previewChars ?? RESULT_PREVIEW_CHARS;
  const resultRef = (opts?.idGenerator ?? defaultRef)();
  const preview = text.length > previewChars ? text.slice(0, previewChars) : text;
  return {
    handoff: {
      resultRef,
      preview,
      bytes: text.length,
      estimatedTokens: estimateTokens(text),
    },
    full: text,
  };
}

/**
 * The string the model sees in place of the full result: the preview plus
 * a one-line footer telling it how to expand. `workingRef` (a durable
 * `memory_working_offload` ref) is mentioned when present.
 */
export function formatHandoffForModel(
  handoff: ResultHandoff,
  opts?: { label?: string; workingRef?: string },
): string {
  const label = opts?.label ? `${opts.label} ` : "";
  const durable = opts?.workingRef ? ` · durable ref=${opts.workingRef}` : "";
  return (
    `${handoff.preview}\n\n` +
    `[${label}output truncated — resultRef=${handoff.resultRef} · ${handoff.bytes} bytes · ` +
    `~${handoff.estimatedTokens} tokens${durable}. ` +
    `Call extract_result({ resultRef: "${handoff.resultRef}", query }) to search the full output.]`
  );
}

interface CacheEntry {
  text: string;
  expiresAt: number;
  lastAccess: number;
}

/** MEM-22 — what a reclaim pass freed. */
export interface ReclaimStats {
  /** Entries removed because their TTL elapsed. */
  expired: number;
  /** Entries evicted to stay under maxEntries (least-recently-used first). */
  evicted: number;
  /** Total chars freed. */
  bytesReclaimed: number;
  /** Entries kept despite being expired/over-cap because they were protected. */
  protectedKept: number;
  /** Entries remaining after the pass. */
  remaining: number;
}

/**
 * Per-session, TTL'd in-memory store of full tool results keyed by `resultRef`.
 *
 * MEM-22 — a proper reclaimer that PROTECTS ACTIVE refs. Eviction (both the
 * put-time overflow guard and the explicit `reclaim` pass) drops the
 * LEAST-RECENTLY-USED entry, and `reclaim(protect)` never removes a ref in the
 * protected set even when it's expired or over the cap. `get` counts as a use,
 * so a ref the model keeps expanding stays resident. Retention (ttlMs /
 * maxEntries) is configurable via `cli.offloadRetentionMs` /
 * `cli.offloadMaxEntries`.
 */
export class ResultCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = RESULT_CACHE_TTL_MS,
    private readonly maxEntries: number = 64,
    private readonly now: () => number = () => Date.now(),
  ) {}

  put(resultRef: string, text: string): void {
    this.sweep();
    const t = this.now();
    if (!this.entries.has(resultRef) && this.entries.size >= this.maxEntries) {
      this.evictLru(this.entries.size - this.maxEntries + 1);
    }
    this.entries.set(resultRef, { text, expiresAt: t + this.ttlMs, lastAccess: t });
  }

  get(resultRef: string): string | undefined {
    const entry = this.entries.get(resultRef);
    if (!entry) return undefined;
    const t = this.now();
    if (entry.expiresAt <= t) {
      this.entries.delete(resultRef);
      return undefined;
    }
    // A use protects the ref: bump LRU recency AND slide the TTL window, so a
    // ref the model keeps expanding never expires out from under it (MEM-22).
    entry.lastAccess = t;
    entry.expiresAt = t + this.ttlMs;
    return entry.text;
  }

  has(resultRef: string): boolean {
    return this.get(resultRef) !== undefined;
  }

  size(): number {
    this.sweep();
    return this.entries.size;
  }

  /** Drop expired entries; returns how many were removed. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [ref, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(ref);
        removed++;
      }
    }
    return removed;
  }

  /** Evict the `count` least-recently-used entries NOT in `protect`; returns
   * how many were removed + the chars freed. */
  private evictLru(count: number, protect?: ReadonlySet<string>): { evicted: number; bytes: number } {
    if (count <= 0) return { evicted: 0, bytes: 0 };
    const candidates = [...this.entries.entries()]
      .filter(([ref]) => !protect?.has(ref))
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess); // LRU first (stable for equal stamps)
    let evicted = 0;
    let bytes = 0;
    for (const [ref, entry] of candidates) {
      if (evicted >= count) break;
      this.entries.delete(ref);
      evicted++;
      bytes += entry.text.length;
    }
    return { evicted, bytes };
  }

  /**
   * MEM-22 — retention pass. Removes expired entries (unless protected), then
   * evicts least-recently-used entries beyond maxEntries (never a protected
   * ref). `protect` is the set of refs still live in the model's context.
   */
  reclaim(protect?: ReadonlySet<string>): ReclaimStats {
    const now = this.now();
    let expired = 0;
    let bytesReclaimed = 0;
    let protectedKept = 0;
    for (const [ref, entry] of [...this.entries]) {
      if (entry.expiresAt <= now) {
        if (protect?.has(ref)) {
          // Protected (still live in context) → refresh its window so get/sweep
          // stay coherent and don't immediately re-expire it.
          entry.expiresAt = now + this.ttlMs;
          protectedKept++;
          continue;
        }
        this.entries.delete(ref);
        expired++;
        bytesReclaimed += entry.text.length;
      }
    }
    let evicted = 0;
    if (this.entries.size > this.maxEntries) {
      const r = this.evictLru(this.entries.size - this.maxEntries, protect);
      evicted = r.evicted;
      bytesReclaimed += r.bytes;
    }
    return { expired, evicted, bytesReclaimed, protectedKept, remaining: this.entries.size };
  }
}
