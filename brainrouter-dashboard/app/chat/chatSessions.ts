import type { ModelReasoningEffort } from "@kinqs/brainrouter-types";

const CHAT_REASONING_EFFORTS = new Set<string>([
  "none", "minimal", "low", "medium", "high", "xhigh", "max",
]);

export type StoredChatRole = "user" | "assistant";

export interface StoredChatCitation {
  recordId: string;
  title?: string;
  excerpt: string;
  type?: string;
  score?: number;
}

export interface StoredChatMessage {
  id: string;
  role: StoredChatRole;
  content: string;
  citations?: StoredChatCitation[];
  recallStrategy?: string;
}

export interface StoredChatScope {
  orgId: string;
  projectId: string;
  workspaceTag: string;
}

export interface StoredChatSession {
  id: string;
  title: string;
  category: string;
  scope: StoredChatScope;
  messages: StoredChatMessage[];
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  updatedAt: string;
}

export interface ChatSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CHAT_SESSIONS_STORAGE_KEY = "brainrouter.dashboard.chat-sessions.v1";
const MAX_SESSIONS = 20;
const MAX_MESSAGES = 40;
const MAX_CONTENT = 12_000;

function string(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function scope(value: unknown): StoredChatScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    orgId: string(raw.orgId),
    projectId: string(raw.projectId),
    workspaceTag: string(raw.workspaceTag),
  };
}

function message(value: unknown): StoredChatMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const role = raw.role === "user" || raw.role === "assistant" ? raw.role : null;
  const id = string(raw.id);
  const content = string(raw.content, MAX_CONTENT);
  if (!role || !id || !content) return null;
  return {
    id,
    role,
    content,
    ...(Array.isArray(raw.citations) ? { citations: raw.citations.filter((item): item is StoredChatCitation => (
      Boolean(item && typeof item === "object" && !Array.isArray(item)
        && string((item as Record<string, unknown>).recordId)
        && string((item as Record<string, unknown>).excerpt, 600))
    )).slice(0, 8) } : {}),
    ...(string(raw.recallStrategy) ? { recallStrategy: string(raw.recallStrategy) } : {}),
  };
}

function session(value: unknown): StoredChatSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = string(raw.id);
  const storedScope = scope(raw.scope);
  const updatedAt = string(raw.updatedAt);
  if (!id || !storedScope || !updatedAt || Number.isNaN(Date.parse(updatedAt))) return null;
  return {
    id,
    title: string(raw.title, 72) || "Untitled task",
    category: string(raw.category, 32) || "General",
    scope: storedScope,
    messages: (Array.isArray(raw.messages) ? raw.messages : [])
      .map(message)
      .filter((item): item is StoredChatMessage => item !== null)
      .slice(-MAX_MESSAGES),
    ...(string(raw.model, 160) ? { model: string(raw.model, 160) } : {}),
    ...(CHAT_REASONING_EFFORTS.has(String(raw.reasoningEffort ?? ""))
      ? { reasoningEffort: raw.reasoningEffort as ModelReasoningEffort }
      : {}),
    updatedAt: new Date(updatedAt).toISOString(),
  };
}

export function loadChatSessions(storage: ChatSessionStorage): StoredChatSession[] {
  try {
    const raw = storage.getItem(CHAT_SESSIONS_STORAGE_KEY);
    const values = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(values)) return [];
    return values
      .map(session)
      .filter((item): item is StoredChatSession => item !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}

export function saveChatSessions(
  storage: ChatSessionStorage,
  sessions: readonly StoredChatSession[],
): void {
  const safe = sessions
    .map(session)
    .filter((item): item is StoredChatSession => item !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_SESSIONS);
  storage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(safe));
}

export function upsertChatSession(
  sessions: readonly StoredChatSession[],
  next: StoredChatSession,
): StoredChatSession[] {
  return [next, ...sessions.filter((item) => item.id !== next.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_SESSIONS);
}

export function sessionTitle(messages: readonly StoredChatMessage[]): string {
  const first = messages.find((item) => item.role === "user")?.content ?? "";
  const normalized = first.replace(/\s+/g, " ").trim();
  return normalized ? `${normalized.slice(0, 52)}${normalized.length > 52 ? "…" : ""}` : "Untitled task";
}

export function sameChatScope(left: StoredChatScope, right: StoredChatScope): boolean {
  return left.orgId === right.orgId
    && left.projectId === right.projectId
    && left.workspaceTag === right.workspaceTag;
}
