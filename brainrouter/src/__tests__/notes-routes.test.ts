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
  applied: new Set<string>(),
  index: new Map<string, { contentText: string; refKeys: string[] }>(),
  refs: new Map<string, unknown[]>(),
  leases: new Map<string, { blockId: string; deviceId: string; holder: string | null; epoch: number; expiresAtMs: number }>(),
  // ADR-029 Part E (migration 053) — the projections the page and database
  // routes read. Written by the same re-derive call as `index`.
  pageMeta: new Map<string, Record<string, unknown>>(),
  rowValues: new Map<string, unknown[]>(),
};
const key = (orgId: string, userId: string, id: string) => `${orgId}/${userId}/${id}`;

const fakeStore = {
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
  async recordNoteOperationApplied(orgId: string, userId: string, k: string) { db.applied.add(`${orgId}/${userId}/${k}`); },
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

  beforeEach(async () => {
    db.blocks.clear(); db.applied.clear(); db.index.clear(); db.refs.clear(); db.leases.clear();
    db.pageMeta.clear(); db.rowValues.clear();
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
    expect(body.reason).toBe("no_such_mode");
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
    // The backend has no checkout, so `code` is not registered at all here —
    // which is a different sentence from "code is linkable but not writable",
    // and both are more useful than a 500.
    expect((await res.json()).reason).toBe("no_such_mode");
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
    const notesPage = fs.readFileSync(
      path.join(here, "..", "..", "..", "brainrouter-dashboard", "app", "notes", "page.tsx"),
      "utf8",
    );
    // Ordered by rank on the server, and a favourite is any block — filtering
    // the page list here would show them in document order and miss the lines.
    expect(notesPage).toContain('"/api/notes/favourites"');
    expect(notesPage).toContain('"/api/notes/databases"');
    expect(notesPage).toContain('"/api/workspace/update"');
    expect(notesPage).toContain('fields: { favourite }');
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
    const notesPage = fs.readFileSync(
      path.join(here, "..", "..", "..", "brainrouter-dashboard", "app", "notes", "page.tsx"),
      "utf8",
    );
    expect(notesPage).toContain("/export?");
    // The formats come from the server's read, never from the block's kind —
    // F1's rule is that the menu must not offer what the writer cannot honour.
    expect(notesPage).toContain("exportFormats");
    expect(notesPage).toContain("/comments");
    // The claim is that the dashboard resolves a thread over the route, not how
    // the flag reaches the call: both surfaces that leave a remark now go
    // through one `setCommentResolved`, so the value is a shorthand rather than
    // an inline literal. `notes-dashboard-renderers.test.ts` pins that helper.
    expect(notesPage).toMatch(/method: "PATCH", body: \{ resolved/);
  });
});
