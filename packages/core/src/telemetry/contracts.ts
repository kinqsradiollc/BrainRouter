/**
 * Local-first telemetry contracts.
 *
 * PRIVACY CONTRACT (read before adding a callsite): this module stores ONLY
 * metadata — event names, coarse counters, latency in milliseconds, ok/error
 * flags, and small primitive `props`. It MUST NEVER carry message content,
 * file content, prompts, diffs, secrets, API keys, tokens, or any other
 * sensitive payload. Callers are responsible for keeping it that way: pass
 * shapes/counts (e.g. `{ files: 3, bytes: 1200 }`), never the bytes
 * themselves. The sink writes plain JSONL to the user's local home and never
 * touches the network.
 */

export interface TelemetryEvent {
  /** Stable per-event id, e.g. `tel_1a2b3c4d`. */
  id: string;
  /** Event name — one of `TELEMETRY_EVENTS` for first-party events. */
  name: string;
  /** ISO-8601 timestamp the event was recorded. */
  at: string;
  /** Absolute workspace root the event belongs to (optional). */
  workspaceRoot?: string;
  /** Opaque session key (optional) — never a secret. */
  sessionKey?: string;
  /** Coarse task classification (optional), e.g. `build`, `review`. */
  taskKind?: string;
  /** Wall-clock duration in milliseconds (optional). */
  durationMs?: number;
  /** Whether the underlying operation succeeded (optional). */
  ok?: boolean;
  /** Short error label/message (optional) — keep it free of secrets/content. */
  error?: string;
  /**
   * Small bag of primitive metadata (optional). Values must be string |
   * number | boolean — counts/shapes, NEVER content or secrets.
   */
  props?: Record<string, string | number | boolean>;
}

/**
 * Canonical first-party event names. Each value equals its key in snake_case
 * so callers can reference `TELEMETRY_EVENTS.task_started` and get the wire
 * string `"task_started"`.
 */
export const TELEMETRY_EVENTS = {
  task_created: 'task_created',
  task_started: 'task_started',
  task_completed: 'task_completed',
  task_failed: 'task_failed',
  plan_revision_started: 'plan_revision_started',
  plan_revision_completed: 'plan_revision_completed',
  review_started: 'review_started',
  review_completed: 'review_completed',
  attachment_ingested: 'attachment_ingested',
  memory_captured: 'memory_captured',
  git_refresh: 'git_refresh',
  workspace_refresh: 'workspace_refresh',
  error: 'error',
} as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[keyof typeof TELEMETRY_EVENTS];

function isPrimitive(x: unknown): x is string | number | boolean {
  return typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';
}

/**
 * Structural type guard for a persisted telemetry record. Verifies the
 * required string fields, that every optional field (when present) has the
 * right type, and that `props` (when present) is a plain object of
 * primitives. Used by the file adapter to skip corrupt JSONL lines.
 */
export function isTelemetryEvent(x: unknown): x is TelemetryEvent {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  if (typeof e.id !== 'string') return false;
  if (typeof e.name !== 'string') return false;
  if (typeof e.at !== 'string') return false;
  if (e.workspaceRoot !== undefined && typeof e.workspaceRoot !== 'string') return false;
  if (e.sessionKey !== undefined && typeof e.sessionKey !== 'string') return false;
  if (e.taskKind !== undefined && typeof e.taskKind !== 'string') return false;
  if (e.durationMs !== undefined && typeof e.durationMs !== 'number') return false;
  if (e.ok !== undefined && typeof e.ok !== 'boolean') return false;
  if (e.error !== undefined && typeof e.error !== 'string') return false;
  if (e.props !== undefined) {
    if (typeof e.props !== 'object' || e.props === null || Array.isArray(e.props)) return false;
    for (const value of Object.values(e.props as Record<string, unknown>)) {
      if (!isPrimitive(value)) return false;
    }
  }
  return true;
}
