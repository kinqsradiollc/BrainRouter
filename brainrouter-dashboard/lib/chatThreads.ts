"use client";

/**
 * Chat-threads client — typed helpers over the server chat-history API
 * (`/api/chat/threads`, brainrouter migration 036). Chat history used to live
 * only in this dashboard's localStorage, so a conversation started here never
 * appeared on a second device. These helpers let `app/chat` treat the server as
 * the source of truth (persist + sync) while keeping localStorage as an offline
 * cache. Every call is owner + org scoped by `authFetch` (JWT/apiKey +
 * `X-BrainRouter-Org`); the caller passes the active org id.
 *
 * This module owns two things:
 *  - the thin network layer (list/create/get/append/rename/replace/delete), and
 *  - the PURE mapping/merge helpers that reconcile the server's lean thread rows
 *    (id/title/model + role/content messages) with the richer local session
 *    cache (scope/category/citations). Keeping the merge pure makes it testable
 *    without a network or a browser.
 */
import { authFetch } from "./adminApi";
import type {
  StoredChatMessage,
  StoredChatRole,
  StoredChatScope,
  StoredChatSession,
} from "../app/chat/chatSessions";

// --- Server wire shapes (see brainrouter chatThreadsQueries.ts) -------------

/** A thread row as returned by the server (no messages on the list endpoint). */
export interface ChatThreadSummary {
  id: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A single persisted message. The server assigns `ordinal` (append order). */
export interface ChatThreadMessage {
  id: string;
  ordinal: number;
  role: string;
  content: string;
  createdAt: string;
}

/** A thread together with its ordered messages (GET/PUT of a single thread). */
export interface ChatThreadDetail extends ChatThreadSummary {
  messages: ChatThreadMessage[];
}

/** The role/content pair the server accepts when creating/syncing messages. */
export interface ChatMessageInput {
  role: StoredChatRole;
  content: string;
}

export interface CreateChatThreadInput {
  title?: string;
  model?: string;
  messages?: ChatMessageInput[];
}

function orgOpts(orgId?: string): { orgId?: string } {
  return orgId ? { orgId } : {};
}

// --- Network layer ----------------------------------------------------------

/** The caller's threads, newest first (no message bodies). */
export async function listChatThreads(orgId?: string): Promise<ChatThreadSummary[]> {
  const res = await authFetch<{ threads?: ChatThreadSummary[] }>("/api/chat/threads", orgOpts(orgId));
  return Array.isArray(res.threads) ? res.threads : [];
}

/** Create a thread, optionally seeded with an initial message history. */
export async function createChatThread(
  input: CreateChatThreadInput,
  orgId?: string,
): Promise<ChatThreadSummary> {
  const res = await authFetch<{ thread: ChatThreadDetail }>("/api/chat/threads", {
    method: "POST",
    body: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.messages ? { messages: input.messages } : {}),
    },
    ...orgOpts(orgId),
  });
  return res.thread;
}

/** A single thread with its ordered messages (owner-only; throws 404 otherwise). */
export async function getChatThread(id: string, orgId?: string): Promise<ChatThreadDetail> {
  const res = await authFetch<{ thread: ChatThreadDetail }>(
    `/api/chat/threads/${encodeURIComponent(id)}`,
    orgOpts(orgId),
  );
  return {
    ...res.thread,
    messages: Array.isArray(res.thread.messages) ? res.thread.messages : [],
  };
}

/** Append one message; the server assigns the next ordinal. */
export async function appendChatMessage(
  id: string,
  message: ChatMessageInput,
  orgId?: string,
): Promise<ChatThreadMessage> {
  const res = await authFetch<{ message: ChatThreadMessage }>(
    `/api/chat/threads/${encodeURIComponent(id)}/messages`,
    { method: "POST", body: { role: message.role, content: message.content }, ...orgOpts(orgId) },
  );
  return res.message;
}

/** Rename a thread (and optionally re-model it). */
export async function renameChatThread(
  id: string,
  title: string,
  orgId?: string,
  model?: string,
): Promise<ChatThreadSummary> {
  const res = await authFetch<{ thread: ChatThreadSummary }>(
    `/api/chat/threads/${encodeURIComponent(id)}`,
    { method: "PUT", body: { title, ...(model ? { model } : {}) }, ...orgOpts(orgId) },
  );
  return res.thread;
}

/** Replace the thread's whole message history (sync a client's local copy up). */
export async function replaceChatMessages(
  id: string,
  messages: ChatMessageInput[],
  orgId?: string,
): Promise<void> {
  await authFetch(`/api/chat/threads/${encodeURIComponent(id)}/messages`, {
    method: "PUT",
    body: { messages },
    ...orgOpts(orgId),
  });
}

/** Delete a thread and its messages. */
export async function deleteChatThread(id: string, orgId?: string): Promise<void> {
  await authFetch(`/api/chat/threads/${encodeURIComponent(id)}`, {
    method: "DELETE",
    ...orgOpts(orgId),
  });
}

// --- Pure mapping / merge helpers (unit-tested without a network) ------------

/** Stored messages → the lean role/content pairs the server persists. Non
 * user/assistant roles and empty content are dropped so a resync stays clean. */
export function toServerMessages(messages: readonly StoredChatMessage[]): ChatMessageInput[] {
  return messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}

/** One server message → a stored message, or null if it isn't a user/assistant
 * turn we render (the server may also hold system/tool rows). Server messages
 * carry no citations/recall metadata — those stay in the local cache. */
export function serverMessageToStored(msg: ChatThreadMessage): StoredChatMessage | null {
  if (msg.role !== "user" && msg.role !== "assistant") return null;
  const content = typeof msg.content === "string" ? msg.content : "";
  if (!content.trim()) return null;
  return {
    id: msg.id && msg.id.trim() ? msg.id : `srv_${msg.ordinal}`,
    role: msg.role,
    content,
  };
}

function validIso(value: string | undefined | null): string {
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
}

function laterIso(a: string, b: string): string {
  const av = Date.parse(a);
  const bv = Date.parse(b);
  if (Number.isNaN(av)) return validIso(b);
  if (Number.isNaN(bv)) return validIso(a);
  return av >= bv ? new Date(av).toISOString() : new Date(bv).toISOString();
}

export interface MergeServerThreadsResult {
  /** The reconciled session list (server threads first, then local-only ones). */
  sessions: StoredChatSession[];
  /** Local sessions in the CURRENT org not yet on the server — migrate these up. */
  unsynced: StoredChatSession[];
}

/**
 * Reconcile the local session cache with the server's thread list, treating the
 * server as authoritative for which threads exist and their title/model:
 *  - a server thread already cached locally keeps its local messages + scope +
 *    citations, but adopts the server title/model and the newer timestamp;
 *  - a server thread not cached becomes a skeleton (empty messages, current
 *    scope) whose body is lazily fetched when opened;
 *  - a local session absent from the server is kept visible, and — if it belongs
 *    to the current org and has real messages — reported as `unsynced` so the
 *    caller can push it up once (the one-time localStorage→server migration).
 */
export function mergeServerThreads(
  local: readonly StoredChatSession[],
  remote: readonly ChatThreadSummary[],
  scope: StoredChatScope,
): MergeServerThreadsResult {
  const localById = new Map(local.map((s) => [s.id, s]));
  const remoteIds = new Set(remote.map((t) => t.id));
  const sessions: StoredChatSession[] = [];

  for (const thread of remote) {
    const cached = localById.get(thread.id);
    const model = thread.model || cached?.model;
    if (cached) {
      sessions.push({
        ...cached,
        title: thread.title || cached.title,
        ...(model ? { model } : {}),
        updatedAt: laterIso(cached.updatedAt, thread.updatedAt),
      });
    } else {
      sessions.push({
        id: thread.id,
        title: thread.title || "Untitled task",
        category: "General",
        scope: { ...scope },
        messages: [],
        ...(model ? { model } : {}),
        updatedAt: validIso(thread.updatedAt),
      });
    }
  }

  const unsynced: StoredChatSession[] = [];
  for (const s of local) {
    if (remoteIds.has(s.id)) continue;
    sessions.push(s);
    if (s.scope.orgId === scope.orgId && s.messages.length > 0) unsynced.push(s);
  }

  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { sessions, unsynced };
}
