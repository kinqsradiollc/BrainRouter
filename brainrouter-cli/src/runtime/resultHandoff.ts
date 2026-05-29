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
}

/**
 * Per-session, TTL'd in-memory store of full tool results keyed by
 * `resultRef`. Bounded by both TTL and a max-entry cap (oldest evicted)
 * so a long session can't grow it unbounded.
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
    if (this.entries.size >= this.maxEntries) {
      // Evict the oldest insertion (Map preserves insertion order).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(resultRef, { text, expiresAt: this.now() + this.ttlMs });
  }

  get(resultRef: string): string | undefined {
    const entry = this.entries.get(resultRef);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(resultRef);
      return undefined;
    }
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
}
