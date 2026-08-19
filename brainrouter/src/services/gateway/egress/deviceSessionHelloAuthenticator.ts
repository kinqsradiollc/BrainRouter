import { hashDeviceRefreshToken, type DeviceSessionRecord } from "../../../remote/store.js";
import type { EdgeHelloAuthenticator, EdgeIdentity } from "./egressControlChannel.js";

/**
 * The single store method the authenticator needs: a device-session lookup by
 * the SHA-256 of the presented refresh token, already scoped to (org, user).
 */
export interface DeviceSessionLookup {
  getDeviceSessionByTokenHash(
    orgId: string,
    userId: string,
    tokenHash: string,
  ): Promise<DeviceSessionRecord | null>;
}

export interface DeviceSessionHelloAuthenticatorDeps {
  readonly store: DeviceSessionLookup;
  readonly now?: () => number;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * ADR-043 S3b (C4 follow-up) — the concrete {@link EdgeHelloAuthenticator} the
 * egress control channel injects. The standing control connection presents the
 * device's own rotating device-session refresh token in its hello; we hash it
 * (never storing or logging the raw token), look up the session scoped to
 * (org, user), and admit the connection ONLY if the session is live and its
 * device matches the presented `deviceId`. Every other outcome fails closed to
 * null, which the channel turns into a 4001 close.
 *
 * The refresh-token hash proves possession of the device credential; binding the
 * presented `deviceId` to `session.deviceId` stops a valid token for device A
 * from registering as device B. A revoked, reuse-flagged, or expired session is
 * refused, so a rotated-away or compromised credential cannot hold the channel
 * open and keep receiving dial pushes.
 */
export function createDeviceSessionHelloAuthenticator(
  deps: DeviceSessionHelloAuthenticatorDeps,
): EdgeHelloAuthenticator {
  const now = deps.now ?? Date.now;
  return async (hello: Record<string, unknown>): Promise<EdgeIdentity | null> => {
    const orgId = str(hello.orgId);
    const userId = str(hello.userId);
    const deviceId = str(hello.deviceId);
    const deviceToken = str(hello.deviceToken);
    if (!orgId || !userId || !deviceId || !deviceToken) return null;

    // hashDeviceRefreshToken throws below the entropy floor — treat a malformed
    // token as a rejected hello, not a crash on the connection handler.
    let tokenHash: string;
    try {
      tokenHash = hashDeviceRefreshToken(deviceToken);
    } catch {
      return null;
    }

    const session = await deps.store.getDeviceSessionByTokenHash(orgId, userId, tokenHash);
    if (!session) return null;
    // The lookup already scopes to (org, user); bind the device too so a token
    // cannot register under a different deviceId than the one it was issued to.
    if (session.deviceId !== deviceId) return null;
    if (session.revokedAt) return null;
    if (session.reuseDetectedAt) return null;
    // A rotated-away token still resolves to its (old) row — rotation creates a
    // new row and only marks the old one rotated_at/replaced_by, leaving
    // revoked_at NULL. Admit ONLY the current session, so a captured stale token
    // cannot hold the channel and keep receiving this user's dial pushes.
    if (session.rotatedAt || session.replacedBySessionId) return null;
    // Fail closed on an unparseable expiry (Date.parse → NaN), which would
    // otherwise slip past a bare `<= now()` comparison and admit the session.
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) return null;

    return { orgId, userId, deviceId };
  };
}
