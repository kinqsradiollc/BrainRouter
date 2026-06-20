import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";

interface TestClock {
  now: number;
}

function freshDb(
  label: string,
  clock: TestClock,
  options?: { ttlSeconds?: number; maxEntries?: number },
): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-compression-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"), {
    compressionStore: {
      now: () => clock.now,
      ttlSeconds: options?.ttlSeconds,
      maxEntries: options?.maxEntries,
    },
  });
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

test("CCR store round-trips the exact original and tracks retrievals", () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = freshDb("round-trip", clock);
  try {
    const original = JSON.stringify([{ id: 1, message: "first" }, { id: 2, message: "second" }]);
    const stored = store.storeCompressionEntry(entry("u1", original));

    assert.match(stored.hash, /^[a-f0-9]{24}$/);
    const retrieved = store.retrieveCompressionEntry("u1", stored.hash);
    assert.equal(retrieved?.kind, "full");
    assert.equal(retrieved?.originalContent, original);
    assert.equal(retrieved?.entry.retrievalCount, 1);
    assert.equal(retrieved?.entry.lastAccessed, clock.now);
  } finally {
    cleanup();
  }
});

test("CCR store deletes expired entries before returning a miss", () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = freshDb("expiry", clock, { ttlSeconds: 10 });
  try {
    const stored = store.storeCompressionEntry(entry("u1", "expired source"));
    clock.now += 10;

    assert.equal(store.retrieveCompressionEntry("u1", stored.hash), null);
    assert.equal(store.getCompressionEntryMetadata("u1", stored.hash), null);
  } finally {
    cleanup();
  }
});

test("CCR store never retrieves another tenant's entry", () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = freshDb("tenant", clock);
  try {
    const stored = store.storeCompressionEntry(entry("owner", "private source"));

    assert.equal(store.retrieveCompressionEntry("other", stored.hash), null);
    assert.equal(store.getCompressionEntryMetadata("other", stored.hash), null);
    assert.equal(store.retrieveCompressionEntry("owner", stored.hash)?.originalContent, "private source");
  } finally {
    cleanup();
  }
});

test("CCR store keeps identical content from two tenants in separate rows", () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = freshDb("tenant-collision", clock);
  try {
    // Same content => same content hash. With a bare `hash PRIMARY KEY` the
    // second tenant's INSERT would fail with a UNIQUE constraint violation.
    const shared = JSON.stringify([{ id: 1, message: "shared" }]);
    const alice = store.storeCompressionEntry(entry("alice", shared));
    const bob = store.storeCompressionEntry(entry("bob", shared));

    assert.equal(alice.hash, bob.hash);
    assert.equal(store.retrieveCompressionEntry("alice", alice.hash)?.originalContent, shared);
    assert.equal(store.retrieveCompressionEntry("bob", bob.hash)?.originalContent, shared);
    // Each tenant still sees exactly one entry — no cross-tenant pooling.
    assert.equal(store.getCompressionStats("alice").compressions, 1);
    assert.equal(store.getCompressionStats("bob").compressions, 1);
  } finally {
    cleanup();
  }
});

test("CCR store rejects malformed hashes on write and returns a miss on retrieval", () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = freshDb("hash", clock);
  try {
    assert.throws(
      () => store.storeCompressionEntry(entry("u1", "source", "not-a-valid-hash")),
      /24 lowercase hexadecimal characters/,
    );
    assert.equal(store.retrieveCompressionEntry("u1", "not-a-valid-hash"), null);
  } finally {
    cleanup();
  }
});

test("CCR store returns a relevant subset for JSON-array query retrieval", () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = freshDb("query", clock);
  try {
    const original = JSON.stringify([
      { id: 1, message: "startup completed" },
      { id: 2, message: "database connection failed" },
      { id: 3, message: "database retry succeeded" },
      { id: 4, message: "cache warmed" },
    ]);
    const stored = store.storeCompressionEntry(entry("u1", original));
    const retrieved = store.retrieveCompressionEntry("u1", stored.hash, "database failed");

    assert.equal(retrieved?.kind, "subset");
    assert.deepEqual(retrieved?.results, [{ id: 2, message: "database connection failed" }, { id: 3, message: "database retry succeeded" }]);
  } finally {
    cleanup();
  }
});

test("CCR store evicts the oldest entry when the capacity is exceeded", () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = freshDb("eviction", clock, { maxEntries: 2 });
  try {
    const oldest = store.storeCompressionEntry(entry("u1", "oldest"));
    clock.now += 1;
    const middle = store.storeCompressionEntry(entry("u1", "middle"));
    clock.now += 1;
    const newest = store.storeCompressionEntry(entry("u1", "newest"));

    assert.equal(store.retrieveCompressionEntry("u1", oldest.hash), null);
    assert.equal(store.retrieveCompressionEntry("u1", middle.hash)?.originalContent, "middle");
    assert.equal(store.retrieveCompressionEntry("u1", newest.hash)?.originalContent, "newest");
  } finally {
    cleanup();
  }
});

test("CCR store reports user-scoped compression and retrieval statistics", () => {
  const clock = { now: 1_000 };
  const { store, cleanup } = freshDb("stats", clock);
  try {
    const first = store.storeCompressionEntry(entry("u1", "first source"));
    clock.now += 1;
    store.storeCompressionEntry(entry("u2", "second source"));
    store.retrieveCompressionEntry("u1", first.hash);
    store.retrieveCompressionEntry("u1", first.hash);

    assert.deepEqual(store.getCompressionStats("u1"), {
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
    cleanup();
  }
});
