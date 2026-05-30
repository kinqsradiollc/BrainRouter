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

export const JSONL_SCHEMA_VERSION = 1;

export type RunEvent =
  | { type: "turn_start"; sessionKey: string; prompt: string }
  | { type: "status"; message: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; ok: boolean; summary: string }
  | { type: "child_tool"; childId: string; role: string; tool: string; ok?: boolean; summary?: string }
  | { type: "child_complete"; childId: string; role: string; status: "completed" | "failed"; error?: string }
  | { type: "text"; text: string }
  | { type: "turn_end"; sessionKey: string; durationMs: number; usage: { promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number; missedTokens?: number }; costUsd?: number }
  | { type: "error"; message: string };

/** The stable set of event type tags (for consumers + schema tests). */
export const RUN_EVENT_TYPES = [
  "turn_start", "status", "tool_start", "tool_end",
  "child_tool", "child_complete", "text", "turn_end", "error",
] as const;

/** Render one event as a single JSONL line (no trailing newline). */
export function formatJsonlEvent(event: RunEvent, ts: string): string {
  return JSON.stringify({ v: JSONL_SCHEMA_VERSION, ts, ...event });
}
