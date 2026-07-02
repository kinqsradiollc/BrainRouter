/**
 * BrainRouter Memory Types — federation / active-session + delegation.
 *
 * Cross-CLI session registry, inbox messaging, and cross-vendor
 * delegation payloads. Split out of the original `memory.ts` god file;
 * re-exported from the `../memory.js` barrel so the public surface is
 * unchanged.
 */

/**
 * Federation Stage 2 (0.4.0) — registry row for a CLI / MCP client that
 * is currently attached to the brain. Identity is the composite
 * `(sessionKey, userId)` so a misbehaving client can't accidentally
 * stomp another user's session by reusing the same key.
 */
export interface ActiveSessionRecord {
  sessionKey: string;
  userId: string;
  /**
   * Client self-report. Known kinds: `brainrouter-cli`, `claude-code`,
   * `codex`, `cursor`, `gemini-cli`. Falls back to `http-unknown` when
   * a client connects over HTTP without identifying itself.
   */
  clientKind: string;
  workspaceRoot: string;
  /** ISO timestamp; never updated after registration. */
  startedAt: string;
  /** ISO timestamp; bumped on every heartbeat. */
  lastHeartbeatAt: string;
  metadata: Record<string, unknown>;
  /**
   * Optional usage snapshot (FED-S2-T8). Last-write-wins on heartbeat;
   * NULL when the client doesn't report telemetry. Same shape the CLI
   * surfaces via `/tokens`.
   */
  usage?: ActiveSessionUsage | null;
}

export interface ActiveSessionUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  totalUsd?: number;
  cacheSavingsUsd?: number;
  /** ISO timestamp of the snapshot the client sent. */
  updatedAt: string;
}

/**
 * Federation Stage 3 (0.4.0) — cross-CLI messaging payload kinds.
 *
 * `text` is the only kind a Stage 3 CLI consumer renders today (via
 * `/dm` and `/broadcast`). The other four are schema-reserved so
 * Stage 4 (cross-vendor delegate) and CLI Multi-Agent Phase 2
 * (goal handoff between sessions) can carry richer payloads without
 * a schema migration.
 */
export type SessionInboxKind =
  | "text"
  | "tool-result"
  | "memory-ref"
  | "goal-handoff"
  | "delegate";

/**
 * One row in the brain's `session_inbox` table. Owned by the
 * recipient's user — the sending session puts a message in the
 * recipient's inbox, the recipient pulls or peeks.
 *
 * `toSessionKey` accepts three address shapes:
 *   - exact `sessionKey`            — point-to-point
 *   - `clientKind:*` (e.g. `codex:*`) — pattern broadcast
 *   - `*`                           — broadcast to every active session
 *                                     under the sender's userId
 *
 * The store fans out broadcast forms into one row per matched
 * recipient at send time. Each recipient sees a unique inbox id
 * and acks independently.
 */
export interface SessionInboxRecord {
  id: string;
  userId: string;
  fromSessionKey: string;
  toSessionKey: string;
  kind: SessionInboxKind;
  payload: Record<string, unknown>;
  createdAt: string;
  /** ISO timestamp when the recipient's last non-peek read covered this id. NULL until then. */
  deliveredAt: string | null;
}

export interface SessionInboxFilters {
  userId: string;
  toSessionKey: string;
  /** When `true`, include rows already marked delivered. Default `false`. */
  includeDelivered?: boolean;
  /** Cap the page size. Default 50. */
  limit?: number;
}

export interface ActiveSessionFilters {
  userId?: string;
  clientKind?: string;
  workspaceRoot?: string;
  /**
   * When false (default), exclude rows whose lastHeartbeatAt is older
   * than `staleThresholdMs` (default 120000 = 2 min). When true, return
   * everything in the table — useful for diagnostics + the sweeper.
   */
  includeStale?: boolean;
  staleThresholdMs?: number;
  /** When true, include the `usage` field in returned rows (FED-S2-T8). */
  includeUsage?: boolean;
}

/**
 * Federation Stage 5 (0.4.2) — FED-S5-T1. Normalized cross-vendor
 * delegation payload. A `delegate_task` packages a self-contained unit of
 * work that any peer (BrainRouter CLI, Claude Code, Codex, …) can pick up,
 * independent of the originating vendor. Carried on the `delegate` inbox
 * kind, or persisted as a `pending_delegation` row when no peer is idle.
 */
export interface DelegationPacket {
  /** The task to perform. */
  goal: string;
  /** Sender's federation sessionKey. */
  fromSessionKey: string;
  /** Sender's clientKind (e.g. `brainrouter-cli`, `codex`). */
  originatingClient: string;
  /** Sender's workspace root. */
  originatingWorkspace: string;
  /** Files the task concerns (paths relative to the receiver's workspace). */
  files: string[];
  /** Free-form constraint lines ("don't touch the public API", "TS strict"). */
  constraints: string[];
  /** Model-preference hints ("prefer:reasoning", "avoid:nano"). Advisory. */
  modelHints: string[];
  /** Optional budget ceiling. */
  budget: { tokens?: number; usd?: number } | null;
  /** Optional ISO deadline. */
  deadline: string | null;
  /** Optional free-text note. */
  note?: string;
  /** ISO timestamp. */
  createdAt: string;
}

export type PendingDelegationStatus = "pending" | "claimed" | "cancelled" | "expired";

/** One row in the brain's `pending_delegations` table (FED-S5-T2 fallback). */
export interface PendingDelegationRecord {
  id: string;
  userId: string;
  fromSessionKey: string;
  /** The requested vendor/agent kind (e.g. `codex`, `claude-code`). */
  toAgentKind: string;
  /** Concrete recipient once claimed; NULL while pending. */
  toSessionKey: string | null;
  packet: DelegationPacket;
  status: PendingDelegationStatus;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
}

export interface PendingDelegationEnqueueInput {
  userId: string;
  fromSessionKey: string;
  toAgentKind: string;
  packet: DelegationPacket;
}

export interface PendingDelegationFilters {
  userId: string;
  /** Restrict to delegations addressed at this agent kind. */
  toAgentKind?: string;
  status?: PendingDelegationStatus;
  limit?: number;
}
