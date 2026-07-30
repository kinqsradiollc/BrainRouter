import { describe, expect, it, vi } from "vitest";
import {
  createThread, listThreads, getThread, threadCount, appendMessage,
  renameThread, deleteThread, replaceMessages,
} from "./chatThreadsQueries.js";

const threadRow = {
  id: "ct_1", org_id: "org-1", user_id: "user-1", title: "Hello", model: "gpt",
  created_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z",
};
const msgRow = { id: "cm_1", thread_id: "ct_1", ordinal: 0, role: "user", content: "hi", created_at: "2026-07-16T00:00:00.000Z" };

function executor(one: Record<string, unknown> | null = threadRow, rows: Record<string, unknown>[] = [threadRow]) {
  return {
    one: vi.fn(async () => one),
    rows: vi.fn(async () => rows),
    run: vi.fn(async () => 1),
    tx: vi.fn(),
  } as any;
}

describe("chat-threads queries — owner + org scoping", () => {
  it("creates a thread returning the mapped row", async () => {
    const exec = executor();
    const t = await createThread(exec, { id: "ct_1", orgId: "org-1", userId: "user-1", title: "Hello", model: "gpt" });
    const [sql, params] = exec.one.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO chat_threads");
    expect(params).toEqual(["ct_1", "org-1", "user-1", "Hello", "gpt"]);
    expect(t).toMatchObject({ id: "ct_1", orgId: "org-1", userId: "user-1", title: "Hello", model: "gpt" });
  });

  it("lists threads scoped to BOTH org and user, newest first", async () => {
    const exec = executor(threadRow, [threadRow]);
    await listThreads(exec, "org-1", "user-1");
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("WHERE org_id = $1 AND user_id = $2");
    expect(sql).toContain("ORDER BY updated_at DESC");
    expect(params).toEqual(["org-1", "user-1", 500]);
  });

  it("getThread is owner-guarded (org + user) and returns messages in order", async () => {
    const exec = executor(threadRow, [msgRow]);
    const t = await getThread(exec, "org-1", "user-1", "ct_1");
    const [sql, params] = exec.one.mock.calls[0]!;
    expect(sql).toContain("WHERE org_id = $1 AND user_id = $2 AND id = $3");
    expect(params).toEqual(["org-1", "user-1", "ct_1"]);
    const [msgSql, msgParams] = exec.rows.mock.calls[0]!;
    expect(msgSql).toContain("FROM chat_messages WHERE thread_id = $1 ORDER BY ordinal ASC");
    expect(msgParams).toEqual(["ct_1"]);
    expect(t!.messages[0]).toMatchObject({ id: "cm_1", role: "user", content: "hi", ordinal: 0 });
  });

  it("getThread returns null (no cross-owner read) when the guard matches nothing", async () => {
    const exec = executor(null);
    await expect(getThread(exec, "org-2", "user-2", "ct_1")).resolves.toBeNull();
    expect(exec.rows).not.toHaveBeenCalled();
  });

  it("threadCount is scoped to org + user", async () => {
    const exec = executor({ n: 3 });
    const n = await threadCount(exec, "org-1", "user-1");
    const [sql, params] = exec.one.mock.calls[0]!;
    expect(sql).toContain("COUNT(*)::int");
    expect(sql).toContain("WHERE org_id = $1 AND user_id = $2");
    expect(params).toEqual(["org-1", "user-1"]);
    expect(n).toBe(3);
  });

  it("appendMessage verifies ownership then inserts with server-assigned ordinal", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })          // ownership check
      .mockResolvedValueOnce({ rowCount: 1, rows: [msgRow] })    // insert
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });         // updated_at bump
    const exec = { tx: vi.fn(async (fn: any) => fn({ query })) } as any;
    const m = await appendMessage(exec, "org-1", "user-1", "ct_1", { id: "cm_1", role: "user", content: "hi" });
    const ownSql = query.mock.calls[0]![0] as string;
    expect(ownSql).toContain("FROM chat_threads WHERE org_id = $1 AND user_id = $2 AND id = $3");
    const insSql = query.mock.calls[1]![0] as string;
    expect(insSql).toContain("COALESCE(MAX(ordinal), -1) + 1");
    expect(m).toMatchObject({ id: "cm_1", ordinal: 0, role: "user" });
  });

  it("appendMessage returns null when the caller does not own the thread", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const exec = { tx: vi.fn(async (fn: any) => fn({ query })) } as any;
    await expect(appendMessage(exec, "org-2", "user-2", "ct_1", { id: "cm_x", role: "user", content: "hi" })).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("renameThread is owner-guarded and updates the title", async () => {
    const exec = executor();
    await renameThread(exec, "org-1", "user-1", "ct_1", "Renamed");
    const [sql, params] = exec.one.mock.calls[0]!;
    expect(sql).toContain("UPDATE chat_threads SET title = $4");
    expect(sql).toContain("WHERE org_id = $1 AND user_id = $2 AND id = $3");
    expect(params).toEqual(["org-1", "user-1", "ct_1", "Renamed"]);
  });

  it("deleteThread checks ownership then removes messages + thread in a tx", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })  // owned
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })  // delete messages
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // delete thread
    const exec = { tx: vi.fn(async (fn: any) => fn({ query })) } as any;
    await expect(deleteThread(exec, "org-1", "user-1", "ct_1")).resolves.toBe(true);
    expect(query.mock.calls[0]![0]).toContain("WHERE org_id = $1 AND user_id = $2 AND id = $3");
  });

  it("deleteThread returns false (touches nothing) when not owned", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const exec = { tx: vi.fn(async (fn: any) => fn({ query })) } as any;
    await expect(deleteThread(exec, "org-2", "user-2", "ct_1")).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("replaceMessages re-numbers messages 0..n after an owner check", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [threadRow] })  // owned
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })            // delete
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })            // insert 0
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })            // insert 1
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })            // updated_at
      .mockResolvedValueOnce({ rowCount: 2, rows: [msgRow, { ...msgRow, id: "cm_2", ordinal: 1 }] }); // read back
    const exec = { tx: vi.fn(async (fn: any) => fn({ query })) } as any;
    const t = await replaceMessages(exec, "org-1", "user-1", "ct_1", [
      { id: "cm_1", role: "user", content: "a" },
      { id: "cm_2", role: "assistant", content: "b" },
    ]);
    expect(query.mock.calls[0]![0]).toContain("WHERE org_id = $1 AND user_id = $2 AND id = $3");
    // second insert carries ordinal 1
    expect(query.mock.calls[3]![1]).toEqual(["cm_2", "ct_1", 1, "assistant", "b"]);
    expect(t!.messages).toHaveLength(2);
  });

  it("replaceMessages returns null when not owned", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const exec = { tx: vi.fn(async (fn: any) => fn({ query })) } as any;
    await expect(replaceMessages(exec, "org-2", "user-2", "ct_1", [])).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
