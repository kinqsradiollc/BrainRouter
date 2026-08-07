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
    for (const map of [this.refs, this.index]) {
      for (const k of [...map.keys()]) if (k.startsWith(`${orgId}/${userId}/`)) map.delete(k);
    }
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
      key: "blk_1:leased", id: "blk_1", at: at(3_000, "device-a"),
      payload: { text: "first half of the sentence, and the second", leaseEpoch: 1 },
    });

    const block = blockOf("blk_1");
    expect(block.text.value).toBe("first half of the sentence, and the second");
    expect(block.conflicts).toBeUndefined();
  });

  it("a device that slept through a lease reissue cannot overwrite the edit made while it was gone", async () => {
    await seed("blk_1", "typed while the laptop was closed", at(3_000, "device-b"));
    // device-a held epoch 1; the lease lapsed and device-b took it, minting 2.
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a" });
    fake.nowMs += 60_000;
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b" });

    await push({
      key: "blk_1:fenced", id: "blk_1", at: at(3_000, "device-a"),
      payload: { text: "the sentence device-a was half way through", leaseEpoch: 1 },
    });

    const block = blockOf("blk_1");
    // Nothing is discarded for holding a stale epoch — it merges, which is D4's
    // floor — but it does not get an owner's direct write either.
    expect(block.conflicts?.text).toBeTruthy();
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

describe("notes derived tables — A2's cache rule", () => {
  beforeEach(() => {
    fake.blocks.clear(); fake.refs.clear(); fake.index.clear(); fake.applied.clear(); fake.upserts = 0;
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

    const incrementalRefs = JSON.stringify([...fake.refs.entries()].sort());
    const incrementalIndex = JSON.stringify([...fake.index.entries()].sort());

    await notes.rebuildDerived(ORG, USER);

    expect(JSON.stringify([...fake.refs.entries()].sort())).toBe(incrementalRefs);
    expect(JSON.stringify([...fake.index.entries()].sort())).toBe(incrementalIndex);
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
