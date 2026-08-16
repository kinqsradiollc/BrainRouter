/**
 * ADR-029 — the notes and workspace HTTP surfaces, end to end through express.
 *
 * ADR-028's lesson is the reason this file exists rather than only the unit
 * tests beside it: six times in that release something compiled, passed tests,
 * and nothing called it. A merge policy nobody can reach over HTTP is not a
 * feature, so these drive the real routers — auth, org resolution, handler — and
 * the last test asserts the routers are actually mounted on the app.
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hlc, NoteBlock } from "@kinqs/brainrouter-core/notes";
import type { NoteMutationQueries } from "../memory/store/postgres/queries/notesQueries.js";

interface StoredBlock {
  parentId: string | null;
  kind: string;
  visibility: string;
  payload: Record<string, unknown>;
  deletedAtHlc: string | null;
}

/** Just enough store for the routes under test; the SQL has its own suite. */
const db = {
  blocks: new Map<string, StoredBlock>(),
  applied: new Map<string, {
    blockId: string;
    fingerprint: string | null;
    response: Record<string, unknown> | null;
  }>(),
  index: new Map<string, { contentText: string; refKeys: string[] }>(),
  refs: new Map<string, unknown[]>(),
  leases: new Map<string, { blockId: string; deviceId: string; holder: string | null; epoch: number; expiresAtMs: number }>(),
  hostClocks: new Map<string, { physical: number; logical: number }>(),
  // ADR-029 Part E (migration 053) — the projections the page and database
  // routes read. Written by the same re-derive call as `index`.
  pageMeta: new Map<string, Record<string, unknown>>(),
  rowValues: new Map<string, unknown[]>(),
};
const key = (orgId: string, userId: string, id: string) => `${orgId}/${userId}/${id}`;
let mutationQueue: Promise<void> = Promise.resolve();
let failNextReceipt: Error | null = null;

function restoreMap<K, V>(target: Map<K, V>, snapshot: Map<K, V>): void {
  target.clear();
  for (const [entryKey, value] of snapshot) target.set(entryKey, value);
}

const fakeStore = {
  async withNoteMutation<T>(
    _orgId: string,
    _userId: string,
    fn: (queries: NoteMutationQueries) => Promise<T>,
  ): Promise<T> {
    const previous = mutationQueue;
    let release!: () => void;
    mutationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = {
      blocks: structuredClone(db.blocks),
      applied: structuredClone(db.applied),
      index: structuredClone(db.index),
      refs: structuredClone(db.refs),
      leases: structuredClone(db.leases),
      hostClocks: structuredClone(db.hostClocks),
      pageMeta: structuredClone(db.pageMeta),
      rowValues: structuredClone(db.rowValues),
    };
    try {
      return await fn(fakeStore as unknown as NoteMutationQueries);
    } catch (error) {
      restoreMap(db.blocks, snapshot.blocks);
      restoreMap(db.applied, snapshot.applied);
      restoreMap(db.index, snapshot.index);
      restoreMap(db.refs, snapshot.refs);
      restoreMap(db.leases, snapshot.leases);
      restoreMap(db.hostClocks, snapshot.hostClocks);
      restoreMap(db.pageMeta, snapshot.pageMeta);
      restoreMap(db.rowValues, snapshot.rowValues);
      throw error;
    } finally {
      release();
    }
  },
  async databaseNowMs() { return Date.now(); },
  async listNoteBlocksSince() { return []; },
  async listAllNoteBlocks(orgId: string, userId: string) {
    return [...db.blocks.entries()]
      .filter(([k]) => k.startsWith(`${orgId}/${userId}/`))
      .map(([k, row]) => ({ id: k.split("/").at(-1)!, ...row, revision: "1", updatedAt: new Date().toISOString() }));
  },
  async getNoteBlock(orgId: string, userId: string, id: string) {
    const row = db.blocks.get(key(orgId, userId, id));
    return row ? { id, ...row, revision: "1", updatedAt: new Date().toISOString() } : null;
  },
  async findNoteBlockInOrg(orgId: string, id: string) {
    for (const [k, row] of db.blocks) {
      const [org, user, blockId] = k.split("/");
      if (org === orgId && blockId === id) return { id, userId: user!, visibility: row.visibility, deletedAtHlc: row.deletedAtHlc };
    }
    return null;
  },
  async upsertNoteBlock(orgId: string, userId: string, block: StoredBlock & { id: string; visibility?: string }) {
    const row: StoredBlock = {
      parentId: block.parentId, kind: block.kind, visibility: block.visibility ?? "private",
      payload: block.payload, deletedAtHlc: block.deletedAtHlc ?? null,
    };
    db.blocks.set(key(orgId, userId, block.id), row);
    return { id: block.id, ...row, revision: "1", updatedAt: new Date().toISOString() };
  },
  async latestNoteRevision() { return "1"; },
  async wasNoteOperationApplied(orgId: string, userId: string, k: string) { return db.applied.has(`${orgId}/${userId}/${k}`); },
  async getNoteOperationReceipt(orgId: string, userId: string, k: string) {
    if (failNextReceipt) {
      const error = failNextReceipt;
      failNextReceipt = null;
      throw error;
    }
    return db.applied.get(`${orgId}/${userId}/${k}`) ?? null;
  },
  async recordNoteOperationApplied(
    orgId: string,
    userId: string,
    k: string,
    blockId: string,
    fingerprint?: string,
    response?: Record<string, unknown>,
  ) {
    db.applied.set(`${orgId}/${userId}/${k}`, {
      blockId,
      fingerprint: fingerprint ?? null,
      response: response ? structuredClone(response) : null,
    });
  },
  async replaceNoteRefs(orgId: string, userId: string, blockId: string, refs: unknown[]) { db.refs.set(key(orgId, userId, blockId), refs); },
  async listNoteRefsFrom(orgId: string, userId: string, blockId: string) { return db.refs.get(key(orgId, userId, blockId)) ?? []; },
  async listNoteBacklinks() { return []; },
  async upsertNoteIndex(orgId: string, userId: string, blockId: string, entry: { contentText: string; refKeys: string[] }) {
    db.index.set(key(orgId, userId, blockId), { contentText: entry.contentText, refKeys: [...entry.refKeys] });
  },
  async deleteNoteIndexEntry(orgId: string, userId: string, blockId: string) { db.index.delete(key(orgId, userId, blockId)); },
  async searchNoteIndex(orgId: string, userId: string, query: string) {
    return [...db.index.entries()]
      .filter(([k, entry]) => k.startsWith(`${orgId}/${userId}/`) && entry.contentText.includes(query))
      .map(([k]) => ({ blockId: k.split("/").at(-1)!, matchedText: true, matchedReference: false, rank: 1, payload: db.blocks.get(k)!.payload }));
  },
  async readNoteBlockLease(orgId: string, userId: string, blockId: string) {
    return { lease: db.leases.get(key(orgId, userId, blockId)) ?? null, dbNowMs: Date.now() };
  },
  async upsertNoteBlockLease(orgId: string, userId: string, lease: { blockId: string; deviceId: string; holder: string | null; epoch: number; expiresAtMs: number }) {
    db.leases.set(key(orgId, userId, lease.blockId), lease);
  },
  async sweepNoteBlockLeases() { return 0; },
  async observeNoteHostClock(orgId: string, userId: string, remote: Hlc) {
    const scope = `${orgId}/${userId}`;
    const current = db.hostClocks.get(scope);
    if (!current || remote.physical > current.physical
      || (remote.physical === current.physical && remote.logical > current.logical)) {
      db.hostClocks.set(scope, { physical: remote.physical, logical: remote.logical });
    }
  },
  async nextNoteHostClock(
    orgId: string,
    userId: string,
    deviceId: string,
    wallClockMs: number,
    reserve: number,
  ): Promise<Hlc> {
    const scope = `${orgId}/${userId}`;
    const current = db.hostClocks.get(scope) ?? { physical: -1, logical: -1 };
    const physical = Math.max(current.physical, Math.max(0, Math.trunc(wallClockMs)));
    const logical = physical === current.physical ? current.logical + 1 : 0;
    db.hostClocks.set(scope, {
      physical,
      logical: logical + Math.max(1, Math.trunc(reserve)) - 1,
    });
    return { physical, logical, deviceId };
  },
  async clearNoteDerived(orgId: string, userId: string) {
    for (const map of [db.index, db.refs, db.pageMeta, db.rowValues] as Array<Map<string, unknown>>) {
      for (const k of [...map.keys()]) if (k.startsWith(`${orgId}/${userId}/`)) map.delete(k);
    }
  },
  async upsertNotePageMeta(orgId: string, userId: string, meta: { blockId: string }) {
    db.pageMeta.set(key(orgId, userId, meta.blockId), meta as Record<string, unknown>);
  },
  async deleteNotePageMeta(orgId: string, userId: string, blockId: string) {
    db.pageMeta.delete(key(orgId, userId, blockId));
  },
  async listNotePageMeta(orgId: string, userId: string, opts: { kinds?: readonly string[]; favouritesOnly?: boolean } = {}) {
    return [...db.pageMeta.entries()]
      .filter(([k]) => k.startsWith(`${orgId}/${userId}/`))
      .map(([, meta]) => meta)
      .filter((meta) => (!opts.kinds || opts.kinds.includes(String(meta.kind))))
      .filter((meta) => (!opts.favouritesOnly || meta.favourite === true));
  },
  async getNotePageMeta(orgId: string, userId: string, blockId: string) {
    return db.pageMeta.get(key(orgId, userId, blockId)) ?? null;
  },
  async replaceNoteRowValues(orgId: string, userId: string, blockId: string, _parentId: string | null, values: unknown[]) {
    db.rowValues.set(key(orgId, userId, blockId), [...values]);
  },
  async listNoteChildBlocks(orgId: string, userId: string, parentId: string) {
    return (await fakeStore.listAllNoteBlocks(orgId, userId)).filter((row) => row.parentId === parentId);
  },
  async listNoteDatabaseRows(orgId: string, userId: string, databaseId: string) {
    return fakeStore.listNoteChildBlocks(orgId, userId, databaseId);
  },
  async countNoteDatabaseRows(orgId: string, userId: string, databaseId: string) {
    return (await fakeStore.listNoteChildBlocks(orgId, userId, databaseId)).length;
  },
};

const mocks = vi.hoisted(() => ({
  getMemberRole: vi.fn(), getDefaultOrgId: vi.fn(), ensurePersonalOrg: vi.fn(), getUserById: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((k: string) => (k === "br_user" ? { userId: "user-1", isAdmin: false, email: "user@example.test" } : null)),
    getUserById: mocks.getUserById,
    tenancy: {
      getMemberRole: mocks.getMemberRole,
      getDefaultOrgId: mocks.getDefaultOrgId,
      ensurePersonalOrg: mocks.ensurePersonalOrg,
    },
    get store() { return fakeStore; },
  },
}));

const { notesRouter } = await import("../api/routes/notes.js");
const { workspaceRouter } = await import("../api/routes/workspace.js");

describe("notes + workspace routes", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";
  const headers = { Authorization: "Bearer br_user", "Content-Type": "application/json", "X-BrainRouter-Org": "org-a" };

  const mutate = (
    operation: Record<string, unknown>,
    requestId: string,
    deviceId = "dashboard-tab",
    extra: Record<string, unknown> = {},
  ) => fetch(`${baseUrl}/api/notes/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: 1, requestId, deviceId, operation, ...extra,
    }),
  });

  beforeEach(async () => {
    db.blocks.clear(); db.applied.clear(); db.index.clear(); db.refs.clear(); db.leases.clear(); db.hostClocks.clear();
    db.pageMeta.clear(); db.rowValues.clear();
    failNextReceipt = null;
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
    mocks.getUserById.mockImplementation(async (userId: string) => ({ userId, isAdmin: false, status: "active" }));
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) =>
      (userId === "user-1" && orgId === "org-a" ? "admin" : null));
    mocks.ensurePersonalOrg.mockResolvedValue({ orgId: "org-a" });

    const app = express();
    app.use(express.json());
    app.use("/api/notes", notesRouter);
    app.use("/api/workspace", workspaceRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = undefined; });

  it("a pushed block is readable back through the same API a second device would pull from", async () => {
    const push = await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{
          idempotencyKey: "op-1", itemId: "blk_1", kind: "create",
          at: { physical: 1000, logical: 0, deviceId: "device-a" },
          payload: { text: "the parser rewrite", kind: "paragraph", rank: "m" },
        }],
      }),
    });
    expect(push.status).toBe(200);
    expect((await push.json()).accepted).toEqual(["op-1"]);

    const read = await fetch(`${baseUrl}/api/notes/blocks/blk_1`, { headers });
    expect(read.status).toBe(200);
    expect((await read.json()).block.text.value).toBe("the parser rewrite");
  });

  it("publishes an honest writable-editor capability document", async () => {
    const res = await fetch(`${baseUrl}/api/notes/mutate/capabilities`, { headers });
    expect(res.status).toBe(200);
    const capabilities = await res.json();
    expect(capabilities.endpoint).toBe("/api/notes/mutate");
    expect(capabilities.operations["gesture.split"]).toBe(true);
    expect(capabilities.operations["block.restore"]).toBe(true);
    expect(capabilities.operations["conflict.resolve"]).toBe(true);
    expect(capabilities.operations["template.instantiate"]).toBe(true);
    expect(capabilities.operations["history.undo"]).toBe(false);
    expect(capabilities.operations["history.redo"]).toBe(false);
    expect(capabilities.operations["attachment.upload-bytes"]).toBe(false);
  });

  it("validates the mutation envelope before it reaches persistence", async () => {
    const res = await fetch(`${baseUrl}/api/notes/mutate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: 1,
        requestId: "bad-move",
        deviceId: "dashboard-tab",
        operation: { type: "gesture.move", blockId: "blk_1", direction: 0 },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.detail).toContain("direction");
    expect(db.applied.size).toBe(0);
  });

  it("scopes browser mutations only from auth, ignoring forged org/user body fields", async () => {
    const res = await mutate(
      { type: "block.create", input: { blockId: "blk_scoped", text: "private draft" } },
      "scoped-create",
      "dashboard-tab",
      { orgId: "org-other", userId: "user-2" },
    );
    expect(res.status).toBe(200);
    expect(db.blocks.has("org-a/user-1/blk_scoped")).toBe(true);
    expect(db.blocks.has("org-other/user-2/blk_scoped")).toBe(false);
  });

  it("uses Core's gesture plan remotely and makes a retry idempotent", async () => {
    await mutate(
      { type: "block.create", input: { blockId: "blk_split", text: "one two" } },
      "split-seed",
    );
    const request = {
      version: 1,
      requestId: "split-once",
      deviceId: "dashboard-tab",
      operation: { type: "gesture.split", blockId: "blk_split", caret: 3 },
    };
    const first = await fetch(`${baseUrl}/api/notes/mutate`, {
      method: "POST", headers, body: JSON.stringify(request),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.ok).toBe(true);
    expect(firstBody.result.action).toBe("split");
    expect(firstBody.sync.accepted).toHaveLength(2);

    const afterFirst = [...db.blocks.keys()].filter((k) => k.startsWith("org-a/user-1/"));
    const retry = await fetch(`${baseUrl}/api/notes/mutate`, {
      method: "POST", headers, body: JSON.stringify(request),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(firstBody);
    expect([...db.blocks.keys()].filter((k) => k.startsWith("org-a/user-1/"))).toEqual(afterFirst);
    expect((db.blocks.get("org-a/user-1/blk_split")!.payload as unknown as NoteBlock).text.value).toBe("one");
  });

  it("reports lease-fenced edits instead of claiming the displayed text changed", async () => {
    await mutate(
      { type: "block.create", input: { blockId: "blk_locked", text: "original" } },
      "locked-seed",
    );
    const lease = await mutate(
      { type: "lease.acquire", blockId: "blk_locked", holder: "the desktop" },
      "lease-a",
      "device-a",
    );
    expect(lease.status).toBe(200);
    expect((await lease.json()).result.lease.epoch).toBe(1);

    const fenced = await mutate(
      { type: "block.update", blockId: "blk_locked", patch: { text: "stale dashboard text" } },
      "blocked-write",
      "device-b",
    );
    expect(fenced.status).toBe(200);
    const body = await fenced.json();
    expect(body.sync.fenced).toEqual([
      expect.objectContaining({ itemId: "blk_locked", reason: "blocked" }),
    ]);
    const stored = db.blocks.get("org-a/user-1/blk_locked")!.payload as unknown as NoteBlock;
    expect(stored.text.value).toBe("original");
    expect(stored.conflicts!.text).toBeTruthy();
  });

  it("performs comments and basic database writes through the same mutation transport", async () => {
    await mutate(
      { type: "block.create", input: { blockId: "db_mut", kind: "database", text: "Reading" } },
      "db-create",
    );
    const property = await mutate({
      type: "database.property.add",
      databaseId: "db_mut",
      property: { id: "status", name: "Status", type: "select" },
    }, "db-property");
    expect(property.status).toBe(200);

    const row = await mutate({
      type: "database.row.create",
      databaseId: "db_mut",
      rowId: "row_mut",
      title: "A book",
      values: { status: "reading" },
    }, "db-row");
    expect(row.status).toBe(200);
    const set = await mutate({
      type: "database.row.set", rowId: "row_mut", propertyId: "status", value: "done",
    }, "db-cell");
    expect(set.status).toBe(200);
    const savedView = await mutate({
      type: "database.view.save",
      databaseId: "db_mut",
      view: { id: "list", name: "List", kind: "list", visible: ["title", "status"] },
    }, "db-view");
    expect(savedView.status).toBe(200);

    const comment = await mutate({
      type: "comment.add", blockId: "row_mut", body: "check the citation", author: "Ada",
    }, "comment-add");
    expect(comment.status).toBe(200);
    const commentBody = await comment.json();
    const commentId = commentBody.result.comment.id;
    const edited = await mutate({
      type: "comment.edit", blockId: "row_mut", commentId, body: "citation checked",
    }, "comment-edit");
    expect(edited.status).toBe(200);

    const database = db.blocks.get("org-a/user-1/db_mut")!.payload as unknown as NoteBlock;
    expect(database.schema!.value.map((def: { id: string }) => def.id)).toEqual(["title", "status"]);
    expect(database.views!.value.map((view: { id: string }) => view.id)).toContain("list");
    const storedRow = db.blocks.get("org-a/user-1/row_mut")!.payload as unknown as NoteBlock;
    expect(storedRow.props!.status!.value).toBe("done");
    expect(storedRow.comments![commentId]!.body.value).toBe("citation checked");
  });

  it("restores subtrees, resolves conflicts and instantiates templates through the same transport", async () => {
    await mutate(
      { type: "block.create", input: { blockId: "page_trash", kind: "page", text: "Recover me" } },
      "restore-page-seed",
    );
    await mutate(
      { type: "block.create", input: { blockId: "trash_child", parentId: "page_trash", text: "Child" } },
      "restore-child-seed",
    );
    expect((await mutate({ type: "block.delete", blockId: "page_trash" }, "restore-delete")).status).toBe(200);
    const restored = await mutate({ type: "block.restore", blockId: "page_trash" }, "restore-subtree");
    expect(restored.status).toBe(200);
    expect((await restored.json()).result.restoredIds).toEqual(["page_trash", "trash_child"]);
    expect((db.blocks.get("org-a/user-1/trash_child")!.payload as unknown as NoteBlock).restoredAt).toBeTruthy();

    await mutate(
      { type: "block.create", input: { blockId: "page_template", kind: "page", text: "Runbook" } },
      "template-page-seed",
    );
    await mutate(
      {
        type: "block.create",
        input: {
          blockId: "template_child",
          parentId: "page_template",
          text: "See brainrouter://notes/block/template_child",
        },
      },
      "template-child-seed",
    );
    await mutate(
      { type: "block.update", blockId: "page_template", patch: { template: true } },
      "template-mark",
    );
    const instantiated = await mutate(
      { type: "template.instantiate", templateId: "page_template", parentId: null },
      "template-instantiate",
    );
    expect(instantiated.status).toBe(200);
    const made = await instantiated.json();
    expect(made.result.pageId).toMatch(/^blk_/);
    expect(made.result.blocks).toBe(2);
    expect(made.result.rewritten).toBe(1);
    expect(made.result.line).toContain("1 link");
    const copiedPage = db.blocks.get(`org-a/user-1/${made.result.pageId}`)!.payload as unknown as NoteBlock;
    expect(copiedPage.template?.value).not.toBe(true);

    await mutate(
      { type: "block.create", input: { blockId: "blk_conflict", text: "mine" } },
      "conflict-seed",
    );
    await mutate(
      { type: "lease.acquire", blockId: "blk_conflict", holder: "desktop" },
      "conflict-lease",
      "device-a",
    );
    await mutate(
      { type: "block.update", blockId: "blk_conflict", patch: { text: "theirs" } },
      "conflict-write",
      "device-b",
    );
    const conflict = (db.blocks.get("org-a/user-1/blk_conflict")!.payload as unknown as NoteBlock)
      .conflicts!.text!;
    const resolved = await mutate({
      type: "conflict.resolve", blockId: "blk_conflict", field: "text", keep: "theirs",
      expected: { oursAt: conflict.oursAt, theirsAt: conflict.theirsAt },
    }, "conflict-resolve", "device-b");
    expect(resolved.status).toBe(200);
    const resolvedBlock = db.blocks.get("org-a/user-1/blk_conflict")!.payload as unknown as NoteBlock;
    expect(resolvedBlock.text.value).toBe("theirs");
    expect(resolvedBlock.conflicts?.text).toBeUndefined();
  });

  it("serves complete scoped trash and orphaned-comment projections", async () => {
    await mutate(
      { type: "block.create", input: { blockId: "page_orphan", kind: "page", text: "Old plan" } },
      "orphan-page-seed",
    );
    await mutate(
      { type: "block.create", input: { blockId: "orphan_child", parentId: "page_orphan", text: "Questioned line" } },
      "orphan-child-seed",
    );
    await mutate(
      { type: "comment.add", blockId: "orphan_child", body: "Does this still apply?", author: "Ada" },
      "orphan-comment",
    );
    await mutate({ type: "block.delete", blockId: "page_orphan" }, "orphan-delete");

    const trash = await fetch(`${baseUrl}/api/notes/trash`, { headers });
    expect(trash.status).toBe(200);
    expect((await trash.json()).entries).toEqual([
      expect.objectContaining({
        id: "page_orphan",
        kind: "page",
        title: "Old plan",
        descendants: 1,
        line: "Old plan — and 1 block inside it",
      }),
    ]);

    const orphaned = await fetch(`${baseUrl}/api/notes/comments/orphaned`, { headers });
    expect(orphaned.status).toBe(200);
    expect((await orphaned.json()).threads).toEqual([{
      blockId: "orphan_child",
      text: "Questioned line",
      comments: [expect.objectContaining({
        body: "Does this still apply?",
        author: "Ada",
        resolved: false,
      })],
    }]);
  });

  it("reads rollup targets through authenticated Core policy instead of client-side traversal", async () => {
    await mutate(
      { type: "block.create", input: { blockId: "db_target", kind: "database", text: "Tasks" } },
      "rollup-target-db",
    );
    await mutate({
      type: "database.property.add",
      databaseId: "db_target",
      property: { id: "points", name: "Points", type: "number" },
    }, "rollup-target-property");
    await mutate({
      type: "database.row.create", databaseId: "db_target", rowId: "row_target", title: "Ship",
    }, "rollup-target-row");

    await mutate(
      { type: "block.create", input: { blockId: "db_source", kind: "database", text: "Projects" } },
      "rollup-source-db",
    );
    await mutate({
      type: "database.property.add",
      databaseId: "db_source",
      property: { id: "tasks", name: "Tasks", type: "relation" },
    }, "rollup-source-property");
    await mutate({
      type: "database.row.create",
      databaseId: "db_source",
      rowId: "row_source",
      title: "Release",
      values: { tasks: ["brainrouter://notes/block/row_target"] },
    }, "rollup-source-row");

    const res = await fetch(
      `${baseUrl}/api/notes/databases/db_source/rollup-targets?relation=tasks`,
      { headers },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      properties: [
        { id: "title", name: "Name", type: "title" },
        { id: "points", name: "Points", type: "number" },
      ],
      databases: [{ id: "db_target", title: "Tasks" }],
    });
  });

  it("returns typed unsupported capabilities for remote undo and attachment bytes", async () => {
    const state = await mutate({ type: "history.state", pageId: null }, "history-state");
    expect(state.status).toBe(200);
    expect((await state.json()).history.canUndo).toBe(false);

    const undo = await mutate({ type: "history.undo", pageId: null }, "history-undo");
    expect(undo.status).toBe(422);
    expect((await undo.json()).error.capability).toBe("remote_history");

    const bytes = await mutate({
      type: "attachment.upload-bytes",
      blockId: "blk_1",
      fileName: "image.png",
      mediaType: "image/png",
      byteSize: 20,
    }, "attachment-bytes");
    expect(bytes.status).toBe(422);
    expect((await bytes.json()).error.capability).toBe("attachment_bytes");
  });

  it("an unauthenticated push is refused before it reaches any store", async () => {
    const res = await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operations: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("a push larger than the batch limit is refused with the limit named, so the client can split it", async () => {
    const operations = Array.from({ length: 201 }, (_, i) => ({
      idempotencyKey: `op-${i}`, itemId: `blk_${i}`, kind: "create",
      at: { physical: 1000, logical: 0, deviceId: "d" }, payload: { text: "x" },
    }));
    const res = await fetch(`${baseUrl}/api/notes/push`, { method: "POST", headers, body: JSON.stringify({ operations }) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("200");
  });

  it("rejects reserved legacy map keys without polluting or persisting a block", async () => {
    const res = await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST",
      headers,
      body: '{"operations":[{"idempotencyKey":"poison","itemId":"blk_poison","kind":"create","at":{"physical":1000,"logical":0,"deviceId":"d"},"payload":{"text":"x","props":{"__proto__":"pollute"}}}]}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toEqual([]);
    expect(body.rejected[0].reason).toMatch(/reserved|invalid/i);
    expect(db.blocks.has("org-a/user-1/blk_poison")).toBe(false);
    expect(({} as Record<string, unknown>).pollute).toBeUndefined();
  });

  it("returns a fenced legacy push signal instead of claiming its text became visible", async () => {
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers, body: JSON.stringify({ operations: [{
        idempotencyKey: "fence-seed", itemId: "blk_raw_fence", kind: "create",
        at: { physical: 1000, logical: 0, deviceId: "device-a" },
        payload: { text: "visible", rank: "m" },
      }] }),
    });
    await mutate(
      { type: "lease.acquire", blockId: "blk_raw_fence", holder: "desktop" },
      "raw-fence-lease", "device-a",
    );
    const res = await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers, body: JSON.stringify({ operations: [{
        idempotencyKey: "fenced-raw", itemId: "blk_raw_fence", kind: "update",
        at: { physical: 2000, logical: 0, deviceId: "device-b" },
        payload: { text: "fenced copy" },
      }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toEqual(["fenced-raw"]);
    expect(body.fenced).toEqual([{
      idempotencyKey: "fenced-raw", itemId: "blk_raw_fence", reason: "blocked",
    }]);
    expect((db.blocks.get("org-a/user-1/blk_raw_fence")!.payload as unknown as NoteBlock).text.value)
      .toBe("visible");
  });

  it("sanitizes retryable internal push and mutation errors", async () => {
    failNextReceipt = new Error("secret relation notes_applied_operations failed");
    const pushed = await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers, body: JSON.stringify({ operations: [{
        idempotencyKey: "internal-push", itemId: "blk_internal", kind: "create",
        at: { physical: 1000, logical: 0, deviceId: "d" }, payload: { text: "x" },
      }] }),
    });
    expect(pushed.status).toBe(503);
    const pushBody = await pushed.json();
    expect(pushBody.error).toBe("The Notes service could not apply this push. Retry it.");
    expect(JSON.stringify(pushBody)).not.toContain("secret relation");

    failNextReceipt = new Error("secret connection string");
    const mutation = await mutate(
      { type: "block.create", input: { blockId: "blk_internal", text: "x" } },
      "internal-mutation",
    );
    expect(mutation.status).toBe(500);
    const mutationBody = await mutation.json();
    expect(mutationBody.error.code).toBe("internal_error");
    expect(mutationBody.error.retryable).toBe(true);
    expect(JSON.stringify(mutationBody)).not.toContain("secret connection");
  });

  it("search reaches the index the push wrote, which is what makes B5 a feature rather than a table", async () => {
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{
          idempotencyKey: "op-1", itemId: "blk_1", kind: "create",
          at: { physical: 1000, logical: 0, deviceId: "device-a" },
          payload: { text: "the parser rewrite brainrouter://track/work-item/BR-114", rank: "m" },
        }],
      }),
    });

    const res = await fetch(`${baseUrl}/api/notes/search?q=parser`, { headers });
    const { hits } = await res.json();
    expect(hits.map((h: { blockId: string }) => h.blockId)).toEqual(["blk_1"]);
  });

  it("a second device asking for a held block is told who has it, not just refused", async () => {
    await fetch(`${baseUrl}/api/notes/blocks/blk_1/lease`, {
      method: "POST", headers, body: JSON.stringify({ deviceId: "device-a", holder: "the desktop" }),
    });

    const res = await fetch(`${baseUrl}/api/notes/blocks/blk_1/lease`, {
      method: "POST", headers, body: JSON.stringify({ deviceId: "device-b" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("held_by_another");
    expect(body.detail).toContain("the desktop");
  });

  it("resolving a note reference server-side is what lets the dashboard render one at all (Q5)", async () => {
    const created = await fetch(`${baseUrl}/api/workspace/create`, {
      method: "POST", headers, body: JSON.stringify({ mode: "notes", kind: "block", title: "ship the parser" }),
    });
    expect(created.status).toBe(200);
    const outcome = await created.json();
    expect(outcome.status).toBe("created");

    const uri = `brainrouter://${outcome.ref.mode}/${outcome.ref.kind}/${outcome.ref.id}`;
    const res = await fetch(`${baseUrl}/api/workspace/resolve?uri=${encodeURIComponent(uri)}`, { headers });

    expect(res.status).toBe(200);
    const { resolution, line } = await res.json();
    expect(resolution.status).toBe("found");
    expect(line).toBe("ship the parser");
  });

  it("a code reference reads as not-available-here rather than as deleted, because the backend has no checkout", async () => {
    const uri = "brainrouter://code/file/packages/core/src/review/prRouter.ts#L59";
    const res = await fetch(`${baseUrl}/api/workspace/resolve?uri=${encodeURIComponent(uri)}`, { headers });

    const { resolution, line } = await res.json();
    expect(resolution.status).toBe("unavailable");
    expect(resolution.reason).toBe("no_resolver_here");
    // Telling someone their file was deleted because they opened the wrong app
    // is A3's quietly-wrong failure.
    expect(line).toContain("not available in this app");
  });

  it("a reference to a block that never existed resolves to a tombstone, never to nothing", async () => {
    const res = await fetch(`${baseUrl}/api/workspace/resolve?uri=${encodeURIComponent("brainrouter://notes/block/blk_missing")}`, { headers });

    const { resolution, line } = await res.json();
    expect(resolution.status).toBe("gone");
    expect(line).toContain("no longer exists");
  });

  it("another person's private note resolves as denied, not as its title and not as missing", async () => {
    db.blocks.set("org-a/user-2/blk_private", {
      parentId: null, kind: "paragraph", visibility: "private", deletedAtHlc: null,
      payload: { id: "blk_private", text: { value: "the secret roadmap", at: { physical: 1, logical: 0, deviceId: "d" } }, kind: { value: "paragraph", at: { physical: 1, logical: 0, deviceId: "d" } } },
    });

    const res = await fetch(`${baseUrl}/api/workspace/resolve?uri=${encodeURIComponent("brainrouter://notes/block/blk_private")}`, { headers });

    const { resolution, line } = await res.json();
    expect(resolution.status).toBe("denied");
    expect(line).toBe("an item you do not have access to");
    expect(JSON.stringify(resolution)).not.toContain("secret roadmap");
  });

  it("a shared note in the same org resolves for a colleague, which is what visibility is for", async () => {
    const stamp = { physical: 1, logical: 0, deviceId: "d" };
    db.blocks.set("org-a/user-2/blk_shared", {
      parentId: null, kind: "paragraph", visibility: "org", deletedAtHlc: null,
      payload: { id: "blk_shared", text: { value: "the team's onboarding notes", at: stamp }, kind: { value: "paragraph", at: stamp }, parentId: { value: null, at: stamp }, rank: { value: "m", at: stamp } },
    });

    const res = await fetch(`${baseUrl}/api/workspace/resolve?uri=${encodeURIComponent("brainrouter://notes/block/blk_shared")}`, { headers });

    const { resolution, line } = await res.json();
    expect(resolution.status).toBe("found");
    expect(line).toBe("the team's onboarding notes");
  });

  it("code is linkable and not creatable, and the refusal says which of the two it is", async () => {
    const res = await fetch(`${baseUrl}/api/workspace/create`, {
      method: "POST", headers, body: JSON.stringify({ mode: "code", kind: "file", title: "new.ts" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    // Q4's own sentence, which is what this test's NAME asks for. It used to
    // assert `no_such_mode` — "BrainRouter has never heard of code" — which is
    // false: code is a registered mode on every surface that has a checkout,
    // and it is linkable but not creatable on all of them. The two refusals
    // lead somewhere completely different for whoever reads one.
    expect(body.reason).toBe("mode_is_not_creatable");
    expect(body.detail).toMatch(/linkable but not creatable/);
  });

  /**
   * ADR-029 Part E over HTTP — the reads the dashboard has and the desktop's
   * local cache does not need.
   *
   * Written as pushes followed by reads rather than as fixtures, because the
   * claim is that the state travels the ORDINARY sync path: a page's icon
   * arriving through `/push` is what has to make it into `/pages`, and seeding
   * the projection directly would prove nothing about the path that fills it.
   */
  it("a page pushed as a block is readable as a page, which is what closes the dashboard's gap", async () => {
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{
          idempotencyKey: "op-page", itemId: "page_1", kind: "create",
          at: { physical: 1000, logical: 0, deviceId: "device-a" },
          payload: { kind: "page", text: "Runbook", rank: "m", icon: "📕" },
        }],
      }),
    });

    const res = await fetch(`${baseUrl}/api/notes/pages`, { headers });
    expect(res.status).toBe(200);
    const { pages } = await res.json();
    expect(pages).toEqual([expect.objectContaining({ blockId: "page_1", title: "Runbook", icon: "📕" })]);
  });

  it("a page read carries its blocks and says whether it was truncated", async () => {
    const at = (physical: number) => ({ physical, logical: 0, deviceId: "device-a" });
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [
          { idempotencyKey: "op-page", itemId: "page_1", kind: "create", at: at(1000), payload: { kind: "page", text: "Runbook", rank: "m" } },
          { idempotencyKey: "op-body", itemId: "blk_1", kind: "create", at: at(1001), payload: { kind: "paragraph", text: "step one", parentId: "page_1", rank: "m" } },
        ],
      }),
    });

    const res = await fetch(`${baseUrl}/api/notes/pages/page_1`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page.text.value).toBe("Runbook");
    expect(body.blocks.map((b: { id: string }) => b.id)).toEqual(["blk_1"]);
    // A caller not told it received a prefix renders a document that silently
    // stops, which is the failure Q3's bound exists to make visible.
    expect(body.truncated).toBe(false);
  });

  it("a database projects through the SAME view code the desktop runs, rows and all", async () => {
    const at = (physical: number) => ({ physical, logical: 0, deviceId: "device-a" });
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [
          {
            idempotencyKey: "op-db", itemId: "db_1", kind: "create", at: at(1000),
            payload: {
              kind: "database", text: "Reading list", rank: "m",
              schema: [{ id: "title", name: "Name", type: "title" }, { id: "stage", name: "Stage", type: "text" }],
              views: [{ id: "table", name: "Table", kind: "table", visible: ["title", "stage"] }],
            },
          },
          {
            idempotencyKey: "op-row", itemId: "row_1", kind: "create", at: at(1001),
            payload: { kind: "page", text: "Acme", parentId: "db_1", rank: "m", props: { stage: "won" } },
          },
        ],
      }),
    });

    const res = await fetch(`${baseUrl}/api/notes/databases/db_1`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projection.title).toBe("Reading list");
    expect(body.projection.columns.map((c: { id: string }) => c.id)).toEqual(["title", "stage"]);
    expect(body.projection.rows[0].title).toBe("Acme");
    expect(body.projection.rows[0].cells[1].display).toBe("won");
    // The bound is reported against what exists, so a partial read is never
    // mistaken for the whole database.
    expect(body.rowsInDatabase).toBe(1);
    expect(body.rowsRead).toBe(1);
  });

  it("a paragraph is not an empty database — the read refuses rather than projecting one", async () => {
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{
          idempotencyKey: "op-1", itemId: "blk_1", kind: "create",
          at: { physical: 1000, logical: 0, deviceId: "device-a" },
          payload: { kind: "paragraph", text: "not a database", rank: "m" },
        }],
      }),
    });

    const res = await fetch(`${baseUrl}/api/notes/databases/blk_1`, { headers });
    expect(res.status).toBe(404);
  });

  /**
   * ADR-029 C1's fourth verb over HTTP — the surface with no local store.
   *
   * The dashboard cannot change another mode's record except by asking the mode
   * that owns it, and the alternative is a write endpoint per mode per surface.
   * That is the drift C3 is organised against, so the seam is pinned here.
   */
  it("a page is renamed through the shared update verb, and the change merges like any other push", async () => {
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{
          idempotencyKey: "op-page", itemId: "page_1", kind: "create",
          at: { physical: 1000, logical: 0, deviceId: "device-a" },
          payload: { kind: "page", text: "Runbok", rank: "m" },
        }],
      }),
    });

    const res = await fetch(`${baseUrl}/api/workspace/update`, {
      method: "POST", headers,
      body: JSON.stringify({
        uri: "brainrouter://notes/block/page_1",
        title: "Runbook",
        fields: { icon: "📕", sprint: "Q3" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("updated");
    expect(body.changed.sort()).toEqual(["icon", "text"]);
    // Reported, never dropped: a caller told only about the fields that worked
    // concludes the other one worked too.
    expect(body.ignored).toEqual(["sprint"]);

    const read = await fetch(`${baseUrl}/api/notes/blocks/page_1`, { headers });
    const after = await read.json();
    expect(after.block.text.value).toBe("Runbook");
    expect(after.block.icon.value).toBe("📕");
  });

  it("a reference that is not writable here is refused with the reason, not with a generic failure", async () => {
    const res = await fetch(`${baseUrl}/api/workspace/update`, {
      method: "POST", headers,
      body: JSON.stringify({ uri: "brainrouter://code/file/src/x.ts", title: "nope" }),
    });

    expect(res.status).toBe(400);
    // "Code is linkable but not writable" — the same sentence the desktop and
    // the CLI give, because it is the same fact. The backend has no checkout,
    // so it cannot READ a file reference either, and that is reported honestly
    // as `no_resolver_here` on the resolve path rather than as a deletion. What
    // it is NOT is an unheard-of mode, which is what this used to answer.
    expect((await res.json()).reason).toBe("mode_is_not_writable");
  });

  it("and code still reads as unavailable-here rather than as deleted", async () => {
    const res = await fetch(
      `${baseUrl}/api/workspace/resolve?uri=${encodeURIComponent("brainrouter://code/file/src/x.ts")}`,
      { headers },
    );
    const { resolution, line } = await res.json();
    expect(resolution.status).toBe("unavailable");
    expect(resolution.reason).toBe("no_resolver_here");
    expect(line).toMatch(/not available in this app/);
  });

  /**
   * ADR-029 F3 — "can I leave", over HTTP.
   *
   * Core owns the writers and has its own suite for what they produce; what
   * these pin is the half only the route can get wrong — that a download is a
   * download, that the bound is reported, that a format the block cannot be
   * written as is refused rather than approximated, and that A4 still holds when
   * the file is being written for somebody to take away.
   */
  it("a page downloads as Markdown, as an attachment with a filename from its title", async () => {
    const at = (physical: number) => ({ physical, logical: 0, deviceId: "device-a" });
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [
          { idempotencyKey: "op-page", itemId: "page_1", kind: "create", at: at(1000), payload: { kind: "page", text: "Release Runbook", rank: "m" } },
          { idempotencyKey: "op-a", itemId: "blk_1", kind: "create", at: at(1001), payload: { kind: "bullet", text: "cut the branch", parentId: "page_1", rank: "m" } },
          { idempotencyKey: "op-b", itemId: "blk_2", kind: "create", at: at(1002), payload: { kind: "todo", text: "publish", parentId: "page_1", rank: "n", checked: true } },
        ],
      }),
    });

    const res = await fetch(`${baseUrl}/api/notes/blocks/page_1/export?format=markdown`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    // The filename is core's, character-classed down to an alphabet a
    // `Content-Disposition` header cannot be broken out of.
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Release-Runbook.md"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-brainrouter-export-truncated")).toBe("0");

    const body = await res.text();
    expect(body).toContain("# Release Runbook");
    expect(body).toContain("- cut the branch");
    expect(body).toContain("- [x] publish");
  });

  it("a database downloads as CSV with its computed columns worked out and its cells disarmed", async () => {
    const at = (physical: number) => ({ physical, logical: 0, deviceId: "device-a" });
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [
          {
            idempotencyKey: "op-db", itemId: "db_1", kind: "create", at: at(1000),
            payload: {
              kind: "database", text: "Orders", rank: "m",
              schema: [
                { id: "title", name: "Name", type: "title" },
                { id: "cost", name: "Cost", type: "number" },
                { id: "qty", name: "Quantity", type: "number" },
                { id: "total", name: "Total", type: "formula", formula: "Cost * Quantity" },
              ],
              views: [{ id: "table", name: "Table", kind: "table" }],
            },
          },
          {
            idempotencyKey: "op-r1", itemId: "row_1", kind: "create", at: at(1001),
            payload: { kind: "page", text: "Widget", parentId: "db_1", rank: "a", props: { title: "Widget", cost: 10, qty: 3 } },
          },
          {
            idempotencyKey: "op-r2", itemId: "row_2", kind: "create", at: at(1002),
            payload: { kind: "page", text: "=DANGER()", parentId: "db_1", rank: "b", props: { title: "=DANGER()", cost: 2, qty: 2 } },
          },
        ],
      }),
    });

    const res = await fetch(`${baseUrl}/api/notes/blocks/db_1/export?format=csv`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Orders.csv"');

    const lines = (await res.text()).split("\r\n");
    expect(lines[0]).toBe('"Title","Name","Cost","Quantity","Total"');
    // F2 — the formula's RESULT, which is what the person is looking at. A raw
    // row read would have exported the two numbers and not the column they came
    // to the database for.
    expect(lines[1]).toContain('"30"');
    // The spreadsheet-injection guard is core's `csvField`, and this is the
    // assertion that it is still on the path a file actually leaves by.
    expect(lines[2]!.startsWith('"\'=DANGER()"')).toBe(true);
  });

  it("a page is not offered CSV, and the refusal names what it CAN be written as", async () => {
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{
          idempotencyKey: "op-page", itemId: "page_1", kind: "create",
          at: { physical: 1000, logical: 0, deviceId: "device-a" },
          payload: { kind: "page", text: "Runbook", rank: "m" },
        }],
      }),
    });

    const refused = await fetch(`${baseUrl}/api/notes/blocks/page_1/export?format=csv`, { headers });
    expect(refused.status).toBe(400);
    const body = await refused.json();
    // F1 — an offer the product cannot honour is worse than an absence, so the
    // refusal is the thing a menu builds itself from.
    expect(body.formats).toEqual(["markdown"]);

    const nonsense = await fetch(`${baseUrl}/api/notes/blocks/page_1/export?format=pdf`, { headers });
    expect(nonsense.status).toBe(400);

    const missing = await fetch(`${baseUrl}/api/notes/blocks/blk_nope/export?format=markdown`, { headers });
    expect(missing.status).toBe(404);
  });

  it("the page read tells a menu which formats to offer, so the menu never guesses", async () => {
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [
          {
            idempotencyKey: "op-page", itemId: "page_1", kind: "create",
            at: { physical: 1000, logical: 0, deviceId: "device-a" },
            payload: { kind: "page", text: "Runbook", rank: "m" },
          },
          {
            idempotencyKey: "op-db", itemId: "db_1", kind: "create",
            at: { physical: 1001, logical: 0, deviceId: "device-a" },
            payload: {
              kind: "database", text: "Orders", rank: "n",
              schema: [{ id: "title", name: "Name", type: "title" }],
              views: [{ id: "table", name: "Table", kind: "table" }],
            },
          },
        ],
      }),
    });

    const page = await (await fetch(`${baseUrl}/api/notes/pages/page_1`, { headers })).json();
    expect(page.exportFormats).toEqual(["markdown"]);
    const database = await (await fetch(`${baseUrl}/api/notes/databases/db_1`, { headers })).json();
    expect(database.exportFormats).toEqual(["markdown", "csv"]);
  });

  it("an export longer than the cap stops and SAYS it stopped, in the file and in the headers", async () => {
    const at = { physical: 1000, logical: 0, deviceId: "device-a" };
    const seed = (id: string, over: { kind?: string; text?: string; parentId?: string | null; rank?: string }) => {
      db.blocks.set(key("org-a", "user-1", id), {
        parentId: over.parentId ?? null,
        kind: over.kind ?? "paragraph",
        visibility: "private",
        deletedAtHlc: null,
        payload: {
          id,
          parentId: { value: over.parentId ?? null, at },
          rank: { value: over.rank ?? "m", at },
          kind: { value: over.kind ?? "paragraph", at },
          text: { value: over.text ?? "", at },
        },
      });
    };
    // Seeded rather than pushed: a push carries 200 operations, and the point of
    // this test is the page nobody meant to make.
    seed("page_big", { kind: "page", text: "Everything" });
    for (let i = 0; i < 2_100; i += 1) {
      seed(`blk_${i}`, { text: `line ${i}`, parentId: "page_big", rank: `m${String(i).padStart(5, "0")}` });
    }

    const res = await fetch(`${baseUrl}/api/notes/blocks/page_big/export?format=markdown`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-brainrouter-export-truncated")).toBe("1");
    expect(res.headers.get("x-brainrouter-export-omissions")).toContain("bounded");
    // And in the document itself, because the person who opens the backup a year
    // from now has the file and not the headers.
    const body = await res.text();
    expect(body).toContain("longer than an export carries");
    expect(body).not.toContain("line 2099");
  });

  /**
   * A4, in the one place an export can reach past the person doing it.
   *
   * A synced block stores an ADDRESS, so exporting a page containing one is the
   * moment the server decides whether the viewer may read the block on the other
   * end. Rendering the title would leak it; rendering nothing would make the
   * same document look different to two people with no indication why.
   */
  it("a synced block pointing at someone else's private block exports as the refusal, never as its words", async () => {
    const stamp = { physical: 1, logical: 0, deviceId: "d" };
    db.blocks.set("org-a/user-2/blk_private", {
      parentId: null, kind: "paragraph", visibility: "private", deletedAtHlc: null,
      payload: {
        id: "blk_private",
        parentId: { value: null, at: stamp },
        rank: { value: "m", at: stamp },
        kind: { value: "paragraph", at: stamp },
        text: { value: "the secret roadmap", at: stamp },
      },
    });

    const at = (physical: number) => ({ physical, logical: 0, deviceId: "device-a" });
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [
          { idempotencyKey: "op-page", itemId: "page_1", kind: "create", at: at(1000), payload: { kind: "page", text: "Plan", rank: "m" } },
          {
            idempotencyKey: "op-sync", itemId: "blk_mirror", kind: "create", at: at(1001),
            payload: { kind: "synced", text: "brainrouter://notes/block/blk_private", parentId: "page_1", rank: "m" },
          },
        ],
      }),
    });

    const res = await fetch(`${baseUrl}/api/notes/blocks/page_1/export?format=markdown`, { headers });
    const body = await res.text();
    expect(body).toContain("do not have access");
    expect(body).not.toContain("secret roadmap");
    expect(res.headers.get("x-brainrouter-export-omissions")).toContain("permission");
  });

  /* -------------------------------------------------------- F3 · comments */

  /**
   * The claim under every one of these is B3's: a comment is CONTENT, so it
   * syncs, so it goes through the one push path. The test for that is not that
   * the endpoint returns 201 — it is that the remark is in the BLOCK's record
   * afterwards, which is the only place the merge could have put it.
   */
  it("a comment written over HTTP lands on the block record, through the same push path a block edit takes", async () => {
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{
          idempotencyKey: "op-1", itemId: "blk_1", kind: "create",
          at: { physical: 1000, logical: 0, deviceId: "device-a" },
          payload: { text: "revenue was 4.1m", rank: "m" },
        }],
      }),
    });

    const written = await fetch(`${baseUrl}/api/notes/blocks/blk_1/comments`, {
      method: "POST", headers, body: JSON.stringify({ body: "is this the gross figure?", author: "Ada" }),
    });
    expect(written.status).toBe(201);
    const { comment } = await written.json();
    expect(comment.body.value).toBe("is this the gross figure?");
    expect(comment.author).toBe("Ada");
    expect(comment.resolved.value).toBe(false);

    const block = (await (await fetch(`${baseUrl}/api/notes/blocks/blk_1`, { headers })).json()).block;
    expect(Object.keys(block.comments)).toEqual([comment.id]);

    const thread = await (await fetch(`${baseUrl}/api/notes/blocks/blk_1/comments`, { headers })).json();
    expect(thread.comments.map((c: { id: string }) => c.id)).toEqual([comment.id]);
    expect(thread.blockDeleted).toBe(false);
  });

  it("resolving a comment is a stamped field that merges, and an unknown comment is refused by name", async () => {
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{
          idempotencyKey: "op-1", itemId: "blk_1", kind: "create",
          at: { physical: 1000, logical: 0, deviceId: "device-a" },
          payload: { text: "waiting on the API", rank: "m" },
        }],
      }),
    });
    const { comment } = await (await fetch(`${baseUrl}/api/notes/blocks/blk_1/comments`, {
      method: "POST", headers, body: JSON.stringify({ body: "shipped now" }),
    })).json();

    const res = await fetch(`${baseUrl}/api/notes/blocks/blk_1/comments/${comment.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ resolved: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).comment.resolved.value).toBe(true);

    const missing = await fetch(`${baseUrl}/api/notes/blocks/blk_1/comments/cmt_nope`, {
      method: "PATCH", headers, body: JSON.stringify({ resolved: true }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("No such comment.");
  });

  /**
   * C5 — deleting the target of a link never deletes the link.
   *
   * "Why did this go?" is a question people ask about a block exactly after it
   * disappears, and a 404 here would make the remark unreachable at the one
   * moment somebody goes looking for it.
   */
  it("a comment on a deleted block is still readable, and the answer says the block is gone", async () => {
    const at = (physical: number) => ({ physical, logical: 0, deviceId: "device-a" });
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{ idempotencyKey: "op-1", itemId: "blk_1", kind: "create", at: at(1000), payload: { text: "the old plan", rank: "m" } }],
      }),
    });
    await fetch(`${baseUrl}/api/notes/blocks/blk_1/comments`, {
      method: "POST", headers, body: JSON.stringify({ body: "why did this go?" }),
    });
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{ idempotencyKey: "op-del", itemId: "blk_1", kind: "delete", at: at(3000), payload: {} }],
      }),
    });

    const res = await fetch(`${baseUrl}/api/notes/blocks/blk_1/comments`, { headers });
    expect(res.status).toBe(200);
    const thread = await res.json();
    expect(thread.blockDeleted).toBe(true);
    expect(typeof thread.blockDeletedAt).toBe("string");
    expect(thread.comments).toHaveLength(1);
  });

  it("a comment with nothing to say, and a comment on a block that is not there, are refused separately", async () => {
    await fetch(`${baseUrl}/api/notes/push`, {
      method: "POST", headers,
      body: JSON.stringify({
        operations: [{
          idempotencyKey: "op-1", itemId: "blk_1", kind: "create",
          at: { physical: 1000, logical: 0, deviceId: "device-a" }, payload: { text: "x", rank: "m" },
        }],
      }),
    });

    const empty = await fetch(`${baseUrl}/api/notes/blocks/blk_1/comments`, {
      method: "POST", headers, body: JSON.stringify({ body: "   " }),
    });
    expect(empty.status).toBe(400);

    const nowhere = await fetch(`${baseUrl}/api/notes/blocks/blk_missing/comments`, {
      method: "POST", headers, body: JSON.stringify({ body: "hello" }),
    });
    expect(nowhere.status).toBe(404);
    expect((await nowhere.json()).error).toBe("No such block.");

    const unread = await fetch(`${baseUrl}/api/notes/blocks/blk_missing/comments`, { headers });
    expect(unread.status).toBe(404);
  });

  it("neither new surface answers without authentication", async () => {
    const exported = await fetch(`${baseUrl}/api/notes/blocks/blk_1/export?format=markdown`);
    expect(exported.status).toBe(401);
    const read = await fetch(`${baseUrl}/api/notes/blocks/blk_1/comments`);
    expect(read.status).toBe(401);
  });

  it("the routers are mounted on the app, which is the difference between built and reachable", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const index = fs.readFileSync(path.join(here, "..", "index.ts"), "utf8");
    expect(index).toContain('app.use("/api/notes", notesRouter)');
    expect(index).toContain('app.use("/api/workspace", workspaceRouter)');
  });

  /**
   * ADR-028 E1 turned from a review habit into a check that runs.
   *
   * Part F shipped `exportFormats` here — a second, unreachable answer to a
   * question the page and database reads already carry a field for — and every
   * gate stayed green, because nothing about dead code fails a compile or a
   * suite. It was caught by somebody reading the diff, which is exactly the
   * mechanism E1 exists because we cannot rely on.
   *
   * Only functions are audited. An exported type is consumed by inference at
   * the call site as often as by name, so requiring one to be spelled out would
   * fail honest code; a function with no caller is dead by definition.
   *
   * The search is deliberately alias-qualified rather than a bare word search.
   * `exportFormats` is ALSO a field on the read shapes, so grepping the name
   * across the workspace finds `page.exportFormats` in this very file and calls
   * the dead function reachable — a check that passes on the defect it exists
   * for is worse than no check.
   */
  it("every function the notes backend exports is reached by something", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcDir = path.join(here, "..");
    const backendPath = path.join(srcDir, "memory", "notes", "backend.ts");
    const backend = fs.readFileSync(backendPath, "utf8");

    const exported = [...backend.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!);
    // A guard on the guard: a rename that breaks the pattern would otherwise
    // make this pass by auditing nothing at all.
    expect(exported.length, "no exported functions found — this audit has stopped auditing").toBeGreaterThan(5);

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && full !== backendPath) files.push(full);
      }
    };
    walk(srcDir);

    // Whatever each consumer binds the module to — `import * as notes` today,
    // and a dynamic `const notes = await import(...)` in the merge suite.
    const callers = new Set<string>();
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("notes/backend.js")) continue;
      const bindings = [
        ...source.matchAll(/import \* as (\w+) from "[^"]*notes\/backend\.js"/g),
        ...source.matchAll(/(?:const|let|var) (\w+) = await import\("[^"]*notes\/backend\.js"\)/g),
      ].map((m) => m[1]!);
      for (const binding of bindings) {
        for (const use of source.matchAll(new RegExp(`\\b${binding}\\.(\\w+)`, "g"))) callers.add(use[1]!);
      }
    }
    expect(callers.size, "no consumer of the notes backend was found — the import shape has changed").toBeGreaterThan(5);

    /**
     * The one gap this audit inherited, named instead of hidden.
     *
     * `unreferencedAttachments` (backend.ts) is a thin wrapper over
     * `listUnreferencedNoteAttachments`, which the store suite drives directly —
     * so the query is covered and the wrapper is the dead link. It arrived with
     * the attachments work, not with this audit, and deleting another slice's
     * symbol is that slice's call to make: either the byte sweep it was written
     * as the input to gets built, or the wrapper goes and the sweep calls the
     * store method the store tests already use.
     *
     * Asserted in BOTH directions on purpose. An exemption that only ever
     * suppresses a failure rots into a permanent hole; this one fails the moment
     * the symbol gains a caller and tells you to delete the exemption. Adding a
     * name here is not how a new violation gets resolved — it is a visible edit
     * to a list that says so.
     */
    const KNOWN_UNREACHED = new Set<string>(["unreferencedAttachments"]);

    for (const name of exported) {
      if (KNOWN_UNREACHED.has(name)) {
        expect(
          callers.has(name),
          `\`${name}\` is listed as a known-unreached export and now has a caller. `
          + "Remove it from KNOWN_UNREACHED so the audit goes back to enforcing it.",
        ).toBe(false);
        continue;
      }
      expect(
        callers.has(name),
        `notes/backend.ts exports \`${name}\` and nothing in this workspace calls it. `
        + "ADR-028 E1: a module with no caller is not done. Either give it the caller it was "
        + "written for, or delete it — an unreachable second answer is how two answers drift apart.",
      ).toBe(true);
    }
  });

  /**
   * Mounted is not reached either.
   *
   * ADR-028 E1: these three answered correctly for a release with nothing in
   * any surface asking them. The dashboard is the surface they were built for —
   * it is the one with no local store — so the claim is checked where it can
   * actually fail, at its source.
   */
  it("the dashboard asks for the favourites, the databases and the shared update verb", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dashboardNotes = ["page.tsx", "useDashboardNotes.ts", "notesAdapter.ts"]
      .map((file) => fs.readFileSync(
        path.join(here, "..", "..", "..", "brainrouter-dashboard", "app", "notes", file),
        "utf8",
      )).join("\n");
    // Ordered by rank on the server, and a favourite is any block — filtering
    // the page list here would show them in document order and miss the lines.
    expect(dashboardNotes).toContain('"/api/notes/favourites"');
    expect(dashboardNotes).toContain('/api/notes/databases/');
    expect(dashboardNotes).toContain('"/api/notes/mutate"');
    expect(dashboardNotes).toContain('queueBlockUpdate(id, { favourite })');
  });

  /**
   * The same claim for Part F's two: a route with no caller is not done.
   *
   * F3's export and comments answered nothing before this — core had the writers
   * and the comment model, the dashboard offered neither. These pin the calls at
   * their source so the pair cannot go back to being reachable only by curl.
   */
  it("the dashboard downloads the export and reads and writes the thread", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dashboardNotes = ["page.tsx", "useDashboardNotes.ts", "notesAdapter.ts"]
      .map((file) => fs.readFileSync(
        path.join(here, "..", "..", "..", "brainrouter-dashboard", "app", "notes", file),
        "utf8",
      )).join("\n");
    expect(dashboardNotes).toContain("/export?");
    // The formats come from the server's read, never from the block's kind —
    // F1's rule is that the menu must not offer what the writer cannot honour.
    expect(dashboardNotes).toContain("exportPage:");
    expect(dashboardNotes).toContain('type: "comment.add"');
    // The claim is that the dashboard resolves a thread over the route, not how
    // the flag reaches the call: both surfaces that leave a remark now go
    // through one `setCommentResolved`, so the value is a shorthand rather than
    // an inline literal. `notes-dashboard-renderers.test.ts` pins that helper.
    expect(dashboardNotes).toContain('type: "comment.resolve"');
  });
});
