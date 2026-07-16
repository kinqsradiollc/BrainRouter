import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listChatThreads: vi.fn(),
  createChatThread: vi.fn(),
  getChatThread: vi.fn(),
  countChatThreads: vi.fn(),
  appendChatMessage: vi.fn(),
  renameChatThread: vi.fn(),
  deleteChatThread: vi.fn(),
  replaceChatMessages: vi.fn(),
  getMemberRole: vi.fn(),
  getDefaultOrgId: vi.fn(),
  ensurePersonalOrg: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) =>
      key === "br_user" ? { userId: "user-1", isAdmin: false, email: "user@example.test" } : null),
    getUserById: mocks.getUserById,
    tenancy: {
      getMemberRole: mocks.getMemberRole,
      getDefaultOrgId: mocks.getDefaultOrgId,
      ensurePersonalOrg: mocks.ensurePersonalOrg,
    },
    store: {
      listChatThreads: mocks.listChatThreads,
      createChatThread: mocks.createChatThread,
      getChatThread: mocks.getChatThread,
      countChatThreads: mocks.countChatThreads,
      appendChatMessage: mocks.appendChatMessage,
      renameChatThread: mocks.renameChatThread,
      deleteChatThread: mocks.deleteChatThread,
      replaceChatMessages: mocks.replaceChatMessages,
    },
  },
}));

import { chatThreadsRouter } from "../api/routes/chatThreads.js";

function thread(id: string, userId = "user-1", orgId = "org-a") {
  return { id, orgId, userId, title: "Hello", model: null, createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z" };
}
function withMsgs(id: string, userId = "user-1") {
  return { ...thread(id, userId), messages: [] };
}

describe("chat-threads route — owner guard + CRUD wiring", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-a");
    mocks.getUserById.mockImplementation(async (userId: string) => ({ userId, isAdmin: false, status: "active" }));
    // user-1 belongs to org-a only.
    mocks.getMemberRole.mockImplementation(async (orgId: string, userId: string) =>
      userId === "user-1" && orgId === "org-a" ? "admin" : null);
    mocks.ensurePersonalOrg.mockResolvedValue({ orgId: "org-a" });

    mocks.listChatThreads.mockResolvedValue([thread("ct_1")]);
    mocks.countChatThreads.mockResolvedValue(0);
    mocks.createChatThread.mockImplementation(async (input: Record<string, unknown>) => thread(String(input.id), String(input.userId), String(input.orgId)));
    mocks.replaceChatMessages.mockResolvedValue(null);
    // Owner-guarded store: only returns a thread when the OWNER (user-1) asks.
    mocks.getChatThread.mockImplementation(async (_org: string, userId: string, id: string) =>
      userId === "user-1" && id === "ct_1" ? withMsgs(id) : null);
    mocks.appendChatMessage.mockImplementation(async (_org: string, userId: string, threadId: string) =>
      userId === "user-1" && threadId === "ct_1" ? { id: "cm_1", threadId, ordinal: 0, role: "user", content: "hi", createdAt: "2026-07-16T00:00:00.000Z" } : null);
    mocks.renameChatThread.mockImplementation(async (_org: string, userId: string, id: string, title: string) =>
      userId === "user-1" && id === "ct_1" ? { ...thread(id), title } : null);
    mocks.deleteChatThread.mockImplementation(async (_org: string, userId: string, id: string) => userId === "user-1" && id === "ct_1");

    const app = express();
    app.use(express.json());
    app.use("/api/chat/threads", chatThreadsRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  });
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = undefined; });

  const headers = (orgId = "org-a") => ({ Authorization: "Bearer br_user", "Content-Type": "application/json", "X-BrainRouter-Org": orgId });

  it("lists my threads scoped to org + user", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads`, { headers: headers() });
    expect(res.status).toBe(200);
    expect((await res.json()).threads).toHaveLength(1);
    expect(mocks.listChatThreads).toHaveBeenCalledWith("org-a", "user-1");
  });

  it("creates a thread scoped to the caller's org + user", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads`, { method: "POST", headers: headers(), body: JSON.stringify({ title: "New" }) });
    expect(res.status).toBe(201);
    expect(mocks.createChatThread.mock.calls[0]![0].orgId).toBe("org-a");
    expect(mocks.createChatThread.mock.calls[0]![0].userId).toBe("user-1");
  });

  it("fetches a thread with messages for its owner", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads/ct_1`, { headers: headers() });
    expect(res.status).toBe(200);
    expect((await res.json()).thread.id).toBe("ct_1");
    expect(mocks.getChatThread).toHaveBeenCalledWith("org-a", "user-1", "ct_1");
  });

  it("404s a thread the caller does not own (cross-user isolation, same org)", async () => {
    // ct_other belongs to another user; owner-guarded store returns null → 404.
    const res = await fetch(`${baseUrl}/api/chat/threads/ct_other`, { headers: headers() });
    expect(res.status).toBe(404);
  });

  it("appends a message, server-assigned ordinal", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads/ct_1/messages`, { method: "POST", headers: headers(), body: JSON.stringify({ role: "user", content: "hi" }) });
    expect(res.status).toBe(201);
    expect((await res.json()).message.ordinal).toBe(0);
    expect(mocks.appendChatMessage).toHaveBeenCalledWith("org-a", "user-1", "ct_1", expect.objectContaining({ role: "user", content: "hi" }));
  });

  it("404s an append to a non-owned thread", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads/ct_other/messages`, { method: "POST", headers: headers(), body: JSON.stringify({ content: "x" }) });
    expect(res.status).toBe(404);
  });

  it("rejects an append with no content (400)", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads/ct_1/messages`, { method: "POST", headers: headers(), body: JSON.stringify({ role: "user" }) });
    expect(res.status).toBe(400);
    expect(mocks.appendChatMessage).not.toHaveBeenCalled();
  });

  it("renames a thread", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads/ct_1`, { method: "PUT", headers: headers(), body: JSON.stringify({ title: "Renamed" }) });
    expect(res.status).toBe(200);
    expect((await res.json()).thread.title).toBe("Renamed");
  });

  it("replaces (syncs) a thread's whole message history", async () => {
    mocks.replaceChatMessages.mockResolvedValueOnce({ ...withMsgs("ct_1"), messages: [{ id: "cm_1", threadId: "ct_1", ordinal: 0, role: "user", content: "a", createdAt: "2026-07-16T00:00:00.000Z" }] });
    const res = await fetch(`${baseUrl}/api/chat/threads/ct_1/messages`, { method: "PUT", headers: headers(), body: JSON.stringify({ messages: [{ role: "user", content: "a" }] }) });
    expect(res.status).toBe(200);
    expect(mocks.replaceChatMessages).toHaveBeenCalledWith("org-a", "user-1", "ct_1", expect.any(Array));
  });

  it("rejects a replace whose body is not an array (400)", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads/ct_1/messages`, { method: "PUT", headers: headers(), body: JSON.stringify({ messages: "nope" }) });
    expect(res.status).toBe(400);
  });

  it("deletes a thread the caller owns", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads/ct_1`, { method: "DELETE", headers: headers() });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(mocks.deleteChatThread).toHaveBeenCalledWith("org-a", "user-1", "ct_1");
  });

  it("blocks access to an org the caller is not a member of (403)", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads`, { headers: headers("org-b") });
    expect(res.status).toBe(403);
    expect(mocks.listChatThreads).not.toHaveBeenCalled();
  });
});
