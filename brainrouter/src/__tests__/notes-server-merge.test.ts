/**
 * ADR-029 B2/B3 + ADR-028 D11 — what the SERVER does with a pushed operation.
 *
 * The property under test is the asymmetric one: a client that is behind must
 * not win simply by pushing last. Every case below is a way that could go wrong
 * silently — a stale edit landing on top of a newer one, a resurrected delete
 * quietly un-happening, a redelivered push applying twice — and none of them
 * produces an error at the time, which is why they are pinned here.
 *
 * The store is a fake because the policy is not a SQL question: what is being
 * checked is which version survives, and running it against Postgres would test
 * the same branch through a slower path. `notes-store.node-test.ts` covers the
 * half that IS a SQL question.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hlc, NoteBlock } from "@kinqs/brainrouter-core/notes";

interface StoredBlock {
  parentId: string | null;
  kind: string;
  visibility: string;
  payload: Record<string, unknown>;
  deletedAtHlc: string | null;
  revision: number;
}

class FakeNotesStore {
  blocks = new Map<string, StoredBlock>();
  refs = new Map<string, Array<{ targetKey: string }>>();
  index = new Map<string, { contentText: string; refKeys: string[] }>();
  applied = new Set<string>();
  leases = new Map<string, { blockId: string; deviceId: string; holder: string | null; epoch: number; expiresAtMs: number }>();
  nowMs = 1_000_000;
  upserts = 0;

  private key(orgId: string, userId: string, id: string): string { return `${orgId}/${userId}/${id}`; }

  async databaseNowMs(): Promise<number> { return this.nowMs; }

  async getNoteBlock(orgId: string, userId: string, id: string): Promise<unknown> {
    const row = this.blocks.get(this.key(orgId, userId, id));
    return row ? { id, ...row, revision: String(row.revision), updatedAt: new Date(this.nowMs).toISOString() } : null;
  }

  async listAllNoteBlocks(orgId: string, userId: string): Promise<unknown[]> {
    return [...this.blocks.entries()]
      .filter(([k]) => k.startsWith(`${orgId}/${userId}/`))
      .map(([k, row]) => ({ id: k.split("/").at(-1)!, ...row, revision: String(row.revision) }));
  }

  async upsertNoteBlock(orgId: string, userId: string, block: {
    id: string; parentId: string | null; kind: string; visibility?: string;
    payload: Record<string, unknown>; deletedAtHlc?: string | null;
  }): Promise<unknown> {
    this.upserts += 1;
    const stored: StoredBlock = {
      parentId: block.parentId,
      kind: block.kind,
      visibility: block.visibility ?? "private",
      payload: block.payload,
      deletedAtHlc: block.deletedAtHlc ?? null,
      revision: this.upserts,
    };
    this.blocks.set(this.key(orgId, userId, block.id), stored);
    return { id: block.id, ...stored, revision: String(stored.revision) };
  }

  async wasNoteOperationApplied(orgId: string, userId: string, key: string): Promise<boolean> {
    return this.applied.has(`${orgId}/${userId}/${key}`);
  }
  async recordNoteOperationApplied(orgId: string, userId: string, key: string): Promise<void> {
    this.applied.add(`${orgId}/${userId}/${key}`);
  }

  async replaceNoteRefs(orgId: string, userId: string, blockId: string, refs: Array<{ targetKey: string }>): Promise<void> {
    this.refs.set(this.key(orgId, userId, blockId), refs.map((r) => ({ targetKey: r.targetKey })));
  }
  async upsertNoteIndex(orgId: string, userId: string, blockId: string, entry: { contentText: string; refKeys: readonly string[] }): Promise<void> {
    this.index.set(this.key(orgId, userId, blockId), { contentText: entry.contentText, refKeys: [...entry.refKeys] });
  }
  async deleteNoteIndexEntry(orgId: string, userId: string, blockId: string): Promise<void> {
    this.index.delete(this.key(orgId, userId, blockId));
  }
  async clearNoteDerived(orgId: string, userId: string): Promise<void> {
    for (const map of [this.refs, this.index, this.pageMeta, this.rowValues]) {
      for (const k of [...map.keys()]) if (k.startsWith(`${orgId}/${userId}/`)) map.delete(k);
    }
  }

  // ADR-029 Part E (migration 053) — the two derived projections. Held here for
  // the same reason `index` is: they are written by the same re-derive call, so
  // a fake that omitted them would make the push path throw rather than test it.
  pageMeta = new Map<string, Record<string, unknown>>();
  rowValues = new Map<string, Array<Record<string, unknown>>>();

  async upsertNotePageMeta(orgId: string, userId: string, meta: { blockId: string }): Promise<void> {
    this.pageMeta.set(this.key(orgId, userId, meta.blockId), meta as Record<string, unknown>);
  }
  async deleteNotePageMeta(orgId: string, userId: string, blockId: string): Promise<void> {
    this.pageMeta.delete(this.key(orgId, userId, blockId));
  }
  async listNotePageMeta(
    orgId: string,
    userId: string,
    opts: { kinds?: readonly string[]; favouritesOnly?: boolean } = {},
  ): Promise<unknown[]> {
    return [...this.pageMeta.entries()]
      .filter(([k]) => k.startsWith(`${orgId}/${userId}/`))
      .map(([, meta]) => meta)
      .filter((meta) => (!opts.kinds || opts.kinds.includes(String(meta.kind))))
      .filter((meta) => (!opts.favouritesOnly || meta.favourite === true));
  }
  async getNotePageMeta(orgId: string, userId: string, blockId: string): Promise<unknown> {
    return this.pageMeta.get(this.key(orgId, userId, blockId)) ?? null;
  }
  async replaceNoteRowValues(
    orgId: string, userId: string, blockId: string, _parentId: string | null,
    values: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    this.rowValues.set(this.key(orgId, userId, blockId), [...values]);
  }
  async listNoteChildBlocks(orgId: string, userId: string, parentId: string): Promise<unknown[]> {
    return (await this.listAllNoteBlocks(orgId, userId))
      .filter((row) => (row as { parentId: string | null }).parentId === parentId);
  }
  async listNoteDatabaseRows(orgId: string, userId: string, databaseId: string): Promise<unknown[]> {
    return this.listNoteChildBlocks(orgId, userId, databaseId);
  }
  async countNoteDatabaseRows(orgId: string, userId: string, databaseId: string): Promise<number> {
    return (await this.listNoteChildBlocks(orgId, userId, databaseId)).length;
  }

  async readNoteBlockLease(orgId: string, userId: string, blockId: string): Promise<unknown> {
    return { lease: this.leases.get(this.key(orgId, userId, blockId)) ?? null, dbNowMs: this.nowMs };
  }
  async upsertNoteBlockLease(orgId: string, userId: string, lease: { blockId: string; deviceId: string; holder: string | null; epoch: number; expiresAtMs: number }): Promise<void> {
    this.leases.set(this.key(orgId, userId, lease.blockId), lease);
  }
  async sweepNoteBlockLeases(): Promise<number> { return 0; }
}

const fake = new FakeNotesStore();
vi.mock("../memory/engine.js", () => ({ memoryEngine: { get store() { return fake; } } }));

const notes = await import("../memory/notes/backend.js");

const ORG = "org-a";
const USER = "user-1";
const at = (physical: number, deviceId: string, logical = 0): Hlc => ({ physical, logical, deviceId });

function blockOf(id: string): NoteBlock {
  return fake.blocks.get(`${ORG}/${USER}/${id}`)!.payload as unknown as NoteBlock;
}

async function push(op: {
  key: string; id: string; kind?: "create" | "update" | "delete"; at: Hlc; payload: Record<string, unknown>;
}) {
  return notes.pushOperations(ORG, USER, [{
    idempotencyKey: op.key, itemId: op.id, kind: op.kind ?? "update", at: op.at, payload: op.payload,
  }]);
}

/** The state a device would already have synced before the case under test. */
async function seed(id: string, text: string, stamp: Hlc): Promise<void> {
  await push({ key: `${id}:seed`, id, kind: "create", at: stamp, payload: { text, kind: "paragraph", rank: "m" } });
}

describe("notes push — the server merges, it does not accept", () => {
  beforeEach(() => {
    fake.blocks.clear(); fake.refs.clear(); fake.index.clear();
    fake.applied.clear(); fake.leases.clear();
    fake.upserts = 0; fake.nowMs = 1_000_000;
  });

  it("a client that has been offline cannot overwrite newer server text by pushing last", async () => {
    await seed("blk_1", "the version everyone else has", at(2_000, "device-b"));

    const outcome = await push({
      key: "blk_1:stale", id: "blk_1", at: at(1_000, "device-a"),
      payload: { text: "what my laptop had before it slept" },
    });

    expect(outcome.accepted).toEqual(["blk_1:stale"]);
    expect(blockOf("blk_1").text.value).toBe("the version everyone else has");
  });

  it("two devices writing one paragraph at once keep BOTH versions rather than one silently losing", async () => {
    await seed("blk_1", "written on the desktop", at(3_000, "device-a"));

    await push({
      key: "blk_1:concurrent", id: "blk_1", at: at(3_000, "device-b"),
      payload: { text: "written on the phone" },
    });

    const merged = blockOf("blk_1");
    expect(merged.conflicts?.text).toBeTruthy();
    expect([merged.conflicts!.text!.ours, merged.conflicts!.text!.theirs].sort())
      .toEqual(["written on the desktop", "written on the phone"]);
  });

  it("an edit made under a live lease lands directly, so no conflict marker appears where nobody was competing", async () => {
    await seed("blk_1", "first half of the sentence", at(3_000, "device-a"));
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a", holder: "the desktop" });

    await push({
      key: "blk_1:leased", id: "blk_1", at: at(4_000, "device-a"),
      payload: { text: "first half of the sentence, and the second", leaseEpoch: 1 },
    });

    const block = blockOf("blk_1");
    expect(block.text.value).toBe("first half of the sentence, and the second");
    expect(block.conflicts).toBeUndefined();
  });

  it("a redelivered push is a no-op rather than a second apply", async () => {
    await seed("blk_1", "once", at(1_000, "device-a"));
    const before = fake.upserts;

    const first = await push({ key: "blk_1:dup", id: "blk_1", at: at(2_000, "device-a"), payload: { text: "twice" } });
    const second = await push({ key: "blk_1:dup", id: "blk_1", at: at(2_000, "device-a"), payload: { text: "twice" } });

    expect(first.accepted).toEqual(["blk_1:dup"]);
    // Reported accepted, because from the client's side it DID land.
    expect(second.accepted).toEqual(["blk_1:dup"]);
    expect(fake.upserts).toBe(before + 1);
  });

  it("a delete is a tombstone, so an edit from a device that had not seen it brings the block back marked", async () => {
    await seed("blk_1", "still needed", at(1_000, "device-a"));
    await push({ key: "blk_1:del", id: "blk_1", kind: "delete", at: at(2_000, "device-a"), payload: {} });
    expect(blockOf("blk_1").deletedAt).toBeTruthy();

    await push({ key: "blk_1:late", id: "blk_1", at: at(3_000, "device-b"), payload: { text: "actually, still needed" } });

    const block = blockOf("blk_1");
    expect(block.deletedAt).toBeUndefined();
    expect(block.conflicts?.deleted).toBeTruthy();
  });

  it("an edit that changes only the text leaves a move made on another device standing", async () => {
    await seed("blk_1", "a line", at(1_000, "device-a"));
    await push({ key: "blk_1:move", id: "blk_1", at: at(2_000, "device-b"), payload: { parentId: "blk_page", rank: "z" } });

    await push({ key: "blk_1:type", id: "blk_1", at: at(3_000, "device-a"), payload: { text: "a longer line" } });

    const block = blockOf("blk_1");
    expect(block.text.value).toBe("a longer line");
    expect(block.parentId.value).toBe("blk_page");
  });

  it("syncing an edit to a shared block does not quietly un-share it", async () => {
    await seed("blk_1", "the team's onboarding notes", at(1_000, "device-a"));
    fake.blocks.get(`${ORG}/${USER}/blk_1`)!.visibility = "org";

    await push({ key: "blk_1:edit", id: "blk_1", at: at(2_000, "device-a"), payload: { text: "the team's onboarding notes, updated" } });

    // Visibility is not part of the synced payload, so an upsert that did not
    // carry the stored value forward would reset every shared note to private
    // on the next keystroke — and nothing would report an error.
    expect(fake.blocks.get(`${ORG}/${USER}/blk_1`)!.visibility).toBe("org");
  });

  it("a reference removed from a block stops being one of that target's backlinks", async () => {
    await seed("blk_1", "see brainrouter://planner/item/itm_4f2a", at(1_000, "device-a"));
    expect(fake.refs.get(`${ORG}/${USER}/blk_1`)).toEqual([{ targetKey: "brainrouter://planner/item/itm_4f2a" }]);

    await push({ key: "blk_1:unlink", id: "blk_1", at: at(2_000, "device-a"), payload: { text: "never mind" } });

    expect(fake.refs.get(`${ORG}/${USER}/blk_1`)).toEqual([]);
    expect(fake.index.get(`${ORG}/${USER}/blk_1`)?.refKeys).toEqual([]);
  });

  it("a deleted block leaves the search index, so it cannot come back as a result", async () => {
    await seed("blk_1", "a searchable sentence", at(1_000, "device-a"));
    expect(fake.index.has(`${ORG}/${USER}/blk_1`)).toBe(true);

    await push({ key: "blk_1:del", id: "blk_1", kind: "delete", at: at(2_000, "device-a"), payload: {} });

    expect(fake.index.has(`${ORG}/${USER}/blk_1`)).toBe(false);
  });

  it("one malformed operation is rejected on its own rather than stranding the rest of the batch", async () => {
    const outcome = await notes.pushOperations(ORG, USER, [
      { idempotencyKey: "bad", itemId: "blk_1", kind: "update", at: undefined as never, payload: { text: "x" } },
      { idempotencyKey: "good", itemId: "blk_2", kind: "create", at: at(1_000, "device-a"), payload: { text: "y", rank: "m" } },
    ]);

    expect(outcome.accepted).toEqual(["good"]);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]!.reason).toMatch(/clock/i);
    expect(blockOf("blk_2").text.value).toBe("y");
  });

  it("a block larger than the cap is refused with the limit named, so the client can act on it", async () => {
    const outcome = await push({
      key: "blk_1:huge", id: "blk_1", kind: "create", at: at(1_000, "device-a"),
      payload: { text: "x".repeat(notes.MAX_BLOCK_TEXT + 1) },
    });
    expect(outcome.accepted).toEqual([]);
    expect(outcome.rejected[0]!.reason).toContain(String(notes.MAX_BLOCK_TEXT));
  });
});

/**
 * ADR-029 B2/Q1 — the fencing epoch, tested as a fence rather than as a field.
 *
 * Every case below uses DIFFERENT physical stamps on the two sides, and asserts
 * the surviving VALUE. Both halves are deliberate. With equal stamps `mergeText`
 * takes its concurrent branch and produces a marker on its own, so the test
 * passes with the epoch check deleted and proves nothing about the epoch; and
 * "a conflict exists" is satisfied by a merge that also let the stale text win,
 * which is the defect. A stale write is the LATER write here — that is what
 * makes it dangerous, and what last-writer-wins gets wrong on its own.
 */
describe("notes push — the fencing epoch decides what a write may take", () => {
  const reset = (): void => {
    fake.blocks.clear(); fake.refs.clear(); fake.index.clear();
    fake.applied.clear(); fake.leases.clear();
    fake.upserts = 0; fake.nowMs = 1_000_000;
  };
  beforeEach(reset);

  /**
   * Migration 048's defect verbatim, one layer up: the SAME device, a reissued
   * token. device-a slept mid-edit, its lease lapsed, device-b edited and let
   * go, device-a woke and started typing again — so it holds a live lease with
   * a new epoch while a write authored under the old one is still queued.
   *
   * The device matches and the lease is live, so the epoch is the only thing
   * that can tell the two writes apart.
   */
  async function replayTheSleepingDevice(claimedEpoch?: number): Promise<void> {
    await seed("blk_1", "the sentence device-b wrote while device-a slept", at(5_000, "device-b"));
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a" });   // epoch 1
    fake.nowMs += 60_000;
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b" });   // epoch 2
    fake.nowMs += 60_000;
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a" });   // epoch 3, live

    await push({
      key: "blk_1:woke", id: "blk_1", at: at(9_000, "device-a"),
      payload: {
        text: "the half-finished sentence device-a was holding",
        ...(claimedEpoch === undefined ? {} : { leaseEpoch: claimedEpoch }),
      },
    });
  }

  it("a write authored under a reissued epoch cannot take the text, however late its clock", async () => {
    await replayTheSleepingDevice(1);

    const block = blockOf("blk_1");
    expect(block.text.value).toBe("the sentence device-b wrote while device-a slept");
    expect(block.conflicts?.text?.reason).toBe("fenced_stale_epoch");
    // Refused, not dropped: the sentence is still there for a person to pick.
    expect(block.conflicts?.text?.theirs).toBe("the half-finished sentence device-a was holding");
  });

  it("the SAME write under the current epoch does take the text — so the epoch is not inert", async () => {
    await replayTheSleepingDevice(3);

    const block = blockOf("blk_1");
    expect(block.text.value).toBe("the half-finished sentence device-a was holding");
    expect(block.conflicts).toBeUndefined();
  });

  it("an epoch that was never issued is fenced exactly like a stale one", async () => {
    await replayTheSleepingDevice(99);

    expect(blockOf("blk_1").text.value).toBe("the sentence device-b wrote while device-a slept");
    expect(blockOf("blk_1").conflicts?.text?.reason).toBe("fenced_stale_epoch");
  });

  it("omitting the epoch on a block this device holds is the soft-lock case, and lands", async () => {
    // B2 chose SOFT locking, so this is the designed answer rather than a gap:
    // no epoch means "not claiming ownership", and ownership buys nothing but
    // the absence of a penalty. Where omitting it is NOT free is when someone
    // else holds the block — the next test.
    await replayTheSleepingDevice(undefined);

    expect(blockOf("blk_1").text.value).toBe("the half-finished sentence device-a was holding");
  });

  it("a device that reclaimed the block is not overwritten by the previous holder", async () => {
    // The other half of the reissue: device-b took over and still holds it. The
    // epoch is tied to a peer, not just to a number, so device-a is fenced by
    // the device as well as by the count — and it is fenced as a STALE claim
    // rather than blocked, because its sentence already exists and a claim that
    // arrives with an epoch is never refused outright.
    await seed("blk_1", "typed on the phone while the laptop was closed", at(5_000, "device-b"));
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a" });
    fake.nowMs += 60_000;
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b", holder: "the phone" });

    await push({
      key: "blk_1:fenced", id: "blk_1", at: at(9_000, "device-a"),
      payload: { text: "the sentence device-a was half way through", leaseEpoch: 1 },
    });

    const block = blockOf("blk_1");
    expect(block.text.value).toBe("typed on the phone while the laptop was closed");
    expect(block.conflicts?.text?.reason).toBe("fenced_stale_epoch");
  });

  it("a write naming no epoch cannot overwrite a block another device is holding", async () => {
    await seed("blk_1", "the paragraph the phone is in the middle of", at(5_000, "device-b"));
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b", holder: "the phone" });

    await push({
      key: "blk_1:intruder", id: "blk_1", at: at(9_000, "device-a"),
      payload: { text: "what the laptop had queued" },
    });

    const block = blockOf("blk_1");
    expect(block.text.value).toBe("the paragraph the phone is in the middle of");
    expect(block.conflicts?.text?.reason).toBe("fenced_blocked");
    expect(block.conflicts?.text?.theirs).toBe("what the laptop had queued");
  });

  it("holding the lock does not buy the right to overwrite text this write never saw", async () => {
    // D11 head on: a client that is behind must not win by pushing last, and a
    // valid lease does not make it less behind. Taking a leaseholder's payload
    // wholesale — the shape this had — inverted exactly that.
    await seed("blk_1", "the paragraph as it now stands", at(9_000, "device-b"));
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a" });

    await push({
      key: "blk_1:behind", id: "blk_1", at: at(3_000, "device-a"),
      payload: { text: "what this device had an hour ago", leaseEpoch: 1 },
    });

    expect(blockOf("blk_1").text.value).toBe("the paragraph as it now stands");
  });

  it("a fenced write still moves the block, because a lost placement is not a lost sentence", async () => {
    await seed("blk_1", "a line", at(5_000, "device-b"));
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b", holder: "the phone" });

    await push({
      key: "blk_1:moved", id: "blk_1", at: at(9_000, "device-a"),
      payload: { parentId: "blk_page", rank: "z" },
    });

    const block = blockOf("blk_1");
    expect(block.parentId.value).toBe("blk_page");
    // Placement is last-writer-wins even when fenced: it can be dragged back,
    // and marking it would put a conflict banner on a drag.
    expect(block.conflicts).toBeUndefined();
  });

  it("a fenced operation is still ACCEPTED, so the client stops retrying it", async () => {
    // A rejection would sit in the outbox and be pushed again forever. The write
    // did land — beside the text it did not see rather than on top of it.
    await seed("blk_1", "the version on the server", at(5_000, "device-b"));
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b" });

    const outcome = await push({
      key: "blk_1:fenced-accept", id: "blk_1", at: at(9_000, "device-a"),
      payload: { text: "the version that was fenced" },
    });

    expect(outcome.accepted).toEqual(["blk_1:fenced-accept"]);
    expect(outcome.rejected).toEqual([]);
  });
});

describe("notes derived tables — A2's cache rule", () => {
  beforeEach(() => {
    fake.blocks.clear(); fake.refs.clear(); fake.index.clear(); fake.applied.clear();
    fake.pageMeta.clear(); fake.rowValues.clear(); fake.upserts = 0;
  });

  it("rebuilding the index from content alone produces the same answer the incremental writes did", async () => {
    // A2: if a rebuild changes the answer, the cache was the source of truth.
    // The incremental path exists precisely so this can diverge — an index with
    // no incremental updates would satisfy the rule vacuously.
    await seed("blk_1", "see brainrouter://planner/item/itm_4f2a and brainrouter://track/work-item/BR-114", at(1_000, "device-a"));
    await seed("blk_2", "plain prose, no links", at(1_100, "device-a"));
    await seed("blk_3", "brainrouter://code/file/src/x.ts#L59 twice: brainrouter://code/file/src/x.ts#L12", at(1_200, "device-a"));
    await push({ key: "blk_1:edit", id: "blk_1", at: at(2_000, "device-a"), payload: { text: "only brainrouter://track/work-item/BR-114 now" } });
    await push({ key: "blk_2:del", id: "blk_2", kind: "delete", at: at(2_100, "device-a"), payload: {} });
    // ADR-029 Part E — the same claim has to hold for the state Part E added, or
    // migration 053's tables are a second source of truth wearing a cache's name.
    await push({
      key: "page:create", id: "page", kind: "create", at: at(2_200, "device-a"),
      payload: { kind: "page", text: "Runbook", rank: "m", icon: "📕", cover: "https://x.test/c.png", favourite: true },
    });
    await push({
      key: "row:create", id: "row", kind: "create", at: at(2_300, "device-a"),
      payload: { kind: "page", text: "Acme", parentId: "db", rank: "m", props: { stage: "won", size: 12 } },
    });

    const incrementalRefs = JSON.stringify([...fake.refs.entries()].sort());
    const incrementalIndex = JSON.stringify([...fake.index.entries()].sort());
    const incrementalPages = JSON.stringify([...fake.pageMeta.entries()].sort());
    const incrementalRows = JSON.stringify([...fake.rowValues.entries()].sort());

    await notes.rebuildDerived(ORG, USER);

    expect(JSON.stringify([...fake.refs.entries()].sort())).toBe(incrementalRefs);
    expect(JSON.stringify([...fake.index.entries()].sort())).toBe(incrementalIndex);
    expect(JSON.stringify([...fake.pageMeta.entries()].sort())).toBe(incrementalPages);
    expect(JSON.stringify([...fake.rowValues.entries()].sort())).toBe(incrementalRows);
  });

  it("the indexed text has the URIs lifted out, so a machine id never reads as a word someone wrote", async () => {
    await seed("blk_1", "ship the parser brainrouter://planner/item/itm_4f2a", at(1_000, "device-a"));

    const entry = fake.index.get(`${ORG}/${USER}/blk_1`)!;
    expect(entry.contentText).toBe("ship the parser");
    expect(entry.refKeys).toEqual(["brainrouter://planner/item/itm_4f2a"]);
  });
});

describe("notes leases — B2's prevention half", () => {
  beforeEach(() => {
    fake.blocks.clear(); fake.leases.clear(); fake.applied.clear(); fake.nowMs = 1_000_000;
  });

  it("a second device is told WHO holds the block rather than being refused without a reason", async () => {
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a", holder: "the desktop" });

    const outcome = await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("held_by_another");
    expect(outcome.detail).toContain("the desktop");
  });

  it("taking over an expired lease issues a NEWER epoch, which is what fences the previous holder", async () => {
    const first = await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a" });
    expect(first.ok && first.lease.epoch).toBe(1);

    fake.nowMs += 60_000;
    const second = await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b" });

    expect(second.ok && second.lease.epoch).toBe(2);
  });

  it("releasing ends the term but keeps the epoch, because a fencing token that resets is not one", async () => {
    const held = await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a" });
    expect(held.ok).toBe(true);

    await notes.releaseLease(ORG, USER, "blk_1", { deviceId: "device-a", epoch: 1 });
    const next = await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b" });

    expect(next.ok && next.lease.epoch).toBe(2);
  });
});

/**
 * ADR-029 E3 — the database fields on the same push path.
 *
 * A row is a page, so there is no second endpoint to test: these are ordinary
 * operations against ordinary blocks. What is worth pinning is that they survive
 * the trip at all — a property value the server silently dropped would look
 * exactly like a cell someone forgot to fill in — and that the per-key rule
 * holds on this side too, since the client and the server merge with the same
 * function but build the incoming block separately.
 */
describe("notes push — E3 property values", () => {
  beforeEach(() => {
    fake.blocks.clear(); fake.refs.clear(); fake.index.clear();
    fake.applied.clear(); fake.leases.clear();
    fake.upserts = 0; fake.nowMs = 1_000_000;
  });

  it("a pushed property value survives the round trip", async () => {
    await push({
      key: "row:create", id: "row", kind: "create", at: at(1_000, "device-a"),
      payload: { kind: "page", text: "Acme", parentId: "db", rank: "m", props: { stage: "won" } },
    });

    expect(blockOf("row").props?.stage?.value).toBe("won");
  });

  it("an operation that sets ONE cell does not re-stamp the others", async () => {
    await push({
      key: "row:create", id: "row", kind: "create", at: at(1_000, "device-a"),
      payload: { kind: "page", text: "Acme", rank: "m", props: { stage: "open", owner: ["sam"] } },
    });
    await push({
      key: "row:stage", id: "row", at: at(2_000, "device-a"), payload: { props: { stage: "won" } },
    });

    const row = blockOf("row");
    expect(row.props?.stage?.value).toBe("won");
    expect(row.props?.owner?.value).toEqual(["sam"]);
    // The untouched cell keeps its ORIGINAL stamp — re-stamping it would make a
    // write about one property also win every other one it was holding stale.
    expect(row.props?.owner?.at.physical).toBe(1_000);
  });

  it("a relation cell is indexed as a reference, exactly as a link typed in prose is", async () => {
    await push({
      key: "row:create", id: "row", kind: "create", at: at(1_000, "device-a"),
      payload: {
        kind: "page", text: "Ship the parser", rank: "m",
        props: { pr: ["brainrouter://planner/item/itm_4f2a"] },
      },
    });

    expect(fake.refs.get(`${ORG}/${USER}/row`)).toEqual([
      { targetKey: "brainrouter://planner/item/itm_4f2a" },
    ]);
    // The searchable TEXT stays the prose, so this and the client's `searchNotes`
    // cannot disagree about what a text match is.
    expect(fake.index.get(`${ORG}/${USER}/row`)?.contentText).toBe("Ship the parser");
  });

  it("a database's schema and views arrive as stamped fields on the block", async () => {
    await push({
      key: "db:create", id: "db", kind: "create", at: at(1_000, "device-a"),
      payload: {
        kind: "database", text: "Reading list", rank: "m",
        schema: [{ id: "title", name: "Name", type: "title" }],
        views: [{ id: "table", name: "Table", kind: "table", visible: ["title"] }],
      },
    });

    const database = blockOf("db");
    expect(database.schema?.value.length).toBe(1);
    expect(database.views?.value[0]?.kind).toBe("table");
  });

  it("a push whose property map is oversized is refused with a sentence, not applied", async () => {
    const outcome = await push({
      key: "row:huge", id: "row", kind: "create", at: at(1_000, "device-a"),
      payload: { kind: "page", text: "x", rank: "m", props: { note: "x".repeat(5_000) } },
    });

    expect(outcome.accepted).toEqual([]);
    expect(outcome.rejected[0]?.reason).toContain("at most");
  });
});

/**
 * ADR-029 Part E — the projections migration 053 added, on the SAME push path.
 *
 * The property under test is that there is no second path: a page's icon and a
 * row's cells arrive as fields of an ordinary block operation, are merged by the
 * ordinary merge, and land in the queryable tables because the ordinary
 * re-derive call put them there. Each case below is a way that could quietly
 * stop being true — a projection that only grows, one that never retracts, one
 * that a second endpoint writes — and none of them errors at the time.
 */
describe("notes push — Part E's projections travel with the block", () => {
  beforeEach(() => {
    fake.blocks.clear(); fake.refs.clear(); fake.index.clear(); fake.applied.clear();
    fake.pageMeta.clear(); fake.rowValues.clear(); fake.leases.clear();
    fake.upserts = 0; fake.nowMs = 1_000_000;
  });

  it("a page's icon, cover and title reach the projection a sidebar reads", async () => {
    await push({
      key: "page:create", id: "page", kind: "create", at: at(1_000, "device-a"),
      payload: { kind: "page", text: "Runbook", rank: "m", icon: "📕", cover: "https://x.test/c.png" },
    });

    const meta = fake.pageMeta.get(`${ORG}/${USER}/page`)!;
    expect(meta.title).toBe("Runbook");
    expect(meta.icon).toBe("📕");
    expect(meta.cover).toBe("https://x.test/c.png");
  });

  it("a paragraph nobody pinned is NOT in the projection, so the sidebar is pages and not prose", async () => {
    await seed("blk_1", "just a sentence", at(1_000, "device-a"));

    expect(fake.pageMeta.has(`${ORG}/${USER}/blk_1`)).toBe(false);
  });

  it("pinning a paragraph puts it in the projection and un-pinning takes it back out", async () => {
    await seed("blk_1", "the one line I keep needing", at(1_000, "device-a"));
    await push({ key: "blk_1:pin", id: "blk_1", at: at(2_000, "device-a"), payload: { favourite: true } });
    expect(fake.pageMeta.get(`${ORG}/${USER}/blk_1`)?.favourite).toBe(true);

    await push({ key: "blk_1:unpin", id: "blk_1", at: at(3_000, "device-a"), payload: { favourite: false } });

    // A projection that only grows is how a sidebar starts listing things that
    // are not there — the same defect an add-only reference index has.
    expect(fake.pageMeta.has(`${ORG}/${USER}/blk_1`)).toBe(false);
  });

  it("a deleted page leaves the sidebar, because a tombstone is not a navigation entry", async () => {
    await push({
      key: "page:create", id: "page", kind: "create", at: at(1_000, "device-a"),
      payload: { kind: "page", text: "Runbook", rank: "m" },
    });
    await push({ key: "page:del", id: "page", kind: "delete", at: at(2_000, "device-a"), payload: {} });

    expect(fake.pageMeta.has(`${ORG}/${USER}/page`)).toBe(false);
  });

  it("a database's schema and views are in the projection, so listing them costs one query", async () => {
    await push({
      key: "db:create", id: "db", kind: "create", at: at(1_000, "device-a"),
      payload: {
        kind: "database", text: "Reading list", rank: "m",
        schema: [{ id: "title", name: "Name", type: "title" }],
        views: [{ id: "table", name: "Table", kind: "table", visible: ["title"] }],
      },
    });

    const meta = fake.pageMeta.get(`${ORG}/${USER}/db`)!;
    expect((meta.schema as unknown[]).length).toBe(1);
    expect((meta.views as Array<{ kind: string }>)[0]?.kind).toBe("table");
  });

  it("a cell is projected by the shape of its value, so a filter never needs the schema to be current", async () => {
    await push({
      key: "row:create", id: "row", kind: "create", at: at(1_000, "device-a"),
      payload: {
        kind: "page", text: "Acme", parentId: "db", rank: "m",
        props: { stage: "won", size: 12, shipped: true, due: "2026-08-07", owner: ["sam", "ali"] },
      },
    });

    const cells = new Map(
      (fake.rowValues.get(`${ORG}/${USER}/row`) ?? []).map((cell) => [cell.propertyId as string, cell]),
    );
    expect(cells.get("size")?.number).toBe(12);
    expect(cells.get("shipped")?.bool).toBe(true);
    // The DAY, never an instant: converting to one has to pick a timezone, and
    // two people would then see the same due date fall on different days.
    expect(cells.get("due")?.date).toBe("2026-08-07");
    // A list has no honest scalar column, so it gets joined text and the json.
    expect(cells.get("owner")?.text).toBe("sam, ali");
    expect(cells.get("owner")?.value).toEqual(["sam", "ali"]);
  });

  it("clearing a cell keeps the row with every projection empty, because absent and empty are different answers", async () => {
    await push({
      key: "row:create", id: "row", kind: "create", at: at(1_000, "device-a"),
      payload: { kind: "page", text: "Acme", parentId: "db", rank: "m", props: { stage: "won" } },
    });
    await push({ key: "row:clear", id: "row", at: at(2_000, "device-a"), payload: { props: { stage: null } } });

    const cells = fake.rowValues.get(`${ORG}/${USER}/row`) ?? [];
    expect(cells.length).toBe(1);
    expect(cells[0]?.value).toBe(null);
    expect(cells[0]?.text).toBe(null);
  });
});
