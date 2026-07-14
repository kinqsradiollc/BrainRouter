import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { verifyJwt } from "../../auth/crypto.js";
import { sendError } from "../../../contracts/http.js";
import { memoryEngine } from "../../../memory/engine.js";
import {
  normalizeRemoteAccessScopes,
  type DeviceSessionRecord,
  type RemoteAccessAuditRecord,
  type RemoteAccessGrantRecord,
  type RemoteAccessStore,
  type RemoteDeviceRecord,
} from "../../../remote/store.js";
import {
  RemoteControlPlaneError,
  RemoteControlPlaneService,
  grantApprovalChallenge,
  verifyGrantApprovalSignature,
} from "../../../services/remoteRelay/tickets.js";
import { JWT_SECRET, bearerFrom, requireJwt, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";

const idSchema = z.string().trim().min(1).max(256);
const refreshTokenSchema = z.string().min(32).max(2048);
const scopeSchema = z.enum(["monitor", "control", "approve"]);
const scopesSchema = z.array(scopeSchema).min(1).max(3);

const enrollmentChallengeSchema = z.object({
  installationId: z.string().trim().min(8).max(256),
  kind: z.enum(["desktop", "mobile"]),
  displayName: z.string().trim().max(128).default(""),
  publicKey: z.string().trim().min(32).max(16_384),
}).strict();

const enrollmentCompleteSchema = z.object({
  challengeId: idSchema,
  challenge: z.string().trim().min(40).max(128),
  signature: z.string().trim().min(80).max(256),
  refreshToken: refreshTokenSchema,
}).strict();

const createDeviceSessionSchema = z.object({
  deviceId: idSchema,
  refreshToken: refreshTokenSchema,
}).strict();

const rotateDeviceSessionSchema = z.object({
  refreshToken: refreshTokenSchema,
  nextRefreshToken: refreshTokenSchema,
}).strict();

const createGrantSchema = z.object({
  mobileDeviceId: idSchema,
  scopes: scopesSchema,
  expiresInSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).default(24 * 60 * 60),
}).strict();

const patchGrantSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    desktopDeviceId: idSchema,
    signature: z.string().trim().min(80).max(256).optional(),
  }).strict(),
  z.object({
    action: z.literal("deny"),
    desktopDeviceId: idSchema,
  }).strict(),
  z.object({
    action: z.literal("revoke"),
    reasonCode: z.string().trim().min(1).max(120).default("user_revoked"),
  }).strict(),
]);

const createRelaySessionSchema = z.object({
  mobileDeviceId: idSchema,
  grantId: idSchema,
  deviceSessionId: idSchema,
  scopes: scopesSchema,
}).strict();

/** Desktop side of the same relay session — device ids derive from the grant. */
const createDesktopTicketSchema = z.object({
  deviceSessionId: idSchema,
  scopes: scopesSchema,
}).strict();

export interface RemoteRouterDependencies {
  store: RemoteAccessStore;
  controlPlane: RemoteControlPlaneService;
  now?: () => number;
}

/** Remote control accepts account access JWTs only, never API keys or refresh JWTs. */
function requireRemoteAccessToken(req: AuthedRequest, res: Response, next: NextFunction): void {
  const payload = verifyJwt(bearerFrom(req), JWT_SECRET);
  if (!payload || payload.type !== "access") {
    sendError(res, 401, "A BrainRouter account access token is required");
    return;
  }
  next();
}

function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue?.message ?? "Invalid request"}`;
}

function routeError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    sendError(res, 400, validationMessage(error));
    return;
  }
  if (error instanceof RemoteControlPlaneError) {
    sendError(res, error.status, error.message, { reason: error.code });
    return;
  }
  if ((error as { code?: unknown })?.code === "23505") {
    sendError(res, 409, "Remote access state already exists");
    return;
  }
  sendError(res, 500, "Remote control-plane request failed");
}

function publicDevice(device: RemoteDeviceRecord) {
  return {
    id: device.id,
    installationId: device.installationId,
    kind: device.kind,
    displayName: device.displayName,
    publicKeyFingerprint: device.publicKeyFingerprint,
    keyAlgorithm: device.keyAlgorithm,
    status: device.status,
    enrolledAt: device.enrolledAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  };
}

function publicDesktop(device: RemoteDeviceRecord, now: number) {
  const seenAt = device.lastSeenAt ? Date.parse(device.lastSeenAt) : Number.NaN;
  const online = device.status === "active" && Number.isFinite(seenAt) && now - seenAt <= 90_000;
  return {
    id: device.id,
    displayName: device.displayName,
    status: device.status,
    lastSeenAt: device.lastSeenAt,
    presence: online ? "online" : "offline",
  };
}

function publicSession(session: DeviceSessionRecord) {
  return {
    id: session.id,
    familyId: session.familyId,
    deviceId: session.deviceId,
    generation: session.generation,
    parentSessionId: session.parentSessionId,
    replacedBySessionId: session.replacedBySessionId,
    expiresAt: session.expiresAt,
    rotatedAt: session.rotatedAt,
    reuseDetectedAt: session.reuseDetectedAt,
    revokedAt: session.revokedAt,
    revocationReason: session.revocationReason,
  };
}

function publicGrant(grant: RemoteAccessGrantRecord) {
  return {
    id: grant.id,
    desktopDeviceId: grant.desktopDeviceId,
    mobileDeviceId: grant.mobileDeviceId,
    scopes: grant.scopes,
    approvalStatus: grant.approvalStatus,
    approvalChallenge: grant.approvalStatus === "pending" ? grantApprovalChallenge(grant) : null,
    decidedAt: grant.decidedAt,
    decidedByDeviceId: grant.decidedByDeviceId,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    revocationReason: grant.revocationReason,
  };
}

function publicAudit(record: RemoteAccessAuditRecord) {
  return {
    id: record.id,
    eventType: record.eventType,
    actorDeviceId: record.actorDeviceId,
    targetDeviceId: record.targetDeviceId,
    grantId: record.grantId,
    sessionFamilyId: record.sessionFamilyId,
    scopes: record.scopes,
    reasonCode: record.reasonCode,
    requestId: record.requestId,
    createdAt: record.createdAt,
  };
}

function isCurrentSession(session: DeviceSessionRecord, mobileDeviceId: string, now: number): boolean {
  return session.deviceId === mobileDeviceId
    && !session.rotatedAt
    && !session.replacedBySessionId
    && !session.reuseDetectedAt
    && !session.revokedAt
    && Date.parse(session.expiresAt) > now;
}

export function createRemoteRouter(deps: RemoteRouterDependencies) {
  const router = Router();
  const now = deps.now ?? Date.now;
  router.use(requireJwt, requireRemoteAccessToken);

  router.post("/devices/enroll/challenge", requirePermission("remote:connect"), async (req: AuthedRequest, res) => {
    try {
      const input = enrollmentChallengeSchema.parse(req.body);
      const challenge = await deps.controlPlane.createEnrollmentChallenge(req.orgId!, req.userId!, input);
      res.status(201).json(challenge);
    } catch (error) { routeError(res, error); }
  });

  router.post("/devices/enroll/complete", requirePermission("remote:connect"), async (req: AuthedRequest, res) => {
    try {
      const input = enrollmentCompleteSchema.parse(req.body);
      const result = await deps.controlPlane.completeEnrollment(req.orgId!, req.userId!, input);
      res.status(201).json({
        device: publicDevice(result.device),
        deviceSession: publicSession(result.deviceSession),
      });
    } catch (error) { routeError(res, error); }
  });

  router.get("/devices", requirePermission("remote:read"), async (req: AuthedRequest, res) => {
    try {
      const devices = await deps.store.listRemoteDevices(req.orgId!, req.userId!);
      res.json({ devices: devices.map(publicDevice) });
    } catch (error) { routeError(res, error); }
  });

  router.delete("/devices/:id", requirePermission("remote:manage"), async (req: AuthedRequest, res) => {
    try {
      const deviceId = idSchema.parse(req.params.id);
      const device = await deps.store.getRemoteDevice(req.orgId!, req.userId!, deviceId);
      if (!device) { sendError(res, 404, "Remote device not found"); return; }
      const at = new Date(now()).toISOString();
      const revoked = await deps.store.revokeRemoteDevice(req.orgId!, req.userId!, deviceId, "user_revoked", at);
      if (!revoked) { sendError(res, 409, "Remote device is already revoked"); return; }
      await deps.controlPlane.revokeRelayTickets(req.orgId!, req.userId!, { deviceId }, "device_revoked");
      await deps.store.appendRemoteAccessAudit(req.orgId!, req.userId!, {
        eventType: "device_revoked",
        targetDeviceId: deviceId,
        reasonCode: "user_revoked",
      }, at);
      res.json({ revoked: true });
    } catch (error) { routeError(res, error); }
  });

  router.post("/device-sessions", requirePermission("remote:connect"), async (req: AuthedRequest, res) => {
    try {
      const input = createDeviceSessionSchema.parse(req.body);
      const session = await deps.controlPlane.createDeviceSession(req.orgId!, req.userId!, input.deviceId, input.refreshToken);
      res.status(201).json({ deviceSession: publicSession(session) });
    } catch (error) { routeError(res, error); }
  });

  router.post("/device-sessions/rotate", requirePermission("remote:connect"), async (req: AuthedRequest, res) => {
    try {
      const input = rotateDeviceSessionSchema.parse(req.body);
      const result = await deps.controlPlane.rotateDeviceSession(req.orgId!, req.userId!, input.refreshToken, input.nextRefreshToken);
      if (result.status === "rotated") {
        res.json({ deviceSession: publicSession(result.session) });
        return;
      }
      const status = result.status === "revoked" ? 403 : 401;
      sendError(res, status, `Device session ${result.status}`, { reason: result.status });
    } catch (error) { routeError(res, error); }
  });

  router.delete("/device-sessions/:familyId", requirePermission("remote:manage"), async (req: AuthedRequest, res) => {
    try {
      const familyId = idSchema.parse(req.params.familyId);
      const revoked = await deps.controlPlane.revokeDeviceSession(req.orgId!, req.userId!, familyId, "user_revoked");
      if (!revoked) { sendError(res, 404, "Device session family not found"); return; }
      res.json({ revoked: true });
    } catch (error) { routeError(res, error); }
  });

  router.get("/desktops", requirePermission("remote:read"), async (req: AuthedRequest, res) => {
    try {
      const desktops = await deps.store.listRemoteDevices(req.orgId!, req.userId!, "desktop");
      res.json({ desktops: desktops.map((device) => publicDesktop(device, now())) });
    } catch (error) { routeError(res, error); }
  });

  router.get("/grants", requirePermission("remote:read"), async (req: AuthedRequest, res) => {
    try {
      const grants = await deps.store.listRemoteAccessGrants(req.orgId!, req.userId!);
      res.json({ grants: grants.map(publicGrant) });
    } catch (error) { routeError(res, error); }
  });

  router.post("/desktops/:id/grants", requirePermission("remote:connect"), async (req: AuthedRequest, res) => {
    try {
      const desktopDeviceId = idSchema.parse(req.params.id);
      const input = createGrantSchema.parse(req.body);
      const createdAt = now();
      const grant = await deps.store.createRemoteAccessGrant(req.orgId!, req.userId!, {
        desktopDeviceId,
        mobileDeviceId: input.mobileDeviceId,
        scopes: normalizeRemoteAccessScopes(input.scopes),
        expiresAt: new Date(createdAt + input.expiresInSeconds * 1000).toISOString(),
      });
      await deps.store.appendRemoteAccessAudit(req.orgId!, req.userId!, {
        eventType: "grant_requested",
        actorDeviceId: input.mobileDeviceId,
        targetDeviceId: desktopDeviceId,
        grantId: grant.id,
        scopes: grant.scopes,
      }, new Date(createdAt).toISOString());
      res.status(201).json({ grant: publicGrant(grant) });
    } catch (error) { routeError(res, error); }
  });

  router.patch("/grants/:id", requirePermission("remote:manage"), async (req: AuthedRequest, res) => {
    try {
      const grantId = idSchema.parse(req.params.id);
      const input = patchGrantSchema.parse(req.body);
      const grant = await deps.store.getRemoteAccessGrant(req.orgId!, req.userId!, grantId);
      if (!grant) { sendError(res, 404, "Remote access grant not found"); return; }
      if (input.action === "revoke") {
        const revoked = await deps.store.revokeRemoteAccessGrant(req.orgId!, req.userId!, grant.id, input.reasonCode);
        if (!revoked) { sendError(res, 409, "Remote access grant is already revoked"); return; }
        await deps.controlPlane.revokeRelayTickets(req.orgId!, req.userId!, { grantId: grant.id }, "grant_revoked");
        await deps.store.appendRemoteAccessAudit(req.orgId!, req.userId!, {
          eventType: "grant_revoked",
          grantId: grant.id,
          scopes: grant.scopes,
          reasonCode: input.reasonCode,
        });
        res.json({ revoked: true });
        return;
      }
      const desktop = await deps.store.getRemoteDevice(req.orgId!, req.userId!, input.desktopDeviceId);
      if (!desktop || desktop.id !== grant.desktopDeviceId || desktop.status !== "active") {
        sendError(res, 404, "Active grant desktop not found");
        return;
      }
      if (input.action === "approve" && grant.scopes.some((scope) => scope !== "monitor")) {
        if (!input.signature || !verifyGrantApprovalSignature(grant, desktop, input.signature)) {
          sendError(res, 403, "Elevated remote scopes require confirmation from the enrolled desktop key");
          return;
        }
      }
      const decision = input.action === "approve" ? "approved" : "denied";
      const decided = await deps.store.decideRemoteAccessGrant(
        req.orgId!, req.userId!, grant.id, desktop.id, decision,
      );
      if (!decided) { sendError(res, 409, "Grant is expired, revoked, or already decided"); return; }
      await deps.store.appendRemoteAccessAudit(req.orgId!, req.userId!, {
        eventType: decision === "approved" ? "grant_approved" : "grant_denied",
        actorDeviceId: desktop.id,
        targetDeviceId: grant.mobileDeviceId,
        grantId: grant.id,
        scopes: grant.scopes,
      });
      res.json({ grant: publicGrant(decided) });
    } catch (error) { routeError(res, error); }
  });

  router.post("/desktops/:id/sessions", requirePermission("remote:connect"), async (req: AuthedRequest, res) => {
    try {
      const desktopDeviceId = idSchema.parse(req.params.id);
      const input = createRelaySessionSchema.parse(req.body);
      const requestedScopes = normalizeRemoteAccessScopes(input.scopes);
      const [desktop, mobile, grant, deviceSession] = await Promise.all([
        deps.store.getRemoteDevice(req.orgId!, req.userId!, desktopDeviceId),
        deps.store.getRemoteDevice(req.orgId!, req.userId!, input.mobileDeviceId),
        deps.store.getRemoteAccessGrant(req.orgId!, req.userId!, input.grantId),
        deps.store.getDeviceSession(req.orgId!, req.userId!, input.deviceSessionId),
      ]);
      const current = now();
      if (!desktop || !mobile || !grant || !deviceSession) {
        sendError(res, 404, "Remote session prerequisites were not found");
        return;
      }
      if (desktop.kind !== "desktop" || mobile.kind !== "mobile" || desktop.status !== "active" || mobile.status !== "active") {
        sendError(res, 403, "Remote session devices are disabled or revoked");
        return;
      }
      if (
        grant.desktopDeviceId !== desktop.id
        || grant.mobileDeviceId !== mobile.id
        || grant.approvalStatus !== "approved"
        || Boolean(grant.revokedAt)
        || Date.parse(grant.expiresAt) <= current
      ) {
        sendError(res, 403, "Remote access grant is not active for this device pair");
        return;
      }
      if (requestedScopes.some((scope) => !grant.scopes.includes(scope))) {
        sendError(res, 403, "Requested relay scopes exceed the approved grant");
        return;
      }
      if (!isCurrentSession(deviceSession, mobile.id, current)) {
        sendError(res, 403, "Device session is expired, rotated, reused, or revoked");
        return;
      }
      const ticket = await deps.controlPlane.issueRelayTicket(req.orgId!, req.userId!, {
        presentingDeviceId: mobile.id,
        peerDeviceId: desktop.id,
        grantId: grant.id,
        deviceSessionId: deviceSession.id,
        scopes: requestedScopes,
      });
      res.status(201).json(ticket);
    } catch (error) { routeError(res, error); }
  });

  // The desktop's attach ticket for the SAME grant/relay session: presenting and
  // peer swap relative to the mobile ticket, and the presented device session must
  // belong to the grant's DESKTOP device. The relay pairs the two by grant id.
  router.post("/grants/:id/desktop-tickets", requirePermission("remote:connect"), async (req: AuthedRequest, res) => {
    try {
      const grantId = idSchema.parse(req.params.id);
      const input = createDesktopTicketSchema.parse(req.body);
      const requestedScopes = normalizeRemoteAccessScopes(input.scopes);
      const grant = await deps.store.getRemoteAccessGrant(req.orgId!, req.userId!, grantId);
      const current = now();
      if (!grant) {
        sendError(res, 404, "Remote access grant was not found");
        return;
      }
      if (grant.approvalStatus !== "approved" || Boolean(grant.revokedAt) || Date.parse(grant.expiresAt) <= current) {
        sendError(res, 403, "Remote access grant is not active for this device pair");
        return;
      }
      if (requestedScopes.some((scope) => !grant.scopes.includes(scope))) {
        sendError(res, 403, "Requested relay scopes exceed the approved grant");
        return;
      }
      const [desktop, deviceSession] = await Promise.all([
        deps.store.getRemoteDevice(req.orgId!, req.userId!, grant.desktopDeviceId),
        deps.store.getDeviceSession(req.orgId!, req.userId!, input.deviceSessionId),
      ]);
      if (!desktop || !deviceSession) {
        sendError(res, 404, "Remote session prerequisites were not found");
        return;
      }
      if (desktop.kind !== "desktop" || desktop.status !== "active") {
        sendError(res, 403, "Remote session devices are disabled or revoked");
        return;
      }
      if (!isCurrentSession(deviceSession, desktop.id, current)) {
        sendError(res, 403, "Device session is expired, rotated, reused, or revoked");
        return;
      }
      const ticket = await deps.controlPlane.issueRelayTicket(req.orgId!, req.userId!, {
        presentingDeviceId: desktop.id,
        peerDeviceId: grant.mobileDeviceId,
        grantId: grant.id,
        deviceSessionId: deviceSession.id,
        scopes: requestedScopes,
      });
      res.status(201).json(ticket);
    } catch (error) { routeError(res, error); }
  });

  router.get("/audit", requirePermission("remote:read"), async (req: AuthedRequest, res) => {
    try {
      const parsed = Number.parseInt(typeof req.query.limit === "string" ? req.query.limit : "100", 10);
      const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 100;
      const audit = await deps.store.listRemoteAccessAudit(req.orgId!, req.userId!, limit);
      res.json({ audit: audit.map(publicAudit) });
    } catch (error) { routeError(res, error); }
  });

  return router;
}

const controlPlane = new RemoteControlPlaneService(memoryEngine.remote);
export const remoteRouter = createRemoteRouter({ store: memoryEngine.remote, controlPlane });
