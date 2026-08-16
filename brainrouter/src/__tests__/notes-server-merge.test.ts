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
import type { NotesMutationRequest } from "@kinqs/brainrouter-core/notes/editing";

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
  applied = new Map<string, {
    blockId: string;
    fingerprint: string | null;
    response: Record<string, unknown> | null;
  }>();
  leases = new Map<string, { blockId: string; deviceId: string; holder: string | null; epoch: number; expiresAtMs: number }>();
  hostClocks = new Map<string, { physical: number; logical: number }>();
  nowMs = 1_000_000;
  upserts = 0;
  pullLimit = 1_000;
  failUpsertAt: number | null = null;
  onGetReceipt: (() => Promise<void>) | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  private key(orgId: string, userId: string, id: string): string { return `${orgId}/${userId}/${id}`; }

  async withNoteMutation<T>(
    _orgId: string,
    _userId: string,
    fn: (queries: FakeNotesStore) => Promise<T>,
  ): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = {
      blocks: structuredClone(this.blocks),
      refs: structuredClone(this.refs),
      index: structuredClone(this.index),
      applied: structuredClone(this.applied),
      leases: structuredClone(this.leases),
      hostClocks: structuredClone(this.hostClocks),
      pageMeta: structuredClone(this.pageMeta),
      rowValues: structuredClone(this.rowValues),
      upserts: this.upserts,
    };
    try {
      return await fn(this);
    } catch (error) {
      this.blocks = snapshot.blocks;
      this.refs = snapshot.refs;
      this.index = snapshot.index;
      this.applied = snapshot.applied;
      this.leases = snapshot.leases;
      this.hostClocks = snapshot.hostClocks;
      this.pageMeta = snapshot.pageMeta;
      this.rowValues = snapshot.rowValues;
      this.upserts = snapshot.upserts;
      throw error;
    } finally {
      release();
    }
  }

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

  async listNoteBlocksSince(orgId: string, userId: string, since?: string): Promise<unknown[]> {
    const cursor = since && /^\d+$/.test(since) ? Number(since) : 0;
    return (await this.listAllNoteBlocks(orgId, userId))
      .filter((row) => Number((row as { revision: string }).revision) > cursor)
      .sort((a, b) => Number((a as { revision: string }).revision) - Number((b as { revision: string }).revision))
      .slice(0, this.pullLimit);
  }

  async latestNoteRevision(orgId: string, userId: string): Promise<string> {
    const rows = await this.listAllNoteBlocks(orgId, userId);
    return String(rows.reduce<number>(
      (latest, row) => Math.max(latest, Number((row as { revision: string }).revision)),
      0,
    ));
  }

  async upsertNoteBlock(orgId: string, userId: string, block: {
    id: string; parentId: string | null; kind: string; visibility?: string;
    payload: Record<string, unknown>; deletedAtHlc?: string | null;
  }): Promise<unknown> {
    this.upserts += 1;
    if (this.failUpsertAt === this.upserts) throw new Error("injected note upsert failure");
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
  async getNoteOperationReceipt(orgId: string, userId: string, key: string) {
    const hook = this.onGetReceipt;
    if (hook) {
      this.onGetReceipt = null;
      await hook();
    }
    return this.applied.get(`${orgId}/${userId}/${key}`) ?? null;
  }
  async recordNoteOperationApplied(
    orgId: string,
    userId: string,
    key: string,
    blockId: string,
    fingerprint?: string,
    response?: Record<string, unknown>,
  ): Promise<void> {
    this.applied.set(`${orgId}/${userId}/${key}`, {
      blockId,
      fingerprint: fingerprint ?? null,
      response: response ? structuredClone(response) : null,
    });
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

  async observeNoteHostClock(orgId: string, userId: string, remote: Hlc): Promise<void> {
    const key = `${orgId}/${userId}`;
    const current = this.hostClocks.get(key);
    if (!current || remote.physical > current.physical
      || (remote.physical === current.physical && remote.logical > current.logical)) {
      this.hostClocks.set(key, { physical: remote.physical, logical: remote.logical });
    }
  }

  async nextNoteHostClock(
    orgId: string,
    userId: string,
    deviceId: string,
    wallClockMs: number,
    reserve: number,
  ): Promise<Hlc> {
    const key = `${orgId}/${userId}`;
    const current = this.hostClocks.get(key) ?? { physical: -1, logical: -1 };
    const physical = Math.max(current.physical, Math.max(0, Math.trunc(wallClockMs)));
    const logical = physical === current.physical ? current.logical + 1 : 0;
    this.hostClocks.set(key, {
      physical,
      logical: logical + Math.max(1, Math.trunc(reserve)) - 1,
    });
    return { physical, logical, deviceId };
  }
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
    fake.applied.clear(); fake.leases.clear(); fake.hostClocks.clear();
    fake.upserts = 0; fake.pullLimit = 1_000; fake.nowMs = 1_000_000;
    fake.failUpsertAt = null;
    fake.onGetReceipt = null;
  });

  it("a bounded pull cursor advances only through rows actually delivered", async () => {
    await seed("blk_1", "one", at(1_000, "device-a"));
    await seed("blk_2", "two", at(2_000, "device-a"));
    await seed("blk_3", "three", at(3_000, "device-a"));
    fake.pullLimit = 2;

    const first = await notes.pullChanges(ORG, USER);
    expect(first.blocks.map((block) => block.id)).toEqual(["blk_1", "blk_2"]);
    expect(first.cursor).toBe("2");

    const second = await notes.pullChanges(ORG, USER, first.cursor);
    expect(second.blocks.map((block) => block.id)).toEqual(["blk_3"]);
    expect(second.cursor).toBe("3");
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

  it("rejects an inherited legacy push envelope before inherited fields can name a victim", () => {
    const inherited = Object.create({
      idempotencyKey: "poisoned",
      itemId: "victim",
      kind: "delete",
      at: at(2_000, "device-a"),
      payload: {},
    });
    const parsed = notes.parseNotePushOperation(inherited);
    expect(parsed.ok).toBe(false);
  });

  it("one raw idempotency key cannot be reused for a different operation", async () => {
    await seed("blk_1", "first", at(1_000, "device-a"));
    const accepted = await push({
      key: "same-key", id: "blk_1", at: at(2_000, "device-a"), payload: { text: "second" },
    });
    const rejected = await push({
      key: "same-key", id: "blk_1", at: at(3_000, "device-a"), payload: { text: "different body" },
    });
    expect(accepted.accepted).toEqual(["same-key"]);
    expect(rejected.accepted).toEqual([]);
    expect(rejected.rejected[0]?.reason).toMatch(/different Notes operation/);
    expect(blockOf("blk_1").text.value).toBe("second");
  });

  it("serializes concurrent field writes so neither read-modify-write projection is lost", async () => {
    await seed("blk_1", "first", at(1_000, "device-a"));
    await Promise.all([
      push({ key: "concurrent-text", id: "blk_1", at: at(2_000, "device-a"), payload: { text: "second" } }),
      push({ key: "concurrent-check", id: "blk_1", at: at(3_000, "device-b"), payload: { checked: true } }),
    ]);
    expect(blockOf("blk_1").text.value).toBe("second");
    expect(blockOf("blk_1").checked?.value).toBe(true);
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
    fake.applied.clear(); fake.leases.clear(); fake.hostClocks.clear();
    fake.upserts = 0; fake.nowMs = 1_000_000;
    fake.failUpsertAt = null;
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
    fake.pageMeta.clear(); fake.rowValues.clear(); fake.hostClocks.clear(); fake.upserts = 0;
    fake.failUpsertAt = null;
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
    fake.blocks.clear(); fake.leases.clear(); fake.applied.clear(); fake.hostClocks.clear(); fake.nowMs = 1_000_000;
    fake.failUpsertAt = null;
  });

  it("a second device is told WHO holds the block rather than being refused without a reason", async () => {
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a", holder: "the desktop" });

    const outcome = await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("held_by_another");
    expect(outcome.detail).toContain("the desktop");
  });

  it("two simultaneous acquirers produce one lease winner and one attributed refusal", async () => {
    await seed("blk_1", "lease me", at(1_000, "seed"));
    const outcomes = await Promise.all([
      notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-a", holder: "desktop" }),
      notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b", holder: "browser" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const refused = outcomes.find((outcome) => !outcome.ok);
    expect(refused && !refused.ok && refused.reason).toBe("held_by_another");
    expect(fake.leases.get(`${ORG}/${USER}/blk_1`)?.epoch).toBe(1);
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
    fake.applied.clear(); fake.leases.clear(); fake.hostClocks.clear();
    fake.upserts = 0; fake.nowMs = 1_000_000;
    fake.failUpsertAt = null;
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
    fake.pageMeta.clear(); fake.rowValues.clear(); fake.leases.clear(); fake.hostClocks.clear();
    fake.upserts = 0; fake.nowMs = 1_000_000;
    fake.failUpsertAt = null;
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

describe("notes editor mutations — one remote gesture transport", () => {
  beforeEach(() => {
    fake.blocks.clear(); fake.refs.clear(); fake.index.clear();
    fake.applied.clear(); fake.leases.clear(); fake.hostClocks.clear();
    fake.pageMeta.clear(); fake.rowValues.clear();
    fake.upserts = 0; fake.nowMs = 1_000_000;
    fake.failUpsertAt = null;
  });

  it("executes Core's split plan once and treats a redelivered request as a replay", async () => {
    await seed("blk_split", "one two", at(1_000, "device-a"));
    const request: NotesMutationRequest = {
      version: 1,
      requestId: "split-once",
      deviceId: "dashboard-tab",
      operation: { type: "gesture.split", blockId: "blk_split", caret: 3 },
    };

    const first = await notes.mutateNotes(ORG, USER, request, fake.nowMs);
    expect(first.ok).toBe(true);
    expect(first.ok && (first.result as { action: string }).action).toBe("split");
    expect(first.sync.accepted).toHaveLength(2);
    const idsAfterFirst = [...fake.blocks.keys()].sort();

    const retry = await notes.mutateNotes(ORG, USER, request, fake.nowMs + 1);
    expect(retry).toEqual(first);
    expect([...fake.blocks.keys()].sort()).toEqual(idsAfterFirst);
    expect(blockOf("blk_split").text.value).toBe("one");
  });

  it("rolls back every primitive, projection, clock and receipt when a later split write fails", async () => {
    await seed("blk_atomic", "one two", at(1_000, "device-a"));
    const request: NotesMutationRequest = {
      version: 1,
      requestId: "split-rollback",
      deviceId: "dashboard-tab",
      operation: { type: "gesture.split", blockId: "blk_atomic", caret: 3 },
    };
    const blocksBefore = [...fake.blocks.keys()];
    const receiptsBefore = fake.applied.size;
    fake.failUpsertAt = fake.upserts + 2;

    await expect(notes.mutateNotes(ORG, USER, request, fake.nowMs)).rejects
      .toThrow("injected note upsert failure");
    expect([...fake.blocks.keys()]).toEqual(blocksBefore);
    expect(blockOf("blk_atomic").text.value).toBe("one two");
    expect(fake.applied.size).toBe(receiptsBefore);

    fake.failUpsertAt = null;
    const retry = await notes.mutateNotes(ORG, USER, request, fake.nowMs + 1);
    expect(retry.ok).toBe(true);
    expect(blockOf("blk_atomic").text.value).toBe("one");
  });

  it("absorbs a future persisted stamp before allocating a hosted mutation clock", async () => {
    const future = at(9_000_000, "offline-device", 77);
    await seed("blk_future", "future copy", future);
    fake.hostClocks.clear(); // Simulate a restart/migration with pre-existing blocks.
    fake.nowMs = 1_000;
    const response = await notes.mutateNotes(ORG, USER, {
      version: 1,
      requestId: "future-hosted-update",
      deviceId: "dashboard-tab",
      operation: { type: "block.update", blockId: "blk_future", patch: { text: "hosted copy" } },
    }, fake.nowMs);
    expect(response.ok).toBe(true);
    expect(blockOf("blk_future").text.value).toBe("hosted copy");
    expect(blockOf("blk_future").text.at.physical).toBe(future.physical);
    expect(blockOf("blk_future").text.at.logical).toBeGreaterThan(future.logical);
  });

  it("returns the original response on replay and refuses the same request id with a different body", async () => {
    const firstRequest: NotesMutationRequest = {
      version: 1,
      requestId: "fingerprinted-request",
      deviceId: "dashboard-tab",
      operation: { type: "block.create", input: { blockId: "blk_first", text: "first" } },
    };
    const first = await notes.mutateNotes(ORG, USER, firstRequest, fake.nowMs);
    const replay = await notes.mutateNotes(ORG, USER, firstRequest, fake.nowMs + 1);
    expect(replay).toEqual(first);

    const collision = await notes.mutateNotes(ORG, USER, {
      ...firstRequest,
      operation: { type: "block.create", input: { blockId: "blk_second", text: "second" } },
    }, fake.nowMs + 2);
    expect(collision.ok).toBe(false);
    expect(!collision.ok && collision.error.code).toBe("idempotency_conflict");
    expect(fake.blocks.has(`${ORG}/${USER}/blk_second`)).toBe(false);
  });

  it("domain-separates a raw outbox key from a hosted mutation request id", async () => {
    await push({
      key: "shared-token", id: "blk_raw", kind: "create", at: at(1_000, "device-a"),
      payload: { text: "raw", rank: "m" },
    });
    const response = await notes.mutateNotes(ORG, USER, {
      version: 1,
      requestId: "shared-token",
      deviceId: "device-a",
      operation: { type: "block.create", input: { blockId: "blk_hosted", text: "hosted" } },
    }, fake.nowMs);
    expect(response.ok).toBe(true);
    expect(blockOf("blk_hosted").text.value).toBe("hosted");
  });

  it("fails closed if a nested mutation attempts to change tenant scope", async () => {
    const nested: NotesMutationRequest = {
      version: 1,
      requestId: "nested-other-scope",
      deviceId: "dashboard-tab",
      operation: { type: "block.create", input: { blockId: "blk_other", text: "other" } },
    };
    fake.onGetReceipt = () => notes.mutateNotes("org-other", USER, nested, fake.nowMs).then(() => undefined);
    await expect(notes.mutateNotes(ORG, USER, {
      ...nested,
      requestId: "outer-scope",
      operation: { type: "block.create", input: { blockId: "blk_outer", text: "outer" } },
    }, fake.nowMs)).rejects.toThrow(/cannot change its organization or user scope/);
    expect(fake.blocks.has(`${ORG}/${USER}/blk_outer`)).toBe(false);
    expect(fake.blocks.has(`org-other/${USER}/blk_other`)).toBe(false);
  });

  it("refuses a duplicate client id and a lease for a missing block", async () => {
    await seed("blk_existing", "keep me", at(1_000, "device-a"));
    const duplicate: NotesMutationRequest = {
      version: 1,
      requestId: "duplicate-id",
      deviceId: "dashboard-tab",
      operation: {
        type: "block.create",
        input: { blockId: "blk_existing", text: "overwrite me" },
      },
    };
    const duplicateResult = await notes.mutateNotes(ORG, USER, duplicate, fake.nowMs);
    expect(duplicateResult.ok).toBe(false);
    expect(!duplicateResult.ok && duplicateResult.error.code).toBe("refused");
    expect(blockOf("blk_existing").text.value).toBe("keep me");

    const missingLease: NotesMutationRequest = {
      version: 1,
      requestId: "missing-lease",
      deviceId: "dashboard-tab",
      operation: { type: "lease.acquire", blockId: "blk_missing" },
    };
    const leaseResult = await notes.mutateNotes(ORG, USER, missingLease, fake.nowMs);
    expect(leaseResult.ok).toBe(false);
    expect(!leaseResult.ok && leaseResult.error.code).toBe("not_found");
    expect(fake.leases.size).toBe(0);
  });

  it("does not let comment.add overwrite an existing client-minted comment id", async () => {
    await seed("blk_comment", "Discuss", at(1_000, "device-a"));
    const add = (requestId: string, body: string): NotesMutationRequest => ({
      version: 1,
      requestId,
      deviceId: "dashboard-tab",
      operation: {
        type: "comment.add", blockId: "blk_comment", commentId: "cmt_stable", body,
      },
    });
    const first = await notes.mutateNotes(ORG, USER, add("comment-first", "first"), fake.nowMs);
    expect(first.ok).toBe(true);

    const collision = await notes.mutateNotes(
      ORG, USER, add("comment-collision", "overwrite"), fake.nowMs + 1,
    );
    expect(collision.ok).toBe(false);
    expect(!collision.ok && collision.error.code).toBe("refused");
    expect(blockOf("blk_comment").comments!.cmt_stable!.body.value).toBe("first");
  });

  it("does not let a stale conflict choice clear a newer kept-both pair", async () => {
    await seed("blk_conflict", "ours", at(1_000, "device-a"));
    await push({
      key: "make-conflict", id: "blk_conflict", at: at(1_000, "device-b"),
      payload: { text: "theirs" },
    });
    const shown = structuredClone(blockOf("blk_conflict").conflicts!.text!);
    blockOf("blk_conflict").conflicts!.text = {
      ...shown,
      theirs: "newer theirs",
      theirsAt: at(shown.theirsAt.physical + 1, "device-c"),
    };

    const response = await notes.mutateNotes(ORG, USER, {
      version: 1,
      requestId: "stale-conflict-choice",
      deviceId: "dashboard-tab",
      operation: {
        type: "conflict.resolve", blockId: "blk_conflict", field: "text", keep: "ours",
        expected: { oursAt: shown.oursAt, theirsAt: shown.theirsAt },
      },
    }, fake.nowMs);
    expect(response.ok).toBe(false);
    expect(!response.ok && response.error.code).toBe("stale_conflict");
    expect(blockOf("blk_conflict").conflicts?.text?.theirs).toBe("newer theirs");
  });

  it("refuses an over-bound generated template plan before any copied block is written", async () => {
    const operations = Array.from({ length: 201 }, (_, index) => ({
      idempotencyKey: `large-template:${index}`,
      itemId: index === 0 ? "large-template" : `large-child-${index}`,
      kind: "create" as const,
      at: at(1_000 + index, "seed"),
      payload: {
        kind: index === 0 ? "page" : "paragraph",
        text: `row ${index}`,
        parentId: index === 0 ? null : "large-template",
        rank: `r-${index.toString().padStart(3, "0")}`,
        ...(index === 0 ? { template: true } : {}),
      },
    }));
    const seeded = await notes.pushOperations(ORG, USER, operations);
    expect(seeded.accepted).toHaveLength(201);
    const before = fake.blocks.size;
    const response = await notes.mutateNotes(ORG, USER, {
      version: 1,
      requestId: "over-bound-template",
      deviceId: "dashboard-tab",
      operation: { type: "template.instantiate", templateId: "large-template", parentId: null },
    }, fake.nowMs);
    expect(response.ok).toBe(false);
    expect(!response.ok && response.error.code).toBe("limit_exceeded");
    expect(fake.blocks.size).toBe(before);
  });
});

/**
 * ADR-029 C5 + E6 — the SERVER half of the workspace verbs.
 *
 * These went unpinned because the suite above tests `pushOperations` directly
 * and the registry is the layer between it and every caller. Three properties
 * that were wrong at the same time, all silently:
 *
 *   - a restored block resolved as a tombstone for ever, because the reference
 *     paths tested `deletedAt` for truthiness while restore is a newer
 *     `restoredAt` that OUTVOTES it (C5's second sentence);
 *   - a created block kept only `kind` and `parentId`, so a database row
 *     arrived with every column empty and nothing said so (E6);
 *   - a write blocked by another device's lease was reported as `updated` with
 *     the field named in `changed`, while the stored text was unchanged (E6's
 *     "an update that succeeds for the four fields it understood teaches its
 *     caller the fifth landed too").
 */
const { workspaceRegistry } = await import("../memory/workspace/registry.js");

describe("the workspace verbs, server-side", () => {
  const VIEWER = { userId: USER, orgId: ORG };
  const reset = (): void => {
    fake.blocks.clear(); fake.refs.clear(); fake.index.clear();
    fake.applied.clear(); fake.leases.clear(); fake.hostClocks.clear();
    fake.pageMeta.clear(); fake.rowValues.clear();
    fake.upserts = 0; fake.nowMs = 1_000_000;
    fake.failUpsertAt = null;
  };
  beforeEach(reset);

  it("C5: restoring a block restores the reference — resolve, describe and update all come back", async () => {
    const registry = workspaceRegistry();
    await seed("blk_1", "original sentence", at(1_000, "device-a"));
    const ref = { mode: "notes", kind: "block", id: "blk_1" } as const;

    await push({ key: "blk_1:del", id: "blk_1", kind: "delete", at: at(2_000, "device-a"), payload: {} });
    expect((await registry.resolve(ref, VIEWER)).status).toBe("gone");

    await push({ key: "blk_1:restore", id: "blk_1", at: at(3_000, "device-a"), payload: { restore: true } });
    // The tombstone is still on the record. That is the point: liveness is the
    // comparison of the two stamps, not the presence of one of them.
    expect(blockOf("blk_1").deletedAt).toBeTruthy();

    const resolved = await registry.resolve(ref, VIEWER);
    expect(resolved.status).toBe("found");
    expect(await registry.describeLine(ref, VIEWER, { nowMs: 3_000 })).toBe("original sentence");

    const updated = await registry.update({ ref, title: "restored and edited" }, VIEWER);
    expect(updated.status).toBe("updated");
    expect(blockOf("blk_1").text.value).toBe("restored and edited");
  });

  it("C5: a block that is still deleted stays refused, so the fix is a comparison and not a removed check", async () => {
    const registry = workspaceRegistry();
    await seed("blk_1", "gone for good", at(1_000, "device-a"));
    await push({ key: "blk_1:del", id: "blk_1", kind: "delete", at: at(2_000, "device-a"), payload: {} });

    const outcome = await registry.update(
      { ref: { mode: "notes", kind: "block", id: "blk_1" }, title: "nope" },
      VIEWER,
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toBe("not_found");
  });

  it("E6: a created row arrives WITH its cells and a page with its icon, not as an empty row", async () => {
    const registry = workspaceRegistry();
    const created = await registry.create(
      {
        mode: "notes",
        kind: "block",
        title: "Invoice 2",
        fields: { kind: "page", props: { amount: 999, due: "2026-10-01" }, icon: "🧾" },
      },
      VIEWER,
    );
    expect(created.status).toBe("created");
    const id = created.status === "created" ? created.ref.id : "";
    const block = blockOf(id);
    expect(block.icon?.value).toBe("🧾");
    expect(block.props?.amount?.value).toBe(999);
    expect(block.props?.due?.value).toBe("2026-10-01");
    expect(block.text.value).toBe("Invoice 2");
  });

  it("E6: a field the mode has no meaning for is REPORTED by create, not dropped in silence", async () => {
    const registry = workspaceRegistry();
    const created = await registry.create(
      { mode: "notes", kind: "block", title: "A note", fields: { nonsense: 1 } },
      VIEWER,
    );
    expect(created.status).toBe("created");
    expect(created.status === "created" && created.ignored).toEqual(["nonsense"]);
  });

  it("E6: an update blocked by another device's lease is refused as `locked`, not reported as a change", async () => {
    const registry = workspaceRegistry();
    await seed("blk_1", "original sentence", at(1_000, "device-a"));
    await notes.acquireLease(ORG, USER, "blk_1", { deviceId: "device-b", holder: "the phone" });

    const outcome = await registry.update(
      { ref: { mode: "notes", kind: "block", id: "blk_1" }, title: "agent rewrote it" },
      VIEWER,
    );

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toBe("locked");
    // And the block is untouched, which is the thing the old `updated` answer
    // was contradicting.
    expect(blockOf("blk_1").text.value).toBe("original sentence");
  });

  it("E6: `changed` names what the merge took — a field a stale stamp lost is not reported as changed", async () => {
    const registry = workspaceRegistry();
    // Stamped an hour into the future, so the server's own `Date.now()` clock
    // is behind it and the merge keeps the existing text — the ordinary case of
    // an agent writing against a version it has not seen. A `changed` list
    // built from the REQUEST would still say "text".
    await seed("blk_1", "the version everyone else has", at(Date.now() + 3_600_000, "device-z"));

    const outcome = await registry.update(
      { ref: { mode: "notes", kind: "block", id: "blk_1" }, title: "what the agent believed" },
      VIEWER,
    );
    expect(outcome.status).toBe("updated");
    expect(outcome.status === "updated" && outcome.changed).toEqual([]);
    expect(blockOf("blk_1").text.value).toBe("the version everyone else has");
  });

  it("E6: code is linkable but not creatable here — not an unheard-of mode", async () => {
    const registry = workspaceRegistry();
    const created = await registry.create({ mode: "code", kind: "file", title: "src/new.ts" }, VIEWER);
    expect(created.status).toBe("refused");
    expect(created.status === "refused" && created.reason).toBe("mode_is_not_creatable");

    // Reading still answers honestly — the server has no checkout.
    const resolved = await registry.resolve({ mode: "code", kind: "file", id: "src/new.ts" }, VIEWER);
    expect(resolved.status).toBe("unavailable");
    expect(resolved.status === "unavailable" && resolved.reason).toBe("no_resolver_here");
  });
});
