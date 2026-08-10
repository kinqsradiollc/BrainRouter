/**
 * A refresh token must be revocable, and its reuse must be detectable.
 *
 * Both were impossible before: the token was a bare signed JWT with no row, so
 * /signout could only pretend, a password reset left stolen tokens working for
 * their full 30 days, and rotation handed out a new token while leaving the old
 * one valid — which is the state an attacker most wants and the one we could
 * least see.
 */
import { describe, expect, it } from "vitest";
import {
  hashRefreshToken,
  issueRefreshSession,
  rotateRefreshSession,
  revokeAllSessions,
  type RefreshSessionRow,
  type RefreshSessionStore,
} from "./refreshSessions.js";

function memoryStore(): RefreshSessionStore & { rows: Map<string, RefreshSessionRow> } {
  const rows = new Map<string, RefreshSessionRow>();
  return {
    rows,
    async insert(row) {
      rows.set(row.id, { ...row, revokedAt: null, revokedReason: null, replacedBy: null });
    },
    async findByHash(tokenHash) {
      return [...rows.values()].find((row) => row.tokenHash === tokenHash) ?? null;
    },
    async markReplaced(id, replacedBy) {
      const row = rows.get(id);
      if (row) row.replacedBy = replacedBy;
    },
    async revokeById(id, reason) {
      const row = rows.get(id);
      if (row && !row.revokedAt) { row.revokedAt = new Date(); row.revokedReason = reason; }
    },
    async revokeAllForUser(userId, reason) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.userId === userId && !row.revokedAt) {
          row.revokedAt = new Date(); row.revokedReason = reason; count += 1;
        }
      }
      return count;
    },
  };
}

const hour = (n: number) => new Date(Date.now() + n * 3_600_000);

describe("refresh sessions", () => {
  it("stores the token hashed, never raw", async () => {
    const store = memoryStore();
    await issueRefreshSession({ store, userId: "u1", rawToken: "secret-token", expiresAt: hour(1) });
    const row = [...store.rows.values()][0]!;
    // A database read must not yield a usable session.
    expect(row.tokenHash).not.toContain("secret-token");
    expect(row.tokenHash).toBe(hashRefreshToken("secret-token"));
  });

  it("rotates a valid token exactly once", async () => {
    const store = memoryStore();
    await issueRefreshSession({ store, userId: "u1", rawToken: "t1", expiresAt: hour(1) });
    const first = await rotateRefreshSession({ store, presentedToken: "t1", successorId: "rs_2" });
    expect(first.status).toBe("ok");
  });

  it("treats a second use of the same token as theft and revokes the whole chain", async () => {
    const store = memoryStore();
    await issueRefreshSession({ store, userId: "u1", rawToken: "t1", expiresAt: hour(1) });
    await issueRefreshSession({ store, userId: "u1", rawToken: "t2", expiresAt: hour(1) });
    await rotateRefreshSession({ store, presentedToken: "t1", successorId: "rs_2" });

    // The victim rotated; now the attacker presents the copy they stole.
    const replay = await rotateRefreshSession({ store, presentedToken: "t1", successorId: "rs_3" });
    expect(replay.status).toBe("reused");
    // Both holders lose. We cannot tell which one is legitimate, and letting
    // both continue is precisely the attacker's preferred outcome.
    expect([...store.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("refuses an expired token even though its signature is fine", async () => {
    const store = memoryStore();
    await issueRefreshSession({ store, userId: "u1", rawToken: "t1", expiresAt: hour(-1) });
    expect((await rotateRefreshSession({ store, presentedToken: "t1", successorId: "rs_2" })).status)
      .toBe("expired");
  });

  it("refuses a revoked token, which is what makes signout real", async () => {
    const store = memoryStore();
    await issueRefreshSession({ store, userId: "u1", rawToken: "t1", expiresAt: hour(1) });
    await revokeAllSessions(store, "u1", "signed out");
    expect((await rotateRefreshSession({ store, presentedToken: "t1", successorId: "rs_2" })).status)
      .toBe("revoked");
  });

  it("refuses a token it never issued", async () => {
    const store = memoryStore();
    expect((await rotateRefreshSession({ store, presentedToken: "forged", successorId: "rs_2" })).status)
      .toBe("unknown");
  });

  it("revoking a user's sessions leaves other users alone", async () => {
    const store = memoryStore();
    await issueRefreshSession({ store, userId: "u1", rawToken: "a", expiresAt: hour(1) });
    await issueRefreshSession({ store, userId: "u2", rawToken: "b", expiresAt: hour(1) });
    expect(await revokeAllSessions(store, "u1", "password changed")).toBe(1);
    expect((await rotateRefreshSession({ store, presentedToken: "b", successorId: "rs_9" })).status)
      .toBe("ok");
  });
});
