/**
 * ADR-029 Part D — the notes schema (migration 052), against a real Postgres.
 *
 * These are the claims the SQL makes rather than the merge policy does, and each
 * one fails silently if it is wrong:
 *
 *   - the (org, user, id) partition, so two people's blocks cannot collide
 *   - a revision cursor that advances on UPDATE, without which every device but
 *     the writer stays stale forever and nothing errors
 *   - backlinks scoped to what the viewer may see, so "what links here" does not
 *     answer with the existence of notes they cannot open
 *   - one attachment object per digest, however many notes paste it
 *   - the derived rows going away with the content they were derived from
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";

const ORG = "org-a";
const ALICE = "user-alice";
const BOB = "user-bob";

type Store = Awaited<ReturnType<typeof createTestStore>>["store"];

async function putBlock(
  store: Store,
  userId: string,
  id: string,
  text: string,
  opts: { visibility?: string; deleted?: boolean } = {},
): Promise<void> {
  await store.upsertNoteBlock(ORG, userId, {
    id,
    parentId: null,
    kind: "paragraph",
    ...(opts.visibility ? { visibility: opts.visibility } : {}),
    payload: { id, text: { value: text, at: { physical: 1, logical: 0, deviceId: "d" } } },
    deletedAtHlc: opts.deleted ? "1.0.d" : null,
  });
}

test("two people's notes with the same id are two rows, not one overwriting the other", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await putBlock(store, ALICE, "blk_1", "alice's paragraph");
    await putBlock(store, BOB, "blk_1", "bob's paragraph");

    const alice = await store.getNoteBlock(ORG, ALICE, "blk_1");
    const bob = await store.getNoteBlock(ORG, BOB, "blk_1");
    assert.equal((alice?.payload as any).text.value, "alice's paragraph");
    assert.equal((bob?.payload as any).text.value, "bob's paragraph");

    // Cross-user reads are impossible by construction, not by a filter someone
    // has to remember to write.
    const all = await store.listAllNoteBlocks(ORG, ALICE);
    assert.equal(all.length, 1);
  } finally {
    await cleanup();
  }
});

test("an update advances the revision, so another device's changed-since pull actually sees it", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await putBlock(store, ALICE, "blk_1", "first");
    const cursor = await store.latestNoteRevision(ORG, ALICE);

    await putBlock(store, ALICE, "blk_1", "second");

    const changed = await store.listNoteBlocksSince(ORG, ALICE, cursor);
    assert.equal(changed.length, 1, "the edited block is in the next pull");
    assert.equal((changed[0]!.payload as any).text.value, "second");
    assert.ok(Number(await store.latestNoteRevision(ORG, ALICE)) > Number(cursor));
  } finally {
    await cleanup();
  }
});

test("a redelivered operation key is recorded once per tenant, never across them", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.recordNoteOperationApplied(ORG, ALICE, "op-1", "blk_1");
    await store.recordNoteOperationApplied(ORG, ALICE, "op-1", "blk_1");

    assert.equal(await store.wasNoteOperationApplied(ORG, ALICE, "op-1"), true);
    // Migration 049 fixed exactly this shape being cross-tenant: one person's
    // key must not suppress another's operation.
    assert.equal(await store.wasNoteOperationApplied(ORG, BOB, "op-1"), false);
  } finally {
    await cleanup();
  }
});

test("what links here answers over the viewer's corpus, not over notes they cannot open", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const target = "brainrouter://planner/item/itm_4f2a";
    await putBlock(store, ALICE, "blk_a", `mine, citing ${target}`);
    await putBlock(store, BOB, "blk_private", `bob's private note citing ${target}`);
    await putBlock(store, BOB, "blk_shared", `bob's shared note citing ${target}`, { visibility: "org" });
    for (const [user, id] of [[ALICE, "blk_a"], [BOB, "blk_private"], [BOB, "blk_shared"]] as const) {
      await store.replaceNoteRefs(ORG, user, id, [{
        targetKey: target, targetMode: "planner", targetKind: "item", targetId: "itm_4f2a",
        fragments: [], citeCount: 1,
      }]);
    }

    const seen = await store.listNoteBacklinks(ORG, ALICE, target);

    assert.deepEqual(seen.map((r) => r.fromBlockId).sort(), ["blk_a", "blk_shared"]);
  } finally {
    await cleanup();
  }
});

test("a backlink is keyed without its fragment, so two lines of one file are one target", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const target = "brainrouter://code/file/src/x.ts";
    await putBlock(store, ALICE, "blk_a", "cites L59");
    await putBlock(store, ALICE, "blk_b", "cites L12");
    await store.replaceNoteRefs(ORG, ALICE, "blk_a", [{
      targetKey: target, targetMode: "code", targetKind: "file", targetId: "src/x.ts",
      fragments: ["L59"], citeCount: 1,
    }]);
    await store.replaceNoteRefs(ORG, ALICE, "blk_b", [{
      targetKey: target, targetMode: "code", targetKind: "file", targetId: "src/x.ts",
      fragments: ["L12"], citeCount: 1,
    }]);

    const rows = await store.listNoteBacklinks(ORG, ALICE, target);

    assert.equal(rows.length, 2, "both notes link to the same file");
    // The line each one pointed at is still recoverable, on the edge.
    assert.deepEqual(rows.flatMap((r) => r.fragments).sort(), ["L12", "L59"]);
  } finally {
    await cleanup();
  }
});

test("search matches prose and references separately, and says which half it matched", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await putBlock(store, ALICE, "blk_prose", "the parser rewrite is nearly done");
    await putBlock(store, ALICE, "blk_link", "follow up");
    await store.upsertNoteIndex(ORG, ALICE, "blk_prose", { contentText: "the parser rewrite is nearly done", refKeys: [] });
    await store.upsertNoteIndex(ORG, ALICE, "blk_link", {
      contentText: "follow up",
      refKeys: ["brainrouter://track/work-item/BR-114"],
    });

    const prose = await store.searchNoteIndex(ORG, ALICE, "parser");
    assert.deepEqual(prose.map((h) => h.blockId), ["blk_prose"]);
    assert.equal(prose[0]!.matchedText, true);
    assert.equal(prose[0]!.matchedReference, false);

    // B5's own example: the thing a person remembers is the id, which nobody
    // typed as a word and which prose search alone cannot find.
    const byRef = await store.searchNoteIndex(ORG, ALICE, "BR-114");
    assert.deepEqual(byRef.map((h) => h.blockId), ["blk_link"]);
    assert.equal(byRef[0]!.matchedReference, true);
  } finally {
    await cleanup();
  }
});

test("a tombstoned block is not a search result", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await putBlock(store, ALICE, "blk_1", "the parser rewrite");
    await store.upsertNoteIndex(ORG, ALICE, "blk_1", { contentText: "the parser rewrite", refKeys: [] });
    assert.equal((await store.searchNoteIndex(ORG, ALICE, "parser")).length, 1);

    await putBlock(store, ALICE, "blk_1", "the parser rewrite", { deleted: true });

    assert.equal((await store.searchNoteIndex(ORG, ALICE, "parser")).length, 0);
  } finally {
    await cleanup();
  }
});

test("the same image pasted into three notes is one object with three references", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const hash = "a".repeat(64);
    for (const id of ["blk_1", "blk_2", "blk_3"]) await putBlock(store, ALICE, id, "see below");

    for (const id of ["blk_1", "blk_2", "blk_3"]) {
      // Each paste registers the object again; the digest IS the identity, so
      // the second and third collide rather than storing bytes twice.
      await store.registerNoteAttachment(ORG, {
        contentHash: hash, byteSize: 2048, mediaType: "image/png", storageKey: `objects/${hash}`,
      });
      await store.linkNoteAttachment(ORG, ALICE, { blockId: id, contentHash: hash, fileName: `${id}.png` });
    }

    assert.equal(await store.countNoteAttachmentUses(ORG, hash), 3);
    const onBlock1 = await store.listNoteAttachments(ORG, ALICE, "blk_1");
    assert.equal(onBlock1.length, 1);
    assert.equal(onBlock1[0]!.fileName, "blk_1.png", "the name at the use site, not on the object");

    await store.unlinkNoteAttachment(ORG, ALICE, "blk_1", hash);
    assert.equal(await store.countNoteAttachmentUses(ORG, hash), 2);
    assert.equal((await store.listUnreferencedNoteAttachments(ORG, 0)).length, 0, "still referenced twice");
  } finally {
    await cleanup();
  }
});

test("an attachment nothing points at any more becomes sweepable, and not before", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const hash = "b".repeat(64);
    await putBlock(store, ALICE, "blk_1", "see below");
    await store.registerNoteAttachment(ORG, {
      contentHash: hash, byteSize: 10, mediaType: "image/png", storageKey: `objects/${hash}`,
    });
    await store.linkNoteAttachment(ORG, ALICE, { blockId: "blk_1", contentHash: hash });
    assert.equal((await store.listUnreferencedNoteAttachments(ORG, 0)).length, 0);

    await store.unlinkNoteAttachment(ORG, ALICE, "blk_1", hash);

    assert.deepEqual((await store.listUnreferencedNoteAttachments(ORG, 0)).map((a) => a.contentHash), [hash]);
  } finally {
    await cleanup();
  }
});

test("a block's owner and visibility can be read without reading its text", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    // A4 needs this: "an item you do not have access to" requires knowing a row
    // exists and belongs to someone else. Reading the text to find that out is
    // the leak the answer exists to prevent.
    await putBlock(store, BOB, "blk_1", "bob's private thinking", { visibility: "private" });

    const owner = await store.findNoteBlockInOrg(ORG, "blk_1");

    assert.equal(owner?.userId, BOB);
    assert.equal(owner?.visibility, "private");
    assert.equal((owner as unknown as Record<string, unknown>).payload, undefined);
  } finally {
    await cleanup();
  }
});

test("sharing widens visibility rather than moving the row to another owner", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await putBlock(store, ALICE, "blk_1", "worth sharing");

    await store.setNoteBlockVisibility(ORG, ALICE, "blk_1", "org");

    const owner = await store.findNoteBlockInOrg(ORG, "blk_1");
    assert.equal(owner?.userId, ALICE, "the note is still Alice's");
    assert.equal(owner?.visibility, "org");
  } finally {
    await cleanup();
  }
});

test("the derived rows go away with the content they were derived from", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await putBlock(store, ALICE, "blk_1", "cites brainrouter://planner/item/itm_1");
    await store.replaceNoteRefs(ORG, ALICE, "blk_1", [{
      targetKey: "brainrouter://planner/item/itm_1", targetMode: "planner", targetKind: "item",
      targetId: "itm_1", fragments: [], citeCount: 1,
    }]);
    await store.upsertNoteIndex(ORG, ALICE, "blk_1", { contentText: "cites", refKeys: ["brainrouter://planner/item/itm_1"] });

    // Blocks are tombstoned rather than deleted, so this cascade fires only for
    // a retention sweep — which is the path that would otherwise leave a
    // backlink pointing at a block that is not there.
    const exec = (store as unknown as { exec: { run(sql: string, p: unknown[]): Promise<number> } }).exec;
    await exec.run("DELETE FROM notes_blocks WHERE org_id = $1 AND user_id = $2 AND id = $3", [ORG, ALICE, "blk_1"]);

    assert.equal((await store.listNoteRefsFrom(ORG, ALICE, "blk_1")).length, 0);
    assert.equal((await store.listNoteIndexEntries(ORG, ALICE)).length, 0);
  } finally {
    await cleanup();
  }
});

test("a lease round-trips with the epoch intact and expiry judged on the database's clock", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const dbNow = await store.databaseNowMs();
    await store.upsertNoteBlockLease(ORG, ALICE, {
      blockId: "blk_1", deviceId: "device-a", holder: "the desktop", epoch: 3, expiresAtMs: dbNow + 30_000,
    });

    const read = await store.readNoteBlockLease(ORG, ALICE, "blk_1");
    assert.equal(read.lease?.epoch, 3);
    assert.equal(read.lease?.deviceId, "device-a");
    // The clock comes from the database, not from this process: a lease granted
    // by one API pod and checked by another must not turn skew into a stolen lock.
    assert.ok(read.lease!.expiresAtMs > read.dbNowMs);

    const absent = await store.readNoteBlockLease(ORG, ALICE, "blk_none");
    assert.equal(absent.lease, null, "no lock is an answer, not a missing row");
    assert.ok(absent.dbNowMs > 0);
  } finally {
    await cleanup();
  }
});

test("a swept lease is one old enough that no queued write can still carry its epoch", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const dbNow = await store.databaseNowMs();
    await store.upsertNoteBlockLease(ORG, ALICE, {
      blockId: "blk_recent", deviceId: "device-a", holder: null, epoch: 1, expiresAtMs: dbNow - 1_000,
    });
    await store.upsertNoteBlockLease(ORG, ALICE, {
      blockId: "blk_ancient", deviceId: "device-a", holder: null, epoch: 1, expiresAtMs: dbNow - 40 * 24 * 60 * 60 * 1000,
    });

    const swept = await store.sweepNoteBlockLeases(ORG, 30 * 24 * 60 * 60 * 1000);

    assert.equal(swept, 1);
    // Expired but recent: a device that slept may still flush a write stamped
    // under this epoch, and it has to be fenceable when it does.
    assert.ok((await store.readNoteBlockLease(ORG, ALICE, "blk_recent")).lease);
  } finally {
    await cleanup();
  }
});
