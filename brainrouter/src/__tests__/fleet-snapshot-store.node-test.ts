import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";

/**
 * HONK-H3.3 — the brain persists a client-pushed fleet queue snapshot per
 * (tenant, host) so a remote brain / dashboard can serve it back. Real Postgres.
 */

const snap = (total: number) => ({ total, byStatus: { pending: total, running: 0, done: 0, failed: 0, cancelled: 0 }, running: [], recent: [] });

test("HONK fleet store: put → get round-trips; missing → empty list", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    assert.deepEqual(await store.getFleetSnapshots("u1"), []);

    await store.putFleetSnapshot("u1", "hostA", snap(3), 3);
    const got = await store.getFleetSnapshots("u1");
    assert.equal(got.length, 1);
    assert.equal(got[0].host, "hostA");
    assert.equal(got[0].jobCount, 3);
    assert.deepEqual(got[0].snapshot, snap(3)); // exact round-trip
    assert.ok(got[0].updatedAt);
  } finally {
    await cleanup();
  }
});

test("HONK fleet store: upsert replaces in place; multiple hosts coexist; tenant isolation", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.putFleetSnapshot("u1", "hostA", snap(2), 2);
    await store.putFleetSnapshot("u1", "hostA", snap(7), 7); // upsert same (user, host)
    let got = await store.getFleetSnapshots("u1");
    assert.equal(got.length, 1, "still a single row for hostA");
    assert.equal(got[0].jobCount, 7);
    assert.equal((got[0].snapshot as { total: number }).total, 7);

    // a second host coexists
    await store.putFleetSnapshot("u1", "hostB", snap(1), 1);
    got = await store.getFleetSnapshots("u1");
    assert.equal(got.length, 2);

    // tenant isolation — u2 sees nothing of u1's snapshots
    assert.deepEqual(await store.getFleetSnapshots("u2"), []);
  } finally {
    await cleanup();
  }
});

test("HONK fleet store: a corrupt snapshot row relays as null, not a throw", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    // jobCount=0 path + an empty snapshot still round-trips cleanly.
    await store.putFleetSnapshot("u1", "h", {}, 0);
    const got = await store.getFleetSnapshots("u1");
    assert.equal(got.length, 1);
    assert.equal(got[0].jobCount, 0);
    assert.deepEqual(got[0].snapshot, {});
  } finally {
    await cleanup();
  }
});
