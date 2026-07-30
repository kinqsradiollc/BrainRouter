import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../memory/store/postgres/queries/executor.js";
import {
  appendRemoteAccessAudit,
  createDeviceSession,
  createRemoteAccessGrant,
  getDeviceSession,
  getRemoteAccessGrant,
  getRemoteDevice,
  revokeRemoteAccessGrant,
  rotateDeviceSession,
} from "../memory/store/postgres/queries/remoteAccessQueries.js";
import {
  fingerprintDevicePublicKey,
  hashDeviceRefreshToken,
} from "./store.js";

const now = "2026-07-14T00:00:00.000Z";
const later = "2026-07-15T00:00:00.000Z";
const currentHash = "a".repeat(64);
const nextHash = "b".repeat(64);

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rds-current",
    family_id: "rfs-family",
    org_id: "org-a",
    user_id: "user-a",
    device_id: "rdev-desktop",
    generation: 0,
    parent_session_id: null,
    replaced_by_session_id: null,
    expires_at: later,
    rotated_at: null,
    reuse_detected_at: null,
    revoked_at: null,
    revocation_reason: null,
    created_at: now,
    updated_at: now,
    device_status: "active",
    ...overrides,
  };
}

describe("remote device credential contracts", () => {
  it("uses domain-separated hashes and stable public-key fingerprints", async () => {
    const token = "device-refresh-token-with-at-least-32-characters";
    const publicKey = "ed25519-public-key-material-with-enough-entropy";

    expect(hashDeviceRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceRefreshToken(token)).toBe(hashDeviceRefreshToken(token));
    expect(hashDeviceRefreshToken(`${token}-different`)).not.toBe(hashDeviceRefreshToken(token));
    expect(fingerprintDevicePublicKey(publicKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintDevicePublicKey(publicKey)).toBe(fingerprintDevicePublicKey(`  ${publicKey}\n`));

    const run = vi.fn();
    const exec = { run } as unknown as Executor;
    await expect(createDeviceSession(exec, "org-a", "user-a", {
      deviceId: "rdev-desktop",
      tokenHash: token,
      expiresAt: later,
    }, now)).rejects.toThrow("only a SHA-256 token hash");
    expect(run).not.toHaveBeenCalled();
  });

  it("scopes device, session, grant, and revocation lookups by org and user", async () => {
    const one = vi.fn().mockResolvedValue(null);
    const run = vi.fn().mockResolvedValue(0);
    const exec = { one, run } as unknown as Executor;

    await getRemoteDevice(exec, "org-a", "user-a", "rdev-a");
    await getDeviceSession(exec, "org-a", "user-a", "rds-a");
    await getRemoteAccessGrant(exec, "org-a", "user-a", "rgrant-a");
    await revokeRemoteAccessGrant(exec, "org-a", "user-a", "rgrant-a", "user_revoked", now);

    for (const call of one.mock.calls) {
      expect(call[0]).toMatch(/org_id = \$2 AND user_id = \$3/);
    }
    expect(one.mock.calls.map((call) => call[1])).toEqual([
      ["rdev-a", "org-a", "user-a"],
      ["rds-a", "org-a", "user-a"],
      ["rgrant-a", "org-a", "user-a"],
    ]);
    expect(run.mock.calls[0][0]).toMatch(/id = \$1 AND org_id = \$2 AND user_id = \$3/);
    expect(run.mock.calls[0][1]).toEqual(["rgrant-a", "org-a", "user-a", now, "user_revoked"]);
  });
});

describe("rotating device-session families", () => {
  it("detects reuse and atomically revokes the whole scoped family", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [sessionRow({
          rotated_at: "2026-07-14T00:01:00.000Z",
          replaced_by_session_id: "rds-next",
        })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const tx = vi.fn(async (fn: (client: PoolClient) => Promise<unknown>) => fn({ query } as unknown as PoolClient));
    const exec = { tx } as unknown as Executor;

    await expect(rotateDeviceSession(exec, "org-a", "user-a", {
      tokenHash: currentHash,
      nextTokenHash: nextHash,
      nextExpiresAt: later,
    }, now)).resolves.toEqual({ status: "reuse-detected" });

    expect(query.mock.calls[0][0]).toContain("s.id, s.family_id, s.org_id, s.user_id");
    expect(query.mock.calls[0][1]).toEqual([currentHash, "org-a", "user-a"]);
    expect(query.mock.calls[1][0]).toContain("reuse_detected_at = COALESCE");
    expect(query.mock.calls[1][0]).toContain("WHERE family_id = $1 AND org_id = $2 AND user_id = $3");
    expect(query.mock.calls[1][1]).toEqual(["rfs-family", "org-a", "user-a", now]);
  });

  it("rotates to generation + 1 without returning either credential hash", async () => {
    const created = sessionRow({
      id: "rds-next",
      generation: 1,
      parent_session_id: "rds-current",
      created_at: now,
      updated_at: now,
    });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [sessionRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [created], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const tx = vi.fn(async (fn: (client: PoolClient) => Promise<unknown>) => fn({ query } as unknown as PoolClient));
    const exec = { tx } as unknown as Executor;

    const result = await rotateDeviceSession(exec, "org-a", "user-a", {
      tokenHash: currentHash,
      nextTokenHash: nextHash,
      nextExpiresAt: later,
    }, now);

    expect(result).toMatchObject({ status: "rotated", session: { id: "rds-next", generation: 1 } });
    expect(JSON.stringify(result)).not.toContain(currentHash);
    expect(JSON.stringify(result)).not.toContain(nextHash);
    expect(query.mock.calls[1][1]).toEqual([
      expect.stringMatching(/^rds_/),
      "rfs-family",
      "org-a",
      "user-a",
      "rdev-desktop",
      nextHash,
      1,
      "rds-current",
      later,
      now,
    ]);
    expect(query.mock.calls[2][1]).toEqual([
      "rds-current",
      "org-a",
      "user-a",
      now,
      expect.stringMatching(/^rds_/),
    ]);
  });
});

describe("remote grants and metadata-only audit", () => {
  it("creates only a same-owner active desktop/mobile grant with canonical scopes", async () => {
    const run = vi.fn().mockResolvedValue(1);
    const one = vi.fn().mockResolvedValue({
      id: "rgrant-a",
      org_id: "org-a",
      user_id: "user-a",
      desktop_device_id: "rdev-desktop",
      mobile_device_id: "rdev-mobile",
      scopes_json: '["monitor","approve"]',
      approval_status: "pending",
      decided_at: null,
      decided_by_device_id: null,
      expires_at: later,
      revoked_at: null,
      revocation_reason: null,
      created_at: now,
      updated_at: now,
    });
    const exec = { run, one } as unknown as Executor;

    await createRemoteAccessGrant(exec, "org-a", "user-a", {
      desktopDeviceId: "rdev-desktop",
      mobileDeviceId: "rdev-mobile",
      scopes: ["approve", "monitor", "approve"],
      expiresAt: later,
    }, now);

    expect(run.mock.calls[0][0]).toContain("desktop.kind = 'desktop' AND mobile.kind = 'mobile'");
    expect(run.mock.calls[0][0]).toContain("desktop.status = 'active' AND mobile.status = 'active'");
    expect(run.mock.calls[0][1]).toEqual([
      expect.stringMatching(/^rgrant_/),
      "org-a",
      "user-a",
      "rdev-desktop",
      "rdev-mobile",
      '["monitor","approve"]',
      later,
      now,
    ]);
  });

  it("rejects arbitrary content fields and persists only fixed audit metadata", async () => {
    const run = vi.fn().mockResolvedValue(1);
    const exec = { run } as unknown as Executor;

    await expect(appendRemoteAccessAudit(exec, "org-a", "user-a", {
      eventType: "connection_closed",
      terminalContent: "sensitive terminal output",
      refreshToken: "reusable-secret",
    } as never, now)).rejects.toThrow("metadata fields only");
    expect(run).not.toHaveBeenCalled();

    const record = await appendRemoteAccessAudit(exec, "org-a", "user-a", {
      eventType: "scope_changed",
      scopes: ["control", "monitor"],
      reasonCode: "grant_updated",
      requestId: "request-a",
    }, now);

    expect(record.scopes).toEqual(["monitor", "control"]);
    expect(run.mock.calls[0][0]).toContain("event_type, actor_device_id, target_device_id");
    expect(run.mock.calls[0][0]).not.toMatch(/terminal|payload|content|credential|password/i);
    expect(run.mock.calls[0][1]).toEqual([
      expect.stringMatching(/^raud_/),
      "org-a",
      "user-a",
      "scope_changed",
      null,
      null,
      null,
      null,
      '["monitor","control"]',
      "grant_updated",
      "request-a",
      now,
    ]);
  });

  it("rejects audit session-family references outside the active tenant", async () => {
    const one = vi.fn().mockResolvedValue(null);
    const run = vi.fn();
    const exec = { one, run } as unknown as Executor;

    await expect(appendRemoteAccessAudit(exec, "org-a", "user-a", {
      eventType: "session_revoked",
      sessionFamilyId: "rfs-foreign",
    }, now)).rejects.toThrow("session family is outside");

    expect(one).toHaveBeenCalledWith(
      expect.stringContaining("family_id = $1 AND org_id = $2 AND user_id = $3"),
      ["rfs-foreign", "org-a", "user-a"],
    );
    expect(run).not.toHaveBeenCalled();
  });
});
