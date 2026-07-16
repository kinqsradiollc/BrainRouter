/**
 * Chat-thread persistence (migration 036). Chat history used to live ONLY in each
 * client's local storage (dashboard localStorage, desktop + CLI local files), so a
 * conversation was invisible on the other surfaces. This is the shared server home a
 * later change can repoint the clients to. A thread is PERSONAL — private to its owning
 * user within the org — so EVERY query is keyed by both `org_id` and `user_id`; no other
 * member (even in the same org) can read or mutate someone else's threads. Exposed via
 * thin PostgresMemoryStore methods, consumed by memory/chat/backend.ts.
 */
import type { Executor } from "./executor.js";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatThreadRow {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRow {
  id: string;
  threadId: string;
  ordinal: number;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface ChatThreadWithMessages extends ChatThreadRow {
  messages: ChatMessageRow[];
}

export interface CreateChatThreadInput {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  model?: string | null;
}

export interface AppendChatMessageInput {
  id: string;
  role: ChatRole;
  content: string;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}
function asRole(value: unknown): ChatRole {
  return value === "assistant" || value === "system" || value === "tool" ? value : "user";
}

function mapThread(r: Record<string, unknown>): ChatThreadRow {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    userId: String(r.user_id),
    title: String(r.title ?? ""),
    model: r.model == null ? null : String(r.model),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function mapMessage(r: Record<string, unknown>): ChatMessageRow {
  return {
    id: String(r.id),
    threadId: String(r.thread_id),
    ordinal: Number(r.ordinal ?? 0),
    role: asRole(r.role),
    content: String(r.content ?? ""),
    createdAt: iso(r.created_at),
  };
}

const THREAD_COLS = `id, org_id, user_id, title, model, created_at, updated_at`;
const MSG_COLS = `id, thread_id, ordinal, role, content, created_at`;

export async function createThread(exec: Executor, input: CreateChatThreadInput): Promise<ChatThreadRow> {
  const row = await exec.one<Record<string, unknown>>(
    `INSERT INTO chat_threads (id, org_id, user_id, title, model)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING ${THREAD_COLS}`,
    [input.id, input.orgId, input.userId, input.title, input.model ?? null],
  );
  return mapThread(row!);
}

/** A single user's threads within an org, most-recently-touched first. */
export async function listThreads(exec: Executor, orgId: string, userId: string, limit = 500): Promise<ChatThreadRow[]> {
  const capped = Math.min(Math.max(limit, 1), 1000);
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT ${THREAD_COLS} FROM chat_threads
      WHERE org_id = $1 AND user_id = $2
      ORDER BY updated_at DESC, id DESC LIMIT $3`,
    [orgId, userId, capped],
  );
  return rows.map(mapThread);
}

/** A thread (owner-guarded by org + user) with its messages in order, or null. */
export async function getThread(exec: Executor, orgId: string, userId: string, id: string): Promise<ChatThreadWithMessages | null> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT ${THREAD_COLS} FROM chat_threads WHERE org_id = $1 AND user_id = $2 AND id = $3`,
    [orgId, userId, id],
  );
  if (!row) return null;
  const thread = mapThread(row);
  const msgs = await exec.rows<Record<string, unknown>>(
    `SELECT ${MSG_COLS} FROM chat_messages WHERE thread_id = $1 ORDER BY ordinal ASC`,
    [thread.id],
  );
  return { ...thread, messages: msgs.map(mapMessage) };
}

export function threadCount(exec: Executor, orgId: string, userId: string): Promise<number> {
  return exec.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM chat_threads WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  ).then((r) => Number(r?.n ?? 0));
}

/**
 * Append a message to a thread the caller owns; the server assigns the next ordinal
 * (MAX(ordinal)+1) atomically and bumps the thread's `updated_at`. The owner guard on
 * chat_threads means a wrong org/user simply matches no thread → returns null.
 */
export async function appendMessage(exec: Executor, orgId: string, userId: string, threadId: string, msg: AppendChatMessageInput): Promise<ChatMessageRow | null> {
  return exec.tx(async (client) => {
    const owns = await client.query(
      `SELECT 1 FROM chat_threads WHERE org_id = $1 AND user_id = $2 AND id = $3`,
      [orgId, userId, threadId],
    );
    if (owns.rowCount === 0) return null;
    const inserted = await client.query(
      `INSERT INTO chat_messages (id, thread_id, ordinal, role, content)
       VALUES ($1, $2,
               (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM chat_messages WHERE thread_id = $2),
               $3, $4)
       RETURNING ${MSG_COLS}`,
      [msg.id, threadId, msg.role, msg.content],
    );
    await client.query(`UPDATE chat_threads SET updated_at = now() WHERE id = $1`, [threadId]);
    return mapMessage(inserted.rows[0] as Record<string, unknown>);
  });
}

export async function renameThread(exec: Executor, orgId: string, userId: string, id: string, title: string, model?: string | null): Promise<ChatThreadRow | null> {
  const sets: string[] = ["title = $4"];
  const params: unknown[] = [orgId, userId, id, title];
  if (model !== undefined) { params.push(model); sets.push(`model = $${params.length}`); }
  const row = await exec.one<Record<string, unknown>>(
    `UPDATE chat_threads SET ${sets.join(", ")}, updated_at = now()
      WHERE org_id = $1 AND user_id = $2 AND id = $3
      RETURNING ${THREAD_COLS}`,
    params,
  );
  return row ? mapThread(row) : null;
}

export async function deleteThread(exec: Executor, orgId: string, userId: string, id: string): Promise<boolean> {
  return exec.tx(async (client) => {
    const owned = await client.query(
      `SELECT 1 FROM chat_threads WHERE org_id = $1 AND user_id = $2 AND id = $3`,
      [orgId, userId, id],
    );
    if (owned.rowCount === 0) return false;
    await client.query(`DELETE FROM chat_messages WHERE thread_id = $1`, [id]);
    await client.query(`DELETE FROM chat_threads WHERE id = $1`, [id]);
    return true;
  });
}

/**
 * Replace a thread's entire message history (a client pushing its local history up).
 * Owner-guarded: no matching thread → returns null and touches nothing. Messages are
 * re-numbered 0..n-1 in array order. Runs in one transaction.
 */
export async function replaceMessages(exec: Executor, orgId: string, userId: string, threadId: string, messages: AppendChatMessageInput[]): Promise<ChatThreadWithMessages | null> {
  return exec.tx(async (client) => {
    const owned = await client.query(
      `SELECT ${THREAD_COLS} FROM chat_threads WHERE org_id = $1 AND user_id = $2 AND id = $3`,
      [orgId, userId, threadId],
    );
    if (owned.rowCount === 0) return null;
    await client.query(`DELETE FROM chat_messages WHERE thread_id = $1`, [threadId]);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      await client.query(
        `INSERT INTO chat_messages (id, thread_id, ordinal, role, content) VALUES ($1,$2,$3,$4,$5)`,
        [m.id, threadId, i, m.role, m.content],
      );
    }
    await client.query(`UPDATE chat_threads SET updated_at = now() WHERE id = $1`, [threadId]);
    const thread = mapThread(owned.rows[0] as Record<string, unknown>);
    const msgs = await client.query(
      `SELECT ${MSG_COLS} FROM chat_messages WHERE thread_id = $1 ORDER BY ordinal ASC`,
      [threadId],
    );
    return { ...thread, updatedAt: iso(new Date()), messages: (msgs.rows as Record<string, unknown>[]).map(mapMessage) };
  });
}
