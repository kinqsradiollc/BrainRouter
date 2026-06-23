import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";

interface TestClock {
  now: number;
}

// CCR clock injection: forward the live `clock` closure (`now: () => clock.now`)
// + ttl/maxEntries through the pg test helper into PostgresMemoryStore. The test
// mutates `clock.now` to advance time; the closure reads the live value so the
// store's TTL/eviction logic sees the simulated clock — identical to the old
// SQLite path.
async function freshDb(
  clock: TestClock,
  options?: { ttlSeconds?: number; maxEntries?: number },
): Promise<{ store: Awaited<ReturnType<typeof createTestStore>>["store"]; cleanup: () => Promise<void> }> {
  const { store, cleanup } = await createTestStore({
    compressionStore: {
      now: () => clock.now,
      ttlSeconds: options?.ttlSeconds,
      maxEntries: options?.maxEntries,
    },
  });
  return { store, cleanup };
}

function entry(userId: string, originalContent: string, hash?: string) {
  return {
    userId,
    originalContent,
    compressedContent: "summary",
    originalTokens: 100,
    compressedTokens: 20,
    originalItemCount: 10,
    compressedItemCount: 2,
    toolName: "search",
    queryContext: "incident",
    compressionStrategy: "json-array",
    hash,
  };
}

test("CCR store round-trips the exact original and tracks retrievals", async () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = await freshDb(clock);
  try {
    const original = JSON.stringify([{ id: 1, message: "first" }, { id: 2, message: "second" }]);
    const stored = await store.storeCompressionEntry(entry("u1", original));

    assert.match(stored.hash, /^[a-f0-9]{24}$/);
    const retrieved = await store.retrieveCompressionEntry("u1", stored.hash);
    assert.equal(retrieved?.kind, "full");
    assert.equal(retrieved?.originalContent, original);
    assert.equal(retrieved?.entry.retrievalCount, 1);
    assert.equal(retrieved?.entry.lastAccessed, clock.now);
  } finally {
    await cleanup();
  }
});

test("CCR store deletes expired entries before returning a miss", async () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = await freshDb(clock, { ttlSeconds: 10 });
  try {
    const stored = await store.storeCompressionEntry(entry("u1", "expired source"));
    clock.now += 10;

    assert.equal(await store.retrieveCompressionEntry("u1", stored.hash), null);
    assert.equal(await store.getCompressionEntryMetadata("u1", stored.hash), null);
  } finally {
    await cleanup();
  }
});

test("CCR store never retrieves another tenant's entry", async () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = await freshDb(clock);
  try {
    const stored = await store.storeCompressionEntry(entry("owner", "private source"));

    assert.equal(await store.retrieveCompressionEntry("other", stored.hash), null);
    assert.equal(await store.getCompressionEntryMetadata("other", stored.hash), null);
    assert.equal((await store.retrieveCompressionEntry("owner", stored.hash))?.originalContent, "private source");
  } finally {
    await cleanup();
  }
});

test("CCR store keeps identical content from two tenants in separate rows", async () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = await freshDb(clock);
  try {
    // Same content => same content hash. With a bare `hash PRIMARY KEY` the
    // second tenant's INSERT would fail with a UNIQUE constraint violation.
    const shared = JSON.stringify([{ id: 1, message: "shared" }]);
    const alice = await store.storeCompressionEntry(entry("alice", shared));
    const bob = await store.storeCompressionEntry(entry("bob", shared));

    assert.equal(alice.hash, bob.hash);
    assert.equal((await store.retrieveCompressionEntry("alice", alice.hash))?.originalContent, shared);
    assert.equal((await store.retrieveCompressionEntry("bob", bob.hash))?.originalContent, shared);
    // Each tenant still sees exactly one entry — no cross-tenant pooling.
    assert.equal((await store.getCompressionStats("alice")).compressions, 1);
    assert.equal((await store.getCompressionStats("bob")).compressions, 1);
  } finally {
    await cleanup();
  }
});

test("CCR store rejects malformed hashes on write and returns a miss on retrieval", async () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = await freshDb(clock);
  try {
    await assert.rejects(
      () => store.storeCompressionEntry(entry("u1", "source", "not-a-valid-hash")),
      /24 lowercase hexadecimal characters/,
    );
    assert.equal(await store.retrieveCompressionEntry("u1", "not-a-valid-hash"), null);
  } finally {
    await cleanup();
  }
});

test("CCR store returns a relevant subset for JSON-array query retrieval", async () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = await freshDb(clock);
  try {
    const original = JSON.stringify([
      { id: 1, message: "startup completed" },
      { id: 2, message: "database connection failed" },
      { id: 3, message: "database retry succeeded" },
      { id: 4, message: "cache warmed" },
    ]);
    const stored = await store.storeCompressionEntry(entry("u1", original));
    const retrieved = await store.retrieveCompressionEntry("u1", stored.hash, "database failed");

    assert.equal(retrieved?.kind, "subset");
    assert.deepEqual(retrieved?.results, [{ id: 2, message: "database connection failed" }, { id: 3, message: "database retry succeeded" }]);
  } finally {
    await cleanup();
  }
});

test("CCR store evicts the oldest entry when the capacity is exceeded", async () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = await freshDb(clock, { maxEntries: 2 });
  try {
    const oldest = await store.storeCompressionEntry(entry("u1", "oldest"));
    clock.now += 1;
    const middle = await store.storeCompressionEntry(entry("u1", "middle"));
    clock.now += 1;
    const newest = await store.storeCompressionEntry(entry("u1", "newest"));

    assert.equal(await store.retrieveCompressionEntry("u1", oldest.hash), null);
    assert.equal((await store.retrieveCompressionEntry("u1", middle.hash))?.originalContent, "middle");
    assert.equal((await store.retrieveCompressionEntry("u1", newest.hash))?.originalContent, "newest");
  } finally {
    await cleanup();
  }
});

test("CCR store reports user-scoped compression and retrieval statistics", async () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = await freshDb(clock);
  try {
    const first = await store.storeCompressionEntry(entry("u1", "first source"));
    clock.now += 1;
    await store.storeCompressionEntry(entry("u2", "second source"));
    await store.retrieveCompressionEntry("u1", first.hash);
    await store.retrieveCompressionEntry("u1", first.hash);

    assert.deepEqual(await store.getCompressionStats("u1"), {
      compressions: 1,
      retrievals: 2,
      totalTokensSaved: 80,
      savingsPercent: 80,
      estimatedCostSavedUsd: 0.00024,
      recentEvents: [{
        hash: first.hash,
        createdAt: 1_000,
        originalTokens: 100,
        compressedTokens: 20,
        retrievalCount: 2,
        compressionStrategy: "json-array",
      }],
      store: { entries: 1, maxEntries: 1_000 },
    });
  } finally {
    await cleanup();
  }
});
