import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createTestStore } from "./helpers/pgTestStore.js";
import { makeRefreshSessionStore } from "../memory/store/postgres/queries/refreshSessionQueries.js";
import {
  issueRefreshSession,
  rotateRefreshSession,
  revokeAllSessions,
  hashRefreshToken,
} from "../api/routes/identity/refreshSessions.js";

/** Minimal Executor over a raw pool — the query module uses run/one only. */
function poolExec(pool: pg.Pool): any {
  return {
    rows: async (t: string, p?: any[]) => (await pool.query(t, p)).rows,
    one: async (t: string, p?: any[]) => (await pool.query(t, p)).rows[0] ?? null,
    run: async (t: string, p?: any[]) => (await pool.query(t, p)).rowCount ?? 0,
    tx: async () => { throw new Error("tx unused"); },
  };
}
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);

test("ADR-037 B1 — Postgres refresh-session store: issue, hashed lookup, rotate-once, reuse-revokes-chain, revoke-all", async () => {
  const { url, cleanup } = await createTestStore();
  const pool = new pg.Pool({ connectionString: url });
  const store = makeRefreshSessionStore(poolExec(pool));
  try {
    // issue — the row exists and the token is stored HASHED, never raw.
    const id1 = await issueRefreshSession({ store, userId: "u1", rawToken: "tok1", expiresAt: hours(1) });
    const row = await store.findByHash(hashRefreshToken("tok1"));
    assert.ok(row, "session found by hash");
    assert.equal(row!.id, id1);
    assert.equal(row!.userId, "u1");
    assert.equal(row!.tokenHash, hashRefreshToken("tok1"));
    assert.notEqual(row!.tokenHash, "tok1");
    assert.equal(row!.replacedBy, null);
    assert.equal(row!.revokedAt, null);

    // rotate once — ok, and the old row now points at its successor.
    const succ = await issueRefreshSession({ store, userId: "u1", rawToken: "tok2", expiresAt: hours(1) });
    const first = await rotateRefreshSession({ store, presentedToken: "tok1", successorId: succ });
    assert.equal(first.status, "ok");
    assert.equal((await store.findByHash(hashRefreshToken("tok1")))!.replacedBy, succ);

    // reuse of the already-rotated token — theft: the whole chain is revoked.
    const replay = await rotateRefreshSession({ store, presentedToken: "tok1", successorId: "rs_never" });
    assert.equal(replay.status, "reused");
    for (const t of ["tok1", "tok2"]) {
      assert.notEqual((await store.findByHash(hashRefreshToken(t)))!.revokedAt, null, `${t} revoked`);
    }

    // a fresh session for a second user, then revoke-all for that user.
    await issueRefreshSession({ store, userId: "u2", rawToken: "tok3", expiresAt: hours(1) });
    const n = await revokeAllSessions(store, "u2", "password reset");
    assert.equal(n, 1);
    assert.notEqual((await store.findByHash(hashRefreshToken("tok3")))!.revokedAt, null);
    // revoke-all is idempotent (already-revoked rows aren't re-counted).
    assert.equal(await revokeAllSessions(store, "u2", "again"), 0);

    // an expired session rotates to "expired", not "ok".
    await issueRefreshSession({ store, userId: "u3", rawToken: "tok4", expiresAt: hours(-1) });
    assert.equal((await rotateRefreshSession({ store, presentedToken: "tok4", successorId: "x" })).status, "expired");
  } finally {
    await pool.end().catch(() => undefined);
    await cleanup();
  }
});
