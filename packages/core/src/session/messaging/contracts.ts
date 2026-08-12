/**
 * ADR-034 local session-messaging contracts.
 *
 * These records are presentation-neutral so CLI and Desktop can share one
 * address space. A title is discovery metadata only: every delivery contract
 * carries the exact session key that the recipient must verify.
 */

export const LOCAL_SESSION_PROTOCOL = 'session-messaging/v1';
export const LOCAL_SESSION_HOST = '127.0.0.1';
export const LOCAL_SESSION_AUTH_HEADER = 'x-brainrouter-session-token';
export const LOCAL_SESSION_MAX_BODY_BYTES = 64 * 1024;
export const LOCAL_SESSION_MAX_TEXT_BYTES = 20_000;
export const LOCAL_SESSION_DEFAULT_QUEUE_DEPTH = 100;
export const LOCAL_SESSION_DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const LOCAL_SESSION_MAX_ACCEPTED_IDS = 1_000;

export type LocalSessionClientKind = 'cli' | 'desktop';
export type LocalSessionActivityState = 'idle' | 'working' | 'waiting';
export type SessionRouteTransport = 'local' | 'remote';

export interface SessionRouteDescriptor {
  sessionKey: string;
  deviceId: string;
  clientKind: LocalSessionClientKind;
  state: LocalSessionActivityState;
  transport: SessionRouteTransport;
  lastSeenAt: number;
  workspaceRoot?: string;
  title?: string;
  /** More than one live process claimed the same exact key; sends must refuse. */
  ambiguous?: boolean;
  instanceCount?: number;
}

export interface LocalSessionMessageInput {
  senderSessionKey: string;
  text: string;
  id?: string;
  createdAt?: number;
}

/** Transport-neutral peer envelope accepted by a recipient session inbox. */
export interface PeerSessionMessageInput {
  id: string;
  senderSessionKey: string;
  senderDeviceId: string;
  targetSessionKey: string;
  text: string;
  createdAt: number;
  /**
   * Optional authoritative absolute deadline (epoch milliseconds). Remote
   * inbox adapters copy the database row's `expiresAt`; local loopback sends
   * omit it and retain the receiver-time 24-hour lifecycle.
   */
  expiresAt?: number;
}

/** Inbound content is always untrusted, regardless of the carrying transport. */
export interface LocalSessionMessage extends PeerSessionMessageInput {
  source: 'peer-session';
  trust: 'untrusted-session';
  receivedAt: number;
}

export interface LocalMessageExpiryNotice {
  messageId: string;
  senderSessionKey: string;
  expiredAt: number;
}

export interface LocalMailboxDrain {
  messages: LocalSessionMessage[];
  expired: LocalMessageExpiryNotice[];
  /** Older notices omitted to keep the notice queue bounded too. */
  expiredOmitted: number;
}

export interface LocalSessionRegistrationPatch {
  state?: LocalSessionActivityState;
  workspaceRoot?: string;
  title?: string;
}

export interface LocalQueuedReceipt {
  queued: true;
  status: 'queued';
  transport: 'local';
  messageId: string;
  targetSessionKey: string;
  acceptedAt: number;
  pending: number;
  /** True when this id was accepted earlier and was not enqueued again. */
  duplicate: boolean;
}

export type LocalDeliveryFailureReason =
  | 'not_found'
  | 'unreachable'
  | 'ambiguous'
  | 'queue_full'
  | 'expired'
  | 'payload_too_large'
  | 'invalid_message'
  | 'self_send'
  | 'id_conflict'
  | 'rejected';

export interface LocalNotQueuedReceipt {
  queued: false;
  status: 'not_queued';
  transport: 'local';
  targetSessionKey: string;
  reason: LocalDeliveryFailureReason;
  messageId?: string;
}

/** Receipt for local mailbox admission, never a claim that a model consumed it. */
export type LocalDeliveryReceipt = LocalQueuedReceipt | LocalNotQueuedReceipt;
