import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../../memory/store/postgres/queries/executor.js";
import {
  consumeRemoteRelayTicket,
  createRemoteRelayTicket,
  revokeRemoteRelayTickets,
} from "../../memory/store/postgres/queries/remoteControlQueries.js";
import type {
  DeviceSessionRecord,
  RemoteAccessStore,
  RemoteDeviceRecord,
  RemoteEnrollmentChallengeRecord,
  RemoteRelayTicketInput,
  RemoteRelayTicketRecord,
} from "../../remote/store.js";
import {
  REMOTE_RELAY_AUDIENCE,
  RemoteControlPlaneService,
  hashEnrollmentChallenge,
  hashRelayTicket,
} from "./tickets.js";

const nowMs = Date.parse("2026-07-14T00:00:00.000Z");
const now = new Date(nowMs).toISOString();

function device(overrides: Partial<RemoteDeviceRecord> = {}): RemoteDeviceRecord {
  return {
    id: "rdev-mobile",
    orgId: "org-a",
    userId: "user-a",
    installationId: "mobile-installation",
    kind: "mobile",
    displayName: "Mobile",
    publicKey: "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    publicKeyFingerprint: "a".repeat(64),
    keyAlgorithm: "ed25519",
    status: "active",
    enrolledAt: now,
    lastSeenAt: now,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function session(overrides: Partial<DeviceSessionRecord> = {}): DeviceSessionRecord {
  return {
    id: "rds-a",
    familyId: "rfs-a",
    orgId: "org-a",
    userId: "user-a",
    deviceId: "rdev-mobile",
    generation: 0,
    parentSessionId: null,
    replacedBySessionId: null,
    expiresAt: new Date(nowMs + 86_400_000).toISOString(),
    rotatedAt: null,
    reuseDetectedAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function relayRecord(input: RemoteRelayTicketInput, overrides: Partial<RemoteRelayTicketRecord> = {}): RemoteRelayTicketRecord {
  return {
    id: "rrs-a",
    orgId: "org-a",
    userId: "user-a",
    presentingDeviceId: input.presentingDeviceId,
    peerDeviceId: input.peerDeviceId,
    grantId: input.grantId,
    sessionFamilyId: "rfs-a",
    audience: "remote-relay",
    scopes: input.scopes,
    expiresAt: input.expiresAt,
    consumedAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: now,
    ...overrides,
  };
}

describe("remote enrollment security", () => {
  it("verifies Ed25519 possession, stores challenge/token hashes only, and rejects replay", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    let challengeRecord: RemoteEnrollmentChallengeRecord | null = null;
    let consumed = false;
    const createSession = vi.fn(async (_orgId: string, _userId: string, input: { tokenHash: string }) => session());
    const appendAudit = vi.fn().mockResolvedValue({});
    const store = {
      getRemoteDeviceByInstallation: vi.fn().mockResolvedValue(null),
      createRemoteEnrollmentChallenge: vi.fn(async (orgId: string, userId: string, input: any, at: string) => {
        challengeRecord = {
          id: "rench-a",
          orgId,
          userId,
          installationId: input.installationId,
          kind: input.kind,
          displayName: input.displayName,
          publicKey: input.publicKey,
          publicKeyFingerprint: "f".repeat(64),
          expiresAt: input.expiresAt,
          consumedAt: null,
          createdAt: at,
        };
        return challengeRecord;
      }),
      getRemoteEnrollmentChallenge: vi.fn(async () => challengeRecord && ({ ...challengeRecord, consumedAt: consumed ? now : null })),
      consumeRemoteEnrollmentChallenge: vi.fn(async (_orgId: string, _userId: string, _id: string, hash: string) => {
        if (consumed || hash !== hashEnrollmentChallenge(challenge.challenge)) return false;
        consumed = true;
        return true;
      }),
      createRemoteDevice: vi.fn(async () => device({ publicKey: challengeRecord!.publicKey })),
      createDeviceSession: createSession,
      appendRemoteAccessAudit: appendAudit,
    } as unknown as RemoteAccessStore;
    const service = new RemoteControlPlaneService(store, {
      now: () => nowMs,
      random: () => Buffer.alloc(32, 7),
    });

    const challenge = await service.createEnrollmentChallenge("org-a", "user-a", {
      installationId: "mobile-installation",
      kind: "mobile",
      displayName: "Mobile",
      publicKey: publicKeyPem,
    });
    const signature = sign(null, Buffer.from(challenge.challenge, "base64url"), privateKey).toString("base64url");
    const refreshToken = "client-generated-device-refresh-token-aaaaaaaa";
    const completed = await service.completeEnrollment("org-a", "user-a", {
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      signature,
      refreshToken,
    });

    const persistedChallenge = (store.createRemoteEnrollmentChallenge as any).mock.calls[0][2];
    expect(persistedChallenge.challengeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(persistedChallenge)).not.toContain(challenge.challenge);
    expect(createSession.mock.calls[0][2].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(createSession.mock.calls[0][2])).not.toContain(refreshToken);
    expect(JSON.stringify(completed)).not.toContain(refreshToken);
    expect(appendAudit).toHaveBeenCalledTimes(2);

    await expect(service.completeEnrollment("org-a", "user-a", {
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      signature,
      refreshToken,
    })).rejects.toMatchObject({ code: "enrollment_challenge_replayed" });
  });

  it("does not consume an enrollment challenge with an invalid device signature", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const record: RemoteEnrollmentChallengeRecord = {
      id: "rench-a",
      orgId: "org-a",
      userId: "user-a",
      installationId: "desktop-installation",
      kind: "desktop",
      displayName: "Desktop",
      publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
      publicKeyFingerprint: "a".repeat(64),
      expiresAt: new Date(nowMs + 60_000).toISOString(),
      consumedAt: null,
      createdAt: now,
    };
    const consume = vi.fn();
    const store = {
      getRemoteEnrollmentChallenge: vi.fn().mockResolvedValue(record),
      getRemoteDeviceByInstallation: vi.fn().mockResolvedValue(null),
      consumeRemoteEnrollmentChallenge: consume,
    } as unknown as RemoteAccessStore;
    const service = new RemoteControlPlaneService(store, { now: () => nowMs });

    await expect(service.completeEnrollment("org-a", "user-a", {
      challengeId: record.id,
      challenge: Buffer.alloc(32, 1).toString("base64url"),
      signature: Buffer.alloc(64, 2).toString("base64url"),
      refreshToken: "refresh-token-with-at-least-thirty-two-chars",
    })).rejects.toMatchObject({ code: "invalid_device_signature" });
    expect(consume).not.toHaveBeenCalled();
  });
});

describe("single-use relay tickets", () => {
  it("persists only a hash and fails closed on wrong device binding and replay", async () => {
    let issued: RemoteRelayTicketRecord | null = null;
    let issuedHash = "";
    let consumed = false;
    const create = vi.fn(async (_orgId: string, _userId: string, input: RemoteRelayTicketInput) => {
      issuedHash = input.tokenHash;
      issued = relayRecord(input);
      return issued;
    });
    const consume = vi.fn(async (hash: string, audience: string, presentingDeviceId: string, at: string) => {
      if (!issued || consumed || hash !== issuedHash || audience !== REMOTE_RELAY_AUDIENCE || presentingDeviceId !== issued.presentingDeviceId) return null;
      consumed = true;
      return { ...issued, consumedAt: at };
    });
    const revoke = vi.fn().mockResolvedValue(1);
    const store = {
      createRemoteRelayTicket: create,
      consumeRemoteRelayTicket: consume,
      revokeRemoteRelayTickets: revoke,
    } as unknown as RemoteAccessStore;
    const service = new RemoteControlPlaneService(store, {
      now: () => nowMs,
      random: () => Buffer.alloc(32, 9),
    });

    const response = await service.issueRelayTicket("org-a", "user-a", {
      presentingDeviceId: "rdev-mobile",
      peerDeviceId: "rdev-desktop",
      grantId: "rgrant-a",
      deviceSessionId: "rds-a",
      scopes: ["monitor", "control"],
    });

    expect(response.relayTicket).toMatch(/^rrt_[A-Za-z0-9_-]{43}$/);
    expect(create.mock.calls[0][2].tokenHash).toBe(hashRelayTicket(response.relayTicket));
    expect(JSON.stringify(create.mock.calls[0][2])).not.toContain(response.relayTicket);
    expect(Date.parse(response.expiresAt) - nowMs).toBe(45_000);
    await expect(service.consumeRelayTicket(response.relayTicket, "rdev-attacker")).resolves.toBeNull();
    await expect(service.consumeRelayTicket(response.relayTicket, "rdev-mobile")).resolves.toMatchObject({ id: "rrs-a" });
    await expect(service.consumeRelayTicket(response.relayTicket, "rdev-mobile")).resolves.toBeNull();

    await service.revokeRelayTickets("org-a", "user-a", { grantId: "rgrant-a" }, "grant_revoked");
    expect(revoke).toHaveBeenCalledWith(
      "org-a", "user-a", { grantId: "rgrant-a" }, "grant_revoked", now,
    );
  });
});

describe("remote control persistence SQL", () => {
  it("atomically consumes only a live, correctly bound ticket", async () => {
    const one = vi.fn().mockResolvedValue(null);
    const exec = { one } as unknown as Executor;

    await consumeRemoteRelayTicket(exec, "a".repeat(64), "remote-relay", "rdev-mobile", now);

    expect(one.mock.calls[0][0]).toContain("SET consumed_at = $4");
    expect(one.mock.calls[0][0]).toContain("t.consumed_at IS NULL AND t.revoked_at IS NULL");
    expect(one.mock.calls[0][0]).toContain("t.presenting_device_id = $3");
    expect(one.mock.calls[0][0]).toContain("t.scopes_json::jsonb <@ g.scopes_json::jsonb");
    expect(one.mock.calls[0][0]).toContain("s.reuse_detected_at IS NULL");
    expect(one.mock.calls[0][1]).toEqual(["a".repeat(64), "remote-relay", "rdev-mobile", now]);
  });

  it("validates tenant/device/grant/session scope again when creating a ticket", async () => {
    const one = vi.fn().mockResolvedValue(null);
    const exec = { one } as unknown as Executor;
    const input: RemoteRelayTicketInput = {
      tokenHash: "a".repeat(64),
      presentingDeviceId: "rdev-mobile",
      peerDeviceId: "rdev-desktop",
      grantId: "rgrant-a",
      deviceSessionId: "rds-a",
      audience: "remote-relay",
      scopes: ["monitor"],
      expiresAt: new Date(nowMs + 45_000).toISOString(),
    };

    await expect(createRemoteRelayTicket(exec, "org-a", "user-a", input, now))
      .rejects.toThrow("active scoped devices");

    const sql = one.mock.calls[0][0] as string;
    expect(sql).toContain("presenting.org_id = $3 AND presenting.user_id = $4");
    expect(sql).toContain("g.approval_status = 'approved'");
    expect(sql).toContain("$10::jsonb <@ g.scopes_json::jsonb");
    expect(sql).toContain("s.id = $8");
  });

  it("publishes metadata-only scoped revocation events for relay instances", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "rrs-a" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const tx = vi.fn(async (fn: (client: any) => Promise<unknown>) => fn({ query }));
    const exec = { tx } as unknown as Executor;

    await expect(revokeRemoteRelayTickets(
      exec,
      "org-a",
      "user-a",
      { deviceId: "rdev-a" },
      "device_revoked",
      now,
    )).resolves.toBe(1);

    expect(query.mock.calls[0][0]).toContain("org_id = $1 AND user_id = $2");
    expect(query.mock.calls[0][0]).toContain("presenting_device_id = $3 OR peer_device_id = $3");
    expect(query.mock.calls[1][0]).toBe("SELECT pg_notify($1, $2)");
    const payload = JSON.parse(query.mock.calls[1][1][1]);
    expect(payload).toMatchObject({ orgId: "org-a", userId: "user-a", deviceId: "rdev-a", reasonCode: "device_revoked" });
    expect(JSON.stringify(payload)).not.toMatch(/terminal|payload|content|token|credential|password/i);
  });
});
