/**
 * BrainRouter Memory Types — active-session messaging and delegation.
 *
 * Split out of the original `memory.ts` module and re-exported from the
 * `../memory.js` barrel so the public surface remains unchanged.
 */

import type { StoredDelegationPacket } from "../agent/delegation.js";

/**
 * Registry row for a connected client. Identity is the server-pinned
 * `(orgId, userId, sessionKey)` tuple. The optional organization keeps old
 * personal-session callers source compatible; storage normalizes an omitted
 * value to the personal tenant.
 */
export interface ActiveSessionRecord {
  orgId?: string | null;
  sessionKey: string;
  userId: string;
  /** Client self-report. Falls back to `http-unknown` when not identified. */
  clientKind: string;
  workspaceRoot: string;
  /** Persisted install identity used only for display and local-route merging. */
  deviceId?: string;
  /** Human-readable discovery label; never an address. */
  title?: string;
  titleSource?: "derived" | "agent" | "hook" | "human";
  state?: "idle" | "working" | "waiting";
  /** Version 1 means the bound MCP stream accepts message-id wake hints. */
  messageWakeVersion?: 1;
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

/** Renewable database ownership for one authenticated MCP transport. */
export interface ActiveSessionClaim {
  /** Server-minted transport identity; never accepted from tool arguments. */
  token: string;
}

/** Matches the default active-session heartbeat freshness window. */
export const ACTIVE_SESSION_CLAIM_LEASE_MS = 2 * 60 * 1000;

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

/** Recipient delivery and sender-receipt lifecycle. */
export const SESSION_MESSAGE_STATUSES = [
  "pending",
  "held",
  "applied",
  "rejected",
  "declined",
  "expired",
  "queue_full",
] as const;

export type SessionMessageStatus = (typeof SESSION_MESSAGE_STATUSES)[number];

export const SESSION_MESSAGE_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_MESSAGE_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MESSAGE_MAX_PENDING_PER_RECIPIENT = 100;
export const SESSION_MESSAGE_MAX_FANOUT = 100;

/** Fixed channel used by transaction-coupled Postgres notifications. */
export const SESSION_MESSAGE_NOTIFICATION_CHANNEL = "brainrouter_session_messages";

/**
 * Bounded notification payload emitted for every newly persisted receipt.
 * Postgres delivers it only after the surrounding transaction commits.
 */
export interface SessionMessageStoreNotification {
  version: 1;
  orgId: string | null;
  userId: string;
  fromSessionKey: string;
  toSessionKey: string;
  messageId: string;
  inboxId: string;
  status: SessionMessageStatus;
}

/**
 * One row in the brain's `session_inbox` table. Owned by the
 * recipient's user — the sending session puts a message in the
 * recipient's inbox, the recipient pulls or peeks.
 *
 * `toSessionKey` accepts three address shapes:
 *   - exact `sessionKey`            — point-to-point
 *   - `clientKind:*`                 — pattern broadcast
 *   - `*`                           — broadcast to every active session
 *                                     under the sender's userId
 *
 * The store fans out broadcast forms into one row per matched
 * recipient at send time. Each recipient sees a unique inbox id
 * and acks independently.
 */
export interface SessionInboxRecord {
  id: string;
  /** Server-pinned organization; null denotes the personal tenant. */
  orgId?: string | null;
  userId: string;
  /** Sender-generated idempotency key shared by every fanout receipt. */
  messageId?: string;
  fromSessionKey: string;
  toSessionKey: string;
  kind: SessionInboxKind;
  payload: Record<string, unknown>;
  status?: SessionMessageStatus;
  statusReason?: string | null;
  createdAt: string;
  updatedAt?: string;
  /** Pending and held messages become expired at this timestamp. */
  expiresAt?: string;
  /** Timestamp at which a terminal state was first recorded. */
  terminalAt?: string | null;
  /** Sender acknowledgement permits early receipt cleanup. */
  senderAcknowledgedAt?: string | null;
  /** ISO timestamp when the recipient's last non-peek read covered this id. NULL until then. */
  deliveredAt: string | null;
}

export interface SessionInboxFilters {
  /** Omitted values address the personal tenant for legacy callers. */
  orgId?: string | null;
  userId: string;
  toSessionKey: string;
  /** When `true`, include rows already marked delivered. Default `false`. */
  includeDelivered?: boolean;
  /** Explicit lifecycle filter. When omitted, default reads return `pending`. */
  statuses?: SessionMessageStatus[];
  /** Cap the page size. Default 50. */
  limit?: number;
  /** Server-owned connection claim used by authenticated MCP reads. */
  claimToken?: string;
}

export interface ActiveSessionFilters {
  /** Omitted values address the personal tenant unless `includeAllTenants` is true. */
  orgId?: string | null;
  /** Administrative diagnostics only; normal callers stay in one tenant. */
  includeAllTenants?: boolean;
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

/** Legacy send shape retained while handlers migrate to `routeSessionMessage`. */
export interface LegacySessionMessageSendInput {
  orgId?: string | null;
  userId: string;
  messageId?: string;
  fromSessionKey: string;
  toSessionKey: string;
  kind: SessionInboxKind;
  payload: Record<string, unknown>;
}

/** Strong send shape. All authority fields must come from server-owned context. */
export interface SessionMessageSendInput {
  orgId: string | null;
  userId: string;
  /** Sender-generated idempotency key. Reuse with different content is rejected. */
  messageId: string;
  fromSessionKey: string;
  toSessionKey: string;
  kind: SessionInboxKind;
  payload: Record<string, unknown>;
  /** Server-owned connection claim used to authorize the sender atomically. */
  senderClaimToken?: string;
}

export interface SessionMessageRouteOptions {
  /** Receipt ids are store-owned; callers provide this only for deterministic tests. */
  receiptIdGenerator?: () => string;
  /** Message lifecycle timestamp test seam; never used for session ownership. */
  now?: string;
}

export interface LegacySessionMessageSendOptions {
  /** Legacy receipt-id hook retained for deterministic tests. */
  idGenerator?: () => string;
  now?: string;
}

export type SessionMessageRejectionReason =
  | "sender_not_active"
  | "recipient_not_active"
  | "no_active_recipient"
  | "self_send"
  | "fanout_limit_exceeded"
  | "queue_full";

/** Current aggregate state returned by an idempotent session send. */
export type SessionMessageSendState =
  | "persisted-unseen"
  | "held"
  | "applied"
  | "declined"
  | "expired"
  | "not-queued"
  | "mixed";

export interface SessionMessageSendResult {
  messageId: string;
  /** Derived from the persisted receipt statuses, including on retries. */
  state: SessionMessageSendState;
  /** Rows a recipient may currently consume. */
  deliveries: SessionInboxRecord[];
  /** All durable rows, including rejection and queue-full receipts. */
  receipts: SessionInboxRecord[];
  /** Receipts that were durably accepted, including held or terminal outcomes. */
  accepted: number;
  rejected: number;
  idempotentReplay: boolean;
  /** Non-durable when the untrusted sender session itself is not active. */
  rejectionReason?: SessionMessageRejectionReason;
}

export interface SessionMessageReceiptFilters {
  orgId: string | null;
  userId: string;
  fromSessionKey: string;
  messageId?: string;
  statuses?: SessionMessageStatus[];
  limit?: number;
  /** Server-owned connection claim used by authenticated MCP reads. */
  claimToken?: string;
}

export interface SessionMessageTransitionInput {
  orgId: string | null;
  userId: string;
  toSessionKey: string;
  ids: string[];
  toStatus: "held" | "applied" | "rejected" | "declined" | "expired" | "queue_full";
  reason?: string;
  at: string;
  /** Server-owned connection claim used by authenticated MCP transitions. */
  claimToken?: string;
}

export interface SessionMessageReceiptAckInput {
  orgId: string | null;
  userId: string;
  fromSessionKey: string;
  ids: string[];
  at: string;
  /** Server-owned connection claim used by authenticated MCP acknowledgements. */
  claimToken?: string;
}

export type PendingDelegationStatus = "pending" | "claimed" | "cancelled" | "expired";

/** One row in the brain's `pending_delegations` table (FED-S5-T2 fallback). */
export interface PendingDelegationRecord {
  id: string;
  userId: string;
  fromSessionKey: string;
  /** The requested client/agent kind. */
  toAgentKind: string;
  /** Concrete recipient once claimed; NULL while pending. */
  toSessionKey: string | null;
  packet: StoredDelegationPacket;
  status: PendingDelegationStatus;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
}

export interface PendingDelegationEnqueueInput {
  userId: string;
  fromSessionKey: string;
  toAgentKind: string;
  packet: StoredDelegationPacket;
}

export interface PendingDelegationFilters {
  userId: string;
  /** Restrict to delegations addressed at this agent kind. */
  toAgentKind?: string;
  status?: PendingDelegationStatus;
  limit?: number;
}
