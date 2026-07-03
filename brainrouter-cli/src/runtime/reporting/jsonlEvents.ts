/**
 * CLI-7 (0.4.3) — stable headless event stream for `brainrouter run --format jsonl`.
 *
 * One JSON object per line, each tagged with a schema version `v` and an ISO
 * `ts`, so CI and external orchestrators can parse a turn's progress as it
 * happens. The event shapes here ARE the contract — additive changes only;
 * bump `JSONL_SCHEMA_VERSION` for anything breaking.
 *
 * Pure: `formatJsonlEvent` takes the timestamp as an argument (no Date.now)
 * so it's deterministic and unit-testable; the caller stamps real time.
 */

// v2 (0.4.5, HEADLESS-EVENTS) — additive: five new event types (memory,
// offload, cost_update, approval, code_index). All v1 events are unchanged, so
// v1 consumers keep working; the bump signals "more event types may appear".
export const JSONL_SCHEMA_VERSION = 2;

export type RunEvent =
  | { type: "turn_start"; sessionKey: string; prompt: string }
  | { type: "status"; message: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; ok: boolean; summary: string }
  | { type: "child_tool"; childId: string; role: string; tool: string; ok?: boolean; summary?: string }
  | { type: "child_complete"; childId: string; role: string; status: "completed" | "failed"; error?: string; worktree?: { changedFiles?: number; applied?: boolean; patchPath?: string; applyError?: string } }
  | { type: "text"; text: string }
  | { type: "turn_end"; sessionKey: string; durationMs: number; usage: { promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number; missedTokens?: number }; costUsd?: number }
  | { type: "error"; message: string }
  // ---- HEADLESS-EVENTS (0.4.5) -----------------------------------------
  /** The brain's automatic memory pipeline ran (recall briefing / capture /
   *  citation) — hidden from the LLM tool stream but surfaced here. */
  | { type: "memory"; op: "briefing" | "capture" | "citation"; records?: number; sources?: string[]; extracted?: number }
  /** A working-memory payload was offloaded out of the LLM context. */
  | { type: "offload"; tool: string; ok: boolean; summary: string }
  /** Running token/cost tally, emitted per LLM call within the turn. */
  | { type: "cost_update"; promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number; missedTokens?: number; costUsd?: number }
  /** Exec-policy decision for a mutating tool (allow / ask / deny). */
  | { type: "approval"; tool: string; action: string; decision: "allow" | "ask" | "deny"; reason?: string }
  /** The code index was refreshed for a file (CLI-REINDEX). */
  | { type: "code_index"; file: string; status: "reindexed"; chunks?: number };

/** The stable set of event type tags (for consumers + schema tests). */
export const RUN_EVENT_TYPES = [
  "turn_start", "status", "tool_start", "tool_end",
  "child_tool", "child_complete", "text", "turn_end", "error",
  "memory", "offload", "cost_update", "approval", "code_index",
] as const;

/** Render one event as a single JSONL line (no trailing newline). */
export function formatJsonlEvent(event: RunEvent, ts: string): string {
  return JSON.stringify({ v: JSONL_SCHEMA_VERSION, ts, ...event });
}

/**
 * Map the agent's internal MemoryEvent onto a headless `memory` event. Returns
 * null for kinds without a stable headless mapping (skipped / contradiction),
 * so the caller can `if (ev) emit(ev)`. Pure + structurally typed so it doesn't
 * import the agent.
 */
export function memoryRunEvent(ev: {
  kind: string;
  recordCount?: number;
  sources?: string[];
  extractedCount?: number;
  recordIds?: string[];
}): Extract<RunEvent, { type: "memory" }> | null {
  switch (ev.kind) {
    case "briefing":
      return { type: "memory", op: "briefing", records: ev.recordCount ?? 0, sources: ev.sources ?? [] };
    case "capture":
      return { type: "memory", op: "capture", extracted: ev.extractedCount ?? 0 };
    case "citation":
      return { type: "memory", op: "citation", records: ev.recordIds?.length ?? 0 };
    default:
      return null;
  }
}

/** True for the working-memory offload tool, so a completed call can also emit
 *  a dedicated `offload` event. */
export function isOffloadTool(name: string): boolean {
  return name === "memory_working_offload";
}
