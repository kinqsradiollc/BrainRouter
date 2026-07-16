/**
 * Chat-thread backend — the data plane behind /api/chat/threads (migration 036). Chat
 * history used to live only in each client's local storage (dashboard localStorage,
 * desktop + CLI local files), so a conversation started on one surface never appeared on
 * the others. This gives it a shared server home a later change can repoint the clients to.
 *
 * A thread is PERSONAL: private to its owning user within the org. Every store call is
 * keyed by both orgId and userId, so one member can never read or mutate another's threads
 * even inside the same org. This layer owns the input hygiene — title/content caps and a
 * sane threads-per-user ceiling — before touching the store.
 */
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../engine.js";
import type {
  AppendChatMessageInput, ChatMessageRow, ChatRole, ChatThreadRow, ChatThreadWithMessages,
  CreateChatThreadInput,
} from "../store/postgres/queries/chatThreadsQueries.js";

interface ChatThreadStore {
  createChatThread(input: CreateChatThreadInput): Promise<ChatThreadRow>;
  listChatThreads(orgId: string, userId: string, limit?: number): Promise<ChatThreadRow[]>;
  getChatThread(orgId: string, userId: string, id: string): Promise<ChatThreadWithMessages | null>;
  countChatThreads(orgId: string, userId: string): Promise<number>;
  appendChatMessage(orgId: string, userId: string, threadId: string, msg: AppendChatMessageInput): Promise<ChatMessageRow | null>;
  renameChatThread(orgId: string, userId: string, id: string, title: string, model?: string | null): Promise<ChatThreadRow | null>;
  deleteChatThread(orgId: string, userId: string, id: string): Promise<boolean>;
  replaceChatMessages(orgId: string, userId: string, threadId: string, messages: AppendChatMessageInput[]): Promise<ChatThreadWithMessages | null>;
}
const store = (): ChatThreadStore => memoryEngine.store as unknown as ChatThreadStore;

export type { ChatMessageRow, ChatRole, ChatThreadRow, ChatThreadWithMessages } from "../store/postgres/queries/chatThreadsQueries.js";

const MAX_TITLE = 200;
const MAX_CONTENT = 200_000;      // per-message content cap (chars)
const MAX_MESSAGES = 5_000;       // per replace/sync payload
const MAX_THREADS_PER_USER = 2_000;
const DEFAULT_TITLE = "New chat";
const ROLES = new Set<ChatRole>(["user", "assistant", "system", "tool"]);

function normalizeTitle(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  return (t || DEFAULT_TITLE).slice(0, MAX_TITLE);
}
function asRole(raw: unknown): ChatRole {
  return typeof raw === "string" && ROLES.has(raw as ChatRole) ? (raw as ChatRole) : "user";
}
function normalizeModel(raw: unknown): string | null {
  if (raw == null) return null;
  const m = typeof raw === "string" ? raw.trim() : "";
  return m ? m.slice(0, MAX_TITLE) : null;
}
function normalizeMessage(raw: unknown): AppendChatMessageInput {
  const m = (raw ?? {}) as Record<string, unknown>;
  const content = typeof m.content === "string" ? m.content.slice(0, MAX_CONTENT) : "";
  return {
    id: typeof m.id === "string" && m.id.trim() ? m.id : `cm_${randomUUID()}`,
    role: asRole(m.role),
    content,
  };
}

export interface CreateThreadInput {
  title?: string;
  model?: string | null;
  /** Optional initial messages to seed the thread with (e.g. a client pushing a fresh convo). */
  messages?: unknown[];
}

export function listThreads(orgId: string, userId: string): Promise<ChatThreadRow[]> {
  return store().listChatThreads(orgId, userId);
}

export function getThread(orgId: string, userId: string, id: string): Promise<ChatThreadWithMessages | null> {
  return store().getChatThread(orgId, userId, id);
}

export async function createThread(orgId: string, userId: string, input: CreateThreadInput): Promise<ChatThreadWithMessages> {
  const count = await store().countChatThreads(orgId, userId);
  if (count >= MAX_THREADS_PER_USER) {
    throw new Error(`Thread limit reached (${MAX_THREADS_PER_USER}); delete old threads first`);
  }
  const thread = await store().createChatThread({
    id: `ct_${randomUUID()}`,
    orgId, userId,
    title: normalizeTitle(input.title),
    model: normalizeModel(input.model),
  });
  const seed = Array.isArray(input.messages) ? input.messages.slice(0, MAX_MESSAGES).map(normalizeMessage) : [];
  if (seed.length) {
    const withMessages = await store().replaceChatMessages(orgId, userId, thread.id, seed);
    if (withMessages) return withMessages;
  }
  return { ...thread, messages: [] };
}

export async function appendMessage(orgId: string, userId: string, threadId: string, role: unknown, content: unknown): Promise<ChatMessageRow | null> {
  return store().appendChatMessage(orgId, userId, threadId, normalizeMessage({ role, content }));
}

export function renameThread(orgId: string, userId: string, id: string, title: unknown, model?: unknown): Promise<ChatThreadRow | null> {
  return store().renameChatThread(orgId, userId, id, normalizeTitle(title), model === undefined ? undefined : normalizeModel(model));
}

export function deleteThread(orgId: string, userId: string, id: string): Promise<boolean> {
  return store().deleteChatThread(orgId, userId, id);
}

/** Replace a thread's whole history — a client pushing its local messages up to sync. */
export function replaceMessages(orgId: string, userId: string, threadId: string, messages: unknown[]): Promise<ChatThreadWithMessages | null> {
  const normalized = (Array.isArray(messages) ? messages : []).slice(0, MAX_MESSAGES).map(normalizeMessage);
  return store().replaceChatMessages(orgId, userId, threadId, normalized);
}
