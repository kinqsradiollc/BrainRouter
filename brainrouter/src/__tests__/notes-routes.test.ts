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

  it("the routers are mounted on the app, which is the difference between built and reachable", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const index = fs.readFileSync(path.join(here, "..", "index.ts"), "utf8");
    expect(index).toContain('app.use("/api/notes", notesRouter)');
    expect(index).toContain('app.use("/api/workspace", workspaceRouter)');
  });
});
