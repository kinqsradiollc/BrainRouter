import { generateKeyPairSync, sign } from "node:crypto";
import express from "express";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeviceSessionRecord,
  RemoteAccessAuditRecord,
  RemoteAccessGrantRecord,
  RemoteAccessStore,
  RemoteDeviceRecord,
} from "../../../remote/store.js";
import type { RemoteControlPlaneService } from "../../../services/remoteRelay/tickets.js";

const authMocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getDefaultOrgId: vi.fn(),
  getMemberRole: vi.fn(),
}));

vi.mock("../../../memory/engine.js", () => ({
  memoryEngine: {
    remote: {},
    getUserById: authMocks.getUserById,
    tenancy: {
      getDefaultOrgId: authMocks.getDefaultOrgId,
      getMemberRole: authMocks.getMemberRole,
    },
  },
}));

import { signJwt } from "../../auth/crypto.js";
import { JWT_SECRET } from "../../middleware/auth.js";
import { createRemoteRouter } from "./index.js";
import { grantApprovalChallenge } from "../../../services/remoteRelay/tickets.js";

type HttpResult = { status: number; body: any };

function requestJson(
  url: URL,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? "" : JSON.stringify(body);
    const req = httpRequest(url, {
      method,
      headers: encoded
        ? { ...headers, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(encoded)) }
        : headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

const nowMs = Date.parse("2026-07-14T00:00:00.000Z");
const now = new Date(nowMs).toISOString();
const later = new Date(nowMs + 86_400_000).toISOString();

function remoteDevice(kind: "desktop" | "mobile", overrides: Partial<RemoteDeviceRecord> = {}): RemoteDeviceRecord {
  const id = kind === "desktop" ? "rdev-desktop" : "rdev-mobile";
  return {
    id,
    orgId: "org-a",
    userId: "user-a",
    installationId: `${kind}-installation`,
    kind,
    displayName: kind === "desktop" ? "Desktop" : "Mobile",
    publicKey: `ed25519:${"A".repeat(43)}`,
    publicKeyFingerprint: (kind === "desktop" ? "a" : "b").repeat(64),
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

function deviceSession(overrides: Partial<DeviceSessionRecord> = {}): DeviceSessionRecord {
  return {
    id: "rds-mobile",
    familyId: "rfs-mobile",
    orgId: "org-a",
    userId: "user-a",
    deviceId: "rdev-mobile",
    generation: 0,
    parentSessionId: null,
    replacedBySessionId: null,
    expiresAt: later,
    rotatedAt: null,
    reuseDetectedAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function grant(overrides: Partial<RemoteAccessGrantRecord> = {}): RemoteAccessGrantRecord {
  return {
    id: "rgrant-a",
    orgId: "org-a",
    userId: "user-a",
    desktopDeviceId: "rdev-desktop",
    mobileDeviceId: "rdev-mobile",
    scopes: ["monitor"],
    approvalStatus: "approved",
    decidedAt: now,
    decidedByDeviceId: "rdev-desktop",
    expiresAt: later,
    revokedAt: null,
    revocationReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function accessHeaders(userId = "user-a", orgId = "org-a") {
  return {
    Authorization: `Bearer ${signJwt({ userId, type: "access" }, JWT_SECRET, 3600)}`,
    "X-BrainRouter-Org": orgId,
  };
}

describe("remote control-plane API", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";
  let store: Record<string, ReturnType<typeof vi.fn>>;
  let controlPlane: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    authMocks.getUserById.mockImplementation(async (userId: string) => ({
      userId,
      status: userId === "disabled-user" ? "disabled" : "active",
    }));
    authMocks.getDefaultOrgId.mockResolvedValue("org-a");
    authMocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) => {
      if (orgId !== "org-a") return null;
      return userId === "viewer-user" ? "viewer" : "developer";
    });

    store = {
      listRemoteDevices: vi.fn().mockResolvedValue([]),
      getRemoteDevice: vi.fn().mockResolvedValue(null),
      revokeRemoteDevice: vi.fn().mockResolvedValue(true),
      createRemoteAccessGrant: vi.fn(),
      getRemoteAccessGrant: vi.fn().mockResolvedValue(null),
      listRemoteAccessGrants: vi.fn().mockResolvedValue([]),
      decideRemoteAccessGrant: vi.fn(),
      revokeRemoteAccessGrant: vi.fn().mockResolvedValue(true),
      getDeviceSession: vi.fn().mockResolvedValue(null),
      appendRemoteAccessAudit: vi.fn().mockResolvedValue({}),
      listRemoteAccessAudit: vi.fn().mockResolvedValue([]),
    };
    controlPlane = {
      createEnrollmentChallenge: vi.fn(),
      completeEnrollment: vi.fn(),
      createDeviceSession: vi.fn(),
      rotateDeviceSession: vi.fn(),
      revokeDeviceSession: vi.fn().mockResolvedValue(true),
      issueRelayTicket: vi.fn(),
      revokeRelayTickets: vi.fn().mockResolvedValue(1),
    };

    const app = express();
    app.use(express.json());
    app.use("/api/remote", createRemoteRouter({
      store: store as unknown as RemoteAccessStore,
      controlPlane: controlPlane as unknown as RemoteControlPlaneService,
      now: () => nowMs,
    }));
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, (error?: Error) => error ? reject(error) : resolve());
    });
    const { port } = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    }
    server = undefined;
  });

  it("requires a current account access JWT, membership, and route capability", async () => {
    const unauthenticated = await requestJson(new URL(`${baseUrl}/api/remote/desktops`), "GET");
    const refreshJwt = signJwt({ userId: "user-a", type: "refresh" }, JWT_SECRET, 3600);
    const refreshRejected = await requestJson(new URL(`${baseUrl}/api/remote/desktops`), "GET", {
      Authorization: `Bearer ${refreshJwt}`,
      "X-BrainRouter-Org": "org-a",
    });
    const disabled = await requestJson(new URL(`${baseUrl}/api/remote/desktops`), "GET", accessHeaders("disabled-user"));
    const crossOrg = await requestJson(new URL(`${baseUrl}/api/remote/desktops`), "GET", accessHeaders("user-a", "org-b"));
    const viewerRead = await requestJson(new URL(`${baseUrl}/api/remote/desktops`), "GET", accessHeaders("viewer-user"));
    const viewerConnect = await requestJson(new URL(`${baseUrl}/api/remote/devices/enroll/challenge`), "POST", accessHeaders("viewer-user"), {
      installationId: "desktop-installation",
      kind: "desktop",
      displayName: "Desktop",
      publicKey: "x".repeat(40),
    });

    expect(unauthenticated.status).toBe(401);
    expect(refreshRejected.status).toBe(401);
    expect(disabled.status).toBe(403);
    expect(crossOrg.status).toBe(403);
    expect(viewerRead.status).toBe(200);
    expect(viewerConnect.status).toBe(403);
    expect(controlPlane.createEnrollmentChallenge).not.toHaveBeenCalled();
  });

  it("returns allowlisted desktop/device discovery without network or workspace metadata", async () => {
    const unsafeDesktop = {
      ...remoteDevice("desktop"),
      ipAddress: "10.0.0.8",
      workspaceRoot: "/Users/private/repo",
      localRelayEndpoint: "ws://127.0.0.1:9999",
    };
    store.listRemoteDevices.mockResolvedValue([unsafeDesktop]);

    const desktops = await requestJson(new URL(`${baseUrl}/api/remote/desktops`), "GET", accessHeaders());
    const devices = await requestJson(new URL(`${baseUrl}/api/remote/devices`), "GET", accessHeaders());

    expect(desktops.status).toBe(200);
    expect(desktops.body).toEqual({ desktops: [{
      id: "rdev-desktop",
      displayName: "Desktop",
      status: "active",
      lastSeenAt: now,
      presence: "online",
    }] });
    expect(JSON.stringify(desktops.body)).not.toMatch(/ipAddress|workspaceRoot|localRelayEndpoint|publicKey/i);
    expect(JSON.stringify(devices.body)).not.toContain(unsafeDesktop.publicKey);
    expect(store.listRemoteDevices).toHaveBeenCalledWith("org-a", "user-a", "desktop");
  });

  it("never returns the client-generated refresh credential from enrollment or rotation", async () => {
    const refreshToken = "client-generated-refresh-token-aaaaaaaaaaaa";
    const nextRefreshToken = "client-generated-refresh-token-bbbbbbbbbbbb";
    controlPlane.completeEnrollment.mockResolvedValue({
      device: remoteDevice("mobile"),
      deviceSession: deviceSession(),
    });
    controlPlane.rotateDeviceSession.mockResolvedValue({ status: "rotated", session: deviceSession({ generation: 1 }) });

    const completed = await requestJson(new URL(`${baseUrl}/api/remote/devices/enroll/complete`), "POST", accessHeaders(), {
      challengeId: "rench-a",
      challenge: Buffer.alloc(32, 1).toString("base64url"),
      signature: Buffer.alloc(64, 2).toString("base64url"),
      refreshToken,
    });
    const rotated = await requestJson(new URL(`${baseUrl}/api/remote/device-sessions/rotate`), "POST", accessHeaders(), {
      refreshToken,
      nextRefreshToken,
    });
    const revoked = await requestJson(new URL(`${baseUrl}/api/remote/device-sessions/rfs-mobile`), "DELETE", accessHeaders());

    expect(completed.status).toBe(201);
    expect(rotated.status).toBe(200);
    expect(revoked.status).toBe(200);
    expect(JSON.stringify([completed.body, rotated.body])).not.toContain(refreshToken);
    expect(JSON.stringify([completed.body, rotated.body])).not.toContain(nextRefreshToken);
    expect(controlPlane.completeEnrollment).toHaveBeenCalledWith("org-a", "user-a", expect.objectContaining({ refreshToken }));
    expect(controlPlane.revokeDeviceSession).toHaveBeenCalledWith("org-a", "user-a", "rfs-mobile", "user_revoked");
  });

  it("requires enrolled-desktop confirmation for control or approve scopes", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const desktop = remoteDevice("desktop", {
      publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
    const pending = grant({
      scopes: ["monitor", "control"],
      approvalStatus: "pending",
      decidedAt: null,
      decidedByDeviceId: null,
    });
    const approved = grant({ scopes: pending.scopes });
    store.getRemoteAccessGrant.mockResolvedValue(pending);
    store.getRemoteDevice.mockResolvedValue(desktop);
    store.decideRemoteAccessGrant.mockResolvedValue(approved);

    const unsigned = await requestJson(new URL(`${baseUrl}/api/remote/grants/${pending.id}`), "PATCH", accessHeaders(), {
      action: "approve",
      desktopDeviceId: desktop.id,
    });
    const signature = sign(
      null,
      Buffer.from(grantApprovalChallenge(pending), "base64url"),
      privateKey,
    ).toString("base64url");
    const signed = await requestJson(new URL(`${baseUrl}/api/remote/grants/${pending.id}`), "PATCH", accessHeaders(), {
      action: "approve",
      desktopDeviceId: desktop.id,
      signature,
    });

    expect(unsigned.status).toBe(403);
    expect(signed.status).toBe(200);
    expect(store.decideRemoteAccessGrant).toHaveBeenCalledTimes(1);
    expect(store.decideRemoteAccessGrant).toHaveBeenCalledWith(
      "org-a", "user-a", pending.id, desktop.id, "approved",
    );
  });

  it("fails closed on scope escalation, revoked devices, and inactive grants before issuing a ticket", async () => {
    const desktop = remoteDevice("desktop");
    const mobile = remoteDevice("mobile");
    const activeGrant = grant({ scopes: ["monitor"] });
    const currentSession = deviceSession();
    store.getRemoteDevice.mockImplementation(async (_org: string, _user: string, id: string) => id === desktop.id ? desktop : mobile);
    store.getRemoteAccessGrant.mockResolvedValue(activeGrant);
    store.getDeviceSession.mockResolvedValue(currentSession);
    controlPlane.issueRelayTicket.mockResolvedValue({
      relayTicket: `rrt_${"A".repeat(43)}`,
      relaySessionId: "rrs-a",
      audience: "remote-relay",
      scopes: ["monitor"],
      presentingDeviceId: mobile.id,
      peerDeviceId: desktop.id,
      expiresAt: new Date(nowMs + 45_000).toISOString(),
    });
    const body = {
      mobileDeviceId: mobile.id,
      grantId: activeGrant.id,
      deviceSessionId: currentSession.id,
      scopes: ["control"],
    };

    const escalated = await requestJson(new URL(`${baseUrl}/api/remote/desktops/${desktop.id}/sessions`), "POST", accessHeaders(), body);
    const valid = await requestJson(new URL(`${baseUrl}/api/remote/desktops/${desktop.id}/sessions`), "POST", accessHeaders(), {
      ...body,
      scopes: ["monitor"],
    });
    store.getRemoteDevice.mockImplementation(async (_org: string, _user: string, id: string) => (
      id === desktop.id ? desktop : { ...mobile, status: "revoked", revokedAt: now }
    ));
    const revoked = await requestJson(new URL(`${baseUrl}/api/remote/desktops/${desktop.id}/sessions`), "POST", accessHeaders(), {
      ...body,
      scopes: ["monitor"],
    });

    expect(escalated.status).toBe(403);
    expect(valid.status).toBe(201);
    expect(revoked.status).toBe(403);
    expect(controlPlane.issueRelayTicket).toHaveBeenCalledTimes(1);
    expect(controlPlane.issueRelayTicket).toHaveBeenCalledWith("org-a", "user-a", expect.objectContaining({ scopes: ["monitor"] }));
    expect(JSON.stringify(valid.body)).not.toMatch(/refresh|accessJwt|workspace|endpoint|ipAddress/i);
  });

  it("issues the desktop's attach ticket for the same grant with presenting/peer swapped", async () => {
    const desktop = remoteDevice("desktop");
    const activeGrant = grant({ scopes: ["monitor", "control"] });
    const desktopSession = deviceSession({ id: "rds-desktop", familyId: "rfs-desktop", deviceId: desktop.id });
    store.getRemoteAccessGrant.mockResolvedValue(activeGrant);
    store.getRemoteDevice.mockResolvedValue(desktop);
    store.getDeviceSession.mockResolvedValue(desktopSession);
    controlPlane.issueRelayTicket.mockResolvedValue({
      relayTicket: `rrt_${"B".repeat(43)}`,
      relaySessionId: "rrs-b",
      audience: "remote-relay",
      scopes: ["monitor"],
      presentingDeviceId: desktop.id,
      peerDeviceId: activeGrant.mobileDeviceId,
      expiresAt: new Date(nowMs + 45_000).toISOString(),
    });

    // Scope escalation beyond the grant fails closed.
    const escalated = await requestJson(new URL(`${baseUrl}/api/remote/grants/${activeGrant.id}/desktop-tickets`), "POST", accessHeaders(), {
      deviceSessionId: desktopSession.id,
      scopes: ["approve"],
    });
    // A session belonging to a different device (e.g. the mobile) fails closed.
    store.getDeviceSession.mockResolvedValueOnce(deviceSession());
    const wrongDevice = await requestJson(new URL(`${baseUrl}/api/remote/grants/${activeGrant.id}/desktop-tickets`), "POST", accessHeaders(), {
      deviceSessionId: "rds-mobile",
      scopes: ["monitor"],
    });
    const valid = await requestJson(new URL(`${baseUrl}/api/remote/grants/${activeGrant.id}/desktop-tickets`), "POST", accessHeaders(), {
      deviceSessionId: desktopSession.id,
      scopes: ["monitor"],
    });

    expect(escalated.status).toBe(403);
    expect(wrongDevice.status).toBe(403);
    expect(valid.status).toBe(201);
    expect(controlPlane.issueRelayTicket).toHaveBeenCalledTimes(1);
    expect(controlPlane.issueRelayTicket).toHaveBeenCalledWith("org-a", "user-a", expect.objectContaining({
      presentingDeviceId: desktop.id,
      peerDeviceId: activeGrant.mobileDeviceId,
      grantId: activeGrant.id,
    }));
    expect(JSON.stringify(valid.body)).not.toMatch(/refresh|accessJwt|workspace|endpoint|ipAddress/i);
  });

  it("returns fixed audit metadata only", async () => {
    const record = {
      id: "raud-a",
      orgId: "org-a",
      userId: "user-a",
      eventType: "connection_closed",
      actorDeviceId: "rdev-mobile",
      targetDeviceId: "rdev-desktop",
      grantId: "rgrant-a",
      sessionFamilyId: "rfs-a",
      scopes: ["monitor"],
      reasonCode: "client_closed",
      requestId: "request-a",
      createdAt: now,
      terminalContent: "secret terminal data",
      refreshToken: "reusable-secret",
    } as unknown as RemoteAccessAuditRecord;
    store.listRemoteAccessAudit.mockResolvedValue([record]);

    const response = await requestJson(new URL(`${baseUrl}/api/remote/audit?limit=9000`), "GET", accessHeaders());

    expect(response.status).toBe(200);
    expect(store.listRemoteAccessAudit).toHaveBeenCalledWith("org-a", "user-a", 500);
    expect(JSON.stringify(response.body)).not.toContain("secret terminal data");
    expect(JSON.stringify(response.body)).not.toContain("reusable-secret");
  });
});
