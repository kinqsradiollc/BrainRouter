import { createHash } from "node:crypto";

export const REMOTE_DEVICE_KINDS = ["desktop", "mobile"] as const;
export type RemoteDeviceKind = (typeof REMOTE_DEVICE_KINDS)[number];

export const REMOTE_DEVICE_STATUSES = ["active", "disabled", "revoked"] as const;
export type RemoteDeviceStatus = (typeof REMOTE_DEVICE_STATUSES)[number];

export const REMOTE_ACCESS_SCOPES = ["monitor", "control", "approve"] as const;
export type RemoteAccessScope = (typeof REMOTE_ACCESS_SCOPES)[number];

export const REMOTE_GRANT_DECISIONS = ["approved", "denied"] as const;
export type RemoteGrantDecision = (typeof REMOTE_GRANT_DECISIONS)[number];
export type RemoteGrantStatus = "pending" | RemoteGrantDecision;

export const REMOTE_AUDIT_EVENTS = [
  "device_enrolled",
  "device_disabled",
  "device_revoked",
  "session_created",
  "session_rotated",
  "session_reuse_detected",
  "session_revoked",
  "grant_requested",
  "grant_approved",
  "grant_denied",
  "grant_revoked",
  "connection_opened",
  "connection_closed",
  "scope_changed",
] as const;
export type RemoteAuditEventType = (typeof REMOTE_AUDIT_EVENTS)[number];

export interface RemoteDeviceRecord {
  id: string;
  orgId: string;
  userId: string;
  /** Stable installation identity. Never an active workspace/session id. */
  installationId: string;
  kind: RemoteDeviceKind;
  displayName: string;
  publicKey: string;
  publicKeyFingerprint: string;
  keyAlgorithm: "ed25519";
  status: RemoteDeviceStatus;
  enrolledAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteDeviceInput {
  installationId: string;
  kind: RemoteDeviceKind;
  displayName: string;
  /** Base64/base64url or PEM-encoded Ed25519 public key. Private keys never cross this boundary. */
  publicKey: string;
}

/** Metadata returned to callers. The stored token hash is intentionally absent. */
export interface DeviceSessionRecord {
  id: string;
  familyId: string;
  orgId: string;
  userId: string;
  deviceId: string;
  generation: number;
  parentSessionId: string | null;
  replacedBySessionId: string | null;
  expiresAt: string;
  rotatedAt: string | null;
  reuseDetectedAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceSessionInput {
  deviceId: string;
  /** SHA-256 digest from {@link hashDeviceRefreshToken}; never the reusable token. */
  tokenHash: string;
  expiresAt: string;
  familyId?: string;
}

export interface DeviceSessionRotationInput {
  /** Hash of the presented token. The raw refresh token is never persisted or logged. */
  tokenHash: string;
  nextTokenHash: string;
  nextExpiresAt: string;
}

export type DeviceSessionRotationResult =
  | { status: "rotated"; session: DeviceSessionRecord }
  | { status: "invalid" | "expired" | "revoked" | "reuse-detected" };

export interface RemoteAccessGrantRecord {
  id: string;
  orgId: string;
  userId: string;
  desktopDeviceId: string;
  mobileDeviceId: string;
  scopes: RemoteAccessScope[];
  approvalStatus: RemoteGrantStatus;
  decidedAt: string | null;
  decidedByDeviceId: string | null;
  expiresAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteAccessGrantInput {
  desktopDeviceId: string;
  mobileDeviceId: string;
  scopes: RemoteAccessScope[];
  expiresAt: string;
}

/** Fixed-column audit input. Arbitrary metadata/content is deliberately unsupported. */
export interface RemoteAccessAuditInput {
  eventType: RemoteAuditEventType;
  actorDeviceId?: string | null;
  targetDeviceId?: string | null;
  grantId?: string | null;
  sessionFamilyId?: string | null;
  scopes?: RemoteAccessScope[];
  reasonCode?: string | null;
  requestId?: string | null;
}

export interface RemoteAccessAuditRecord extends RemoteAccessAuditInput {
  id: string;
  orgId: string;
  userId: string;
  actorDeviceId: string | null;
  targetDeviceId: string | null;
  grantId: string | null;
  sessionFamilyId: string | null;
  scopes: RemoteAccessScope[];
  reasonCode: string | null;
  requestId: string | null;
  createdAt: string;
}

/** Hash-only, short-lived enrollment challenge persistence. */
export interface RemoteEnrollmentChallengeInput extends RemoteDeviceInput {
  challengeHash: string;
  expiresAt: string;
}

export interface RemoteEnrollmentChallengeRecord extends RemoteDeviceInput {
  id: string;
  orgId: string;
  userId: string;
  publicKeyFingerprint: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

/** Internal persistence input. The opaque relay ticket itself is never stored. */
export interface RemoteRelayTicketInput {
  tokenHash: string;
  presentingDeviceId: string;
  peerDeviceId: string;
  grantId: string;
  deviceSessionId: string;
  audience: "remote-relay";
  scopes: RemoteAccessScope[];
  expiresAt: string;
}

/** Relay authorization metadata. The stored token hash is intentionally absent. */
export interface RemoteRelayTicketRecord {
  id: string;
  orgId: string;
  userId: string;
  presentingDeviceId: string;
  peerDeviceId: string;
  grantId: string;
  sessionFamilyId: string;
  audience: "remote-relay";
  scopes: RemoteAccessScope[];
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  createdAt: string;
}

export interface RemoteRelayTicketRevocation {
  deviceId?: string;
  grantId?: string;
  sessionFamilyId?: string;
}

export interface RemoteAccessStore {
  createRemoteDevice(orgId: string, userId: string, input: RemoteDeviceInput): Promise<RemoteDeviceRecord>;
  getRemoteDevice(orgId: string, userId: string, deviceId: string): Promise<RemoteDeviceRecord | null>;
  getRemoteDeviceByInstallation(orgId: string, userId: string, installationId: string): Promise<RemoteDeviceRecord | null>;
  listRemoteDevices(orgId: string, userId: string, kind?: RemoteDeviceKind): Promise<RemoteDeviceRecord[]>;
  touchRemoteDevice(orgId: string, userId: string, deviceId: string, at?: string): Promise<boolean>;
  revokeRemoteDevice(orgId: string, userId: string, deviceId: string, reasonCode: string, at?: string): Promise<boolean>;

  createDeviceSession(orgId: string, userId: string, input: DeviceSessionInput): Promise<DeviceSessionRecord>;
  getDeviceSession(orgId: string, userId: string, sessionId: string): Promise<DeviceSessionRecord | null>;
  getDeviceSessionByTokenHash(orgId: string, userId: string, tokenHash: string): Promise<DeviceSessionRecord | null>;
  rotateDeviceSession(orgId: string, userId: string, input: DeviceSessionRotationInput, at?: string): Promise<DeviceSessionRotationResult>;
  revokeDeviceSessionFamily(orgId: string, userId: string, familyId: string, reasonCode: string, at?: string): Promise<boolean>;

  createRemoteAccessGrant(orgId: string, userId: string, input: RemoteAccessGrantInput): Promise<RemoteAccessGrantRecord>;
  getRemoteAccessGrant(orgId: string, userId: string, grantId: string): Promise<RemoteAccessGrantRecord | null>;
  listRemoteAccessGrants(orgId: string, userId: string): Promise<RemoteAccessGrantRecord[]>;
  decideRemoteAccessGrant(orgId: string, userId: string, grantId: string, desktopDeviceId: string, decision: RemoteGrantDecision, at?: string): Promise<RemoteAccessGrantRecord | null>;
  revokeRemoteAccessGrant(orgId: string, userId: string, grantId: string, reasonCode: string, at?: string): Promise<boolean>;

  appendRemoteAccessAudit(orgId: string, userId: string, input: RemoteAccessAuditInput, at?: string): Promise<RemoteAccessAuditRecord>;
  listRemoteAccessAudit(orgId: string, userId: string, limit?: number): Promise<RemoteAccessAuditRecord[]>;

  createRemoteEnrollmentChallenge(orgId: string, userId: string, input: RemoteEnrollmentChallengeInput, at?: string): Promise<RemoteEnrollmentChallengeRecord>;
  getRemoteEnrollmentChallenge(orgId: string, userId: string, challengeId: string): Promise<RemoteEnrollmentChallengeRecord | null>;
  consumeRemoteEnrollmentChallenge(orgId: string, userId: string, challengeId: string, challengeHash: string, at?: string): Promise<boolean>;

  createRemoteRelayTicket(orgId: string, userId: string, input: RemoteRelayTicketInput, at?: string): Promise<RemoteRelayTicketRecord>;
  consumeRemoteRelayTicket(tokenHash: string, audience: "remote-relay", presentingDeviceId: string, at?: string): Promise<RemoteRelayTicketRecord | null>;
  revokeRemoteRelayTickets(orgId: string, userId: string, selector: RemoteRelayTicketRevocation, reasonCode: string, at?: string): Promise<number>;
}

export function isRemoteAccessScope(value: unknown): value is RemoteAccessScope {
  return typeof value === "string" && (REMOTE_ACCESS_SCOPES as readonly string[]).includes(value);
}

export function normalizeRemoteAccessScopes(scopes: readonly unknown[]): RemoteAccessScope[] {
  if (scopes.length === 0 || scopes.some((scope) => !isRemoteAccessScope(scope))) {
    throw new Error("Remote access scopes must be a non-empty subset of monitor, control, approve");
  }
  const requested = new Set(scopes as RemoteAccessScope[]);
  return REMOTE_ACCESS_SCOPES.filter((scope) => requested.has(scope));
}

/** Domain-separated hash for a high-entropy rotating refresh token. */
export function hashDeviceRefreshToken(token: string): string {
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("Device refresh tokens must contain at least 32 characters of entropy");
  }
  return createHash("sha256")
    .update("brainrouter:device-refresh:v1\0", "utf8")
    .update(token, "utf8")
    .digest("hex");
}

export function isDeviceRefreshTokenHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Stable public-key fingerprint used for device identity and duplicate-key rejection. */
export function fingerprintDevicePublicKey(publicKey: string): string {
  const normalized = publicKey.trim();
  if (normalized.length < 32 || normalized.length > 16_384) {
    throw new Error("A valid enrolled public key is required");
  }
  return createHash("sha256")
    .update("brainrouter:remote-device-key:v1\0", "utf8")
    .update(normalized, "utf8")
    .digest("hex");
}
