import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  hashDeviceRefreshToken,
  normalizeRemoteAccessScopes,
  type DeviceSessionRecord,
  type DeviceSessionRotationResult,
  type RemoteAccessGrantRecord,
  type RemoteAccessScope,
  type RemoteAccessStore,
  type RemoteDeviceInput,
  type RemoteDeviceRecord,
  type RemoteRelayTicketRecord,
  type RemoteRelayTicketRevocation,
} from "../../remote/store.js";

export const REMOTE_RELAY_AUDIENCE = "remote-relay" as const;
export const DEFAULT_RELAY_TICKET_TTL_SECONDS = 45;
export const DEFAULT_ENROLLMENT_CHALLENGE_TTL_SECONDS = 5 * 60;
export const DEFAULT_DEVICE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class RemoteControlPlaneError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 410,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteControlPlaneError";
  }
}

function domainHash(domain: string, value: string | Buffer): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value)
    .digest("hex");
}

export function hashEnrollmentChallenge(challenge: string): string {
  const bytes = decodeFixedBase64Url(challenge, 32, "Enrollment challenge");
  return domainHash("brainrouter:remote-enrollment-challenge:v1", bytes);
}

export function hashRelayTicket(ticket: string): string {
  if (!/^rrt_[A-Za-z0-9_-]{43}$/.test(ticket)) {
    throw new RemoteControlPlaneError(401, "invalid_relay_ticket", "Relay ticket is invalid");
  }
  return domainHash("brainrouter:remote-relay-ticket:v1", ticket);
}

function decodeFixedBase64Url(value: string, bytes: number, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RemoteControlPlaneError(400, "invalid_encoding", `${label} is not valid base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) {
    throw new RemoteControlPlaneError(400, "invalid_encoding", `${label} has an invalid length`);
  }
  return decoded;
}

function rawEd25519Key(value: string): Buffer {
  const trimmed = value.trim();
  if (!trimmed) throw new RemoteControlPlaneError(400, "invalid_public_key", "An Ed25519 public key is required");

  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    let key: KeyObject;
    try {
      key = createPublicKey(trimmed);
    } catch {
      throw new RemoteControlPlaneError(400, "invalid_public_key", "The enrolled public key is invalid");
    }
    if (key.asymmetricKeyType !== "ed25519") {
      throw new RemoteControlPlaneError(400, "invalid_public_key", "The enrolled public key must use Ed25519");
    }
    const der = key.export({ format: "der", type: "spki" }) as Buffer;
    if (der.length !== ED25519_SPKI_PREFIX.length + 32 || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
      throw new RemoteControlPlaneError(400, "invalid_public_key", "The enrolled Ed25519 key has an invalid encoding");
    }
    return der.subarray(ED25519_SPKI_PREFIX.length);
  }

  const compact = trimmed.startsWith("ed25519:") ? trimmed.slice("ed25519:".length) : trimmed;
  const normalized = compact.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(normalized)) {
    throw new RemoteControlPlaneError(400, "invalid_public_key", "The enrolled public key is invalid");
  }
  const raw = Buffer.from(normalized, "base64url");
  if (raw.length !== 32) throw new RemoteControlPlaneError(400, "invalid_public_key", "The enrolled public key must be 32 bytes");
  return raw;
}

export function canonicalizeEd25519PublicKey(value: string): string {
  return `ed25519:${rawEd25519Key(value).toString("base64url")}`;
}

function keyObject(publicKey: string): KeyObject {
  const raw = rawEd25519Key(publicKey);
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function verifyDeviceSignature(publicKey: string, message: Buffer, signature: string): boolean {
  let signatureBytes: Buffer;
  try {
    signatureBytes = decodeFixedBase64Url(signature, 64, "Device signature");
  } catch {
    return false;
  }
  try {
    return verify(null, message, keyObject(publicKey), signatureBytes);
  } catch {
    return false;
  }
}

function grantApprovalMessage(grant: RemoteAccessGrantRecord): Buffer {
  return Buffer.from([
    "brainrouter:remote-grant-approval:v1",
    grant.id,
    grant.orgId,
    grant.userId,
    grant.desktopDeviceId,
    grant.mobileDeviceId,
    grant.scopes.join(","),
    grant.expiresAt,
  ].join("\n"), "utf8");
}

/** Base64url metadata challenge that the enrolled desktop key signs verbatim. */
export function grantApprovalChallenge(grant: RemoteAccessGrantRecord): string {
  return grantApprovalMessage(grant).toString("base64url");
}

export function verifyGrantApprovalSignature(
  grant: RemoteAccessGrantRecord,
  desktop: RemoteDeviceRecord,
  signature: string,
): boolean {
  return desktop.id === grant.desktopDeviceId
    && desktop.kind === "desktop"
    && desktop.status === "active"
    && verifyDeviceSignature(desktop.publicKey, grantApprovalMessage(grant), signature);
}

export interface EnrollmentChallengeResponse {
  challengeId: string;
  challenge: string;
  expiresAt: string;
  keyAlgorithm: "ed25519";
}

export interface EnrollmentCompletionResponse {
  device: RemoteDeviceRecord;
  deviceSession: DeviceSessionRecord;
}

export interface RelayTicketResponse {
  relayTicket: string;
  relaySessionId: string;
  audience: typeof REMOTE_RELAY_AUDIENCE;
  scopes: RemoteAccessScope[];
  presentingDeviceId: string;
  peerDeviceId: string;
  expiresAt: string;
}

export interface RemoteControlPlaneOptions {
  now?: () => number;
  random?: (size: number) => Buffer;
  enrollmentChallengeTtlSeconds?: number;
  relayTicketTtlSeconds?: number;
  deviceSessionTtlSeconds?: number;
}

export class RemoteControlPlaneService {
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly enrollmentChallengeTtlSeconds: number;
  private readonly relayTicketTtlSeconds: number;
  private readonly deviceSessionTtlSeconds: number;

  constructor(
    private readonly store: RemoteAccessStore,
    options: RemoteControlPlaneOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
    this.enrollmentChallengeTtlSeconds = options.enrollmentChallengeTtlSeconds ?? DEFAULT_ENROLLMENT_CHALLENGE_TTL_SECONDS;
    this.relayTicketTtlSeconds = options.relayTicketTtlSeconds ?? DEFAULT_RELAY_TICKET_TTL_SECONDS;
    this.deviceSessionTtlSeconds = options.deviceSessionTtlSeconds ?? DEFAULT_DEVICE_SESSION_TTL_SECONDS;
    if (this.enrollmentChallengeTtlSeconds < 30 || this.enrollmentChallengeTtlSeconds > 10 * 60) {
      throw new Error("Enrollment challenge TTL must be between 30 and 600 seconds");
    }
    if (this.relayTicketTtlSeconds < 30 || this.relayTicketTtlSeconds > 60) {
      throw new Error("Relay ticket TTL must be between 30 and 60 seconds");
    }
    if (this.deviceSessionTtlSeconds < 60 || this.deviceSessionTtlSeconds > 90 * 24 * 60 * 60) {
      throw new Error("Device session TTL must be between 60 seconds and 90 days");
    }
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private expiresIso(seconds: number, fromIso: string): string {
    return new Date(Date.parse(fromIso) + seconds * 1000).toISOString();
  }

  async createEnrollmentChallenge(
    orgId: string,
    userId: string,
    input: RemoteDeviceInput,
  ): Promise<EnrollmentChallengeResponse> {
    const existing = await this.store.getRemoteDeviceByInstallation(orgId, userId, input.installationId.trim());
    if (existing) {
      throw new RemoteControlPlaneError(409, "device_already_enrolled", "This installation is already enrolled");
    }
    const challenge = this.random(32).toString("base64url");
    const at = this.nowIso();
    const expiresAt = this.expiresIso(this.enrollmentChallengeTtlSeconds, at);
    const record = await this.store.createRemoteEnrollmentChallenge(orgId, userId, {
      ...input,
      publicKey: canonicalizeEd25519PublicKey(input.publicKey),
      challengeHash: hashEnrollmentChallenge(challenge),
      expiresAt,
    }, at);
    return { challengeId: record.id, challenge, expiresAt: record.expiresAt, keyAlgorithm: "ed25519" };
  }

  async completeEnrollment(
    orgId: string,
    userId: string,
    input: { challengeId: string; challenge: string; signature: string; refreshToken: string },
  ): Promise<EnrollmentCompletionResponse> {
    const record = await this.store.getRemoteEnrollmentChallenge(orgId, userId, input.challengeId);
    if (!record) throw new RemoteControlPlaneError(404, "enrollment_challenge_not_found", "Enrollment challenge was not found");
    if (record.consumedAt) throw new RemoteControlPlaneError(409, "enrollment_challenge_replayed", "Enrollment challenge was already used");
    const at = this.nowIso();
    if (Date.parse(record.expiresAt) <= Date.parse(at)) {
      throw new RemoteControlPlaneError(410, "enrollment_challenge_expired", "Enrollment challenge expired");
    }
    const challengeBytes = decodeFixedBase64Url(input.challenge, 32, "Enrollment challenge");
    if (!verifyDeviceSignature(record.publicKey, challengeBytes, input.signature)) {
      throw new RemoteControlPlaneError(403, "invalid_device_signature", "Device signature verification failed");
    }
    const existing = await this.store.getRemoteDeviceByInstallation(orgId, userId, record.installationId);
    if (existing) throw new RemoteControlPlaneError(409, "device_already_enrolled", "This installation is already enrolled");
    const consumed = await this.store.consumeRemoteEnrollmentChallenge(
      orgId,
      userId,
      record.id,
      hashEnrollmentChallenge(input.challenge),
      at,
    );
    if (!consumed) throw new RemoteControlPlaneError(409, "enrollment_challenge_replayed", "Enrollment challenge is invalid or was already used");

    const tokenHash = hashDeviceRefreshToken(input.refreshToken);
    const device = await this.store.createRemoteDevice(orgId, userId, {
      installationId: record.installationId,
      kind: record.kind,
      displayName: record.displayName,
      publicKey: record.publicKey,
    });
    const deviceSession = await this.store.createDeviceSession(orgId, userId, {
      deviceId: device.id,
      tokenHash,
      expiresAt: this.expiresIso(this.deviceSessionTtlSeconds, at),
    });
    await this.store.appendRemoteAccessAudit(orgId, userId, {
      eventType: "device_enrolled",
      targetDeviceId: device.id,
    }, at);
    await this.store.appendRemoteAccessAudit(orgId, userId, {
      eventType: "session_created",
      targetDeviceId: device.id,
      sessionFamilyId: deviceSession.familyId,
    }, at);
    return { device, deviceSession };
  }

  async createDeviceSession(orgId: string, userId: string, deviceId: string, refreshToken: string): Promise<DeviceSessionRecord> {
    const device = await this.store.getRemoteDevice(orgId, userId, deviceId);
    if (!device || device.status !== "active") {
      throw new RemoteControlPlaneError(404, "device_not_found", "Active enrolled device was not found");
    }
    const at = this.nowIso();
    const session = await this.store.createDeviceSession(orgId, userId, {
      deviceId,
      tokenHash: hashDeviceRefreshToken(refreshToken),
      expiresAt: this.expiresIso(this.deviceSessionTtlSeconds, at),
    });
    await this.store.appendRemoteAccessAudit(orgId, userId, {
      eventType: "session_created",
      targetDeviceId: deviceId,
      sessionFamilyId: session.familyId,
    }, at);
    return session;
  }

  async rotateDeviceSession(
    orgId: string,
    userId: string,
    refreshToken: string,
    nextRefreshToken: string,
  ): Promise<DeviceSessionRotationResult> {
    if (refreshToken === nextRefreshToken) {
      throw new RemoteControlPlaneError(400, "refresh_token_not_rotated", "A new device refresh token is required");
    }
    const tokenHash = hashDeviceRefreshToken(refreshToken);
    const existing = await this.store.getDeviceSessionByTokenHash(orgId, userId, tokenHash);
    const at = this.nowIso();
    const result = await this.store.rotateDeviceSession(orgId, userId, {
      tokenHash,
      nextTokenHash: hashDeviceRefreshToken(nextRefreshToken),
      nextExpiresAt: this.expiresIso(this.deviceSessionTtlSeconds, at),
    }, at);
    if (result.status === "rotated") {
      await this.store.appendRemoteAccessAudit(orgId, userId, {
        eventType: "session_rotated",
        targetDeviceId: result.session.deviceId,
        sessionFamilyId: result.session.familyId,
      }, at);
    } else if (existing && result.status === "reuse-detected") {
      await this.store.revokeRemoteRelayTickets(orgId, userId, { sessionFamilyId: existing.familyId }, "refresh_token_reuse", at);
      await this.store.appendRemoteAccessAudit(orgId, userId, {
        eventType: "session_reuse_detected",
        targetDeviceId: existing.deviceId,
        sessionFamilyId: existing.familyId,
        reasonCode: "refresh_token_reuse",
      }, at);
    } else if (existing && (result.status === "expired" || result.status === "revoked")) {
      await this.store.revokeRemoteRelayTickets(orgId, userId, { sessionFamilyId: existing.familyId }, `device_session_${result.status}`, at);
    }
    return result;
  }

  async revokeDeviceSession(orgId: string, userId: string, familyId: string, reasonCode: string): Promise<boolean> {
    const at = this.nowIso();
    const revoked = await this.store.revokeDeviceSessionFamily(orgId, userId, familyId, reasonCode, at);
    if (!revoked) return false;
    await this.store.revokeRemoteRelayTickets(orgId, userId, { sessionFamilyId: familyId }, reasonCode, at);
    await this.store.appendRemoteAccessAudit(orgId, userId, {
      eventType: "session_revoked",
      sessionFamilyId: familyId,
      reasonCode,
    }, at);
    return true;
  }

  async issueRelayTicket(
    orgId: string,
    userId: string,
    input: {
      presentingDeviceId: string;
      peerDeviceId: string;
      grantId: string;
      deviceSessionId: string;
      scopes: readonly unknown[];
    },
  ): Promise<RelayTicketResponse> {
    const scopes = normalizeRemoteAccessScopes(input.scopes);
    const relayTicket = `rrt_${this.random(32).toString("base64url")}`;
    const at = this.nowIso();
    const record = await this.store.createRemoteRelayTicket(orgId, userId, {
      tokenHash: hashRelayTicket(relayTicket),
      presentingDeviceId: input.presentingDeviceId,
      peerDeviceId: input.peerDeviceId,
      grantId: input.grantId,
      deviceSessionId: input.deviceSessionId,
      audience: REMOTE_RELAY_AUDIENCE,
      scopes,
      expiresAt: this.expiresIso(this.relayTicketTtlSeconds, at),
    }, at);
    return {
      relayTicket,
      relaySessionId: record.id,
      audience: record.audience,
      scopes: record.scopes,
      presentingDeviceId: record.presentingDeviceId,
      peerDeviceId: record.peerDeviceId,
      expiresAt: record.expiresAt,
    };
  }

  consumeRelayTicket(ticket: string, presentingDeviceId: string): Promise<RemoteRelayTicketRecord | null> {
    return this.store.consumeRemoteRelayTicket(
      hashRelayTicket(ticket),
      REMOTE_RELAY_AUDIENCE,
      presentingDeviceId,
      this.nowIso(),
    );
  }

  revokeRelayTickets(
    orgId: string,
    userId: string,
    selector: RemoteRelayTicketRevocation,
    reasonCode: string,
  ): Promise<number> {
    return this.store.revokeRemoteRelayTickets(orgId, userId, selector, reasonCode, this.nowIso());
  }
}
