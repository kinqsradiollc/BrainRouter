/**
 * K-CLI — cross-surface chat sync client. Pushes a local CLI session's
 * conversation up to the shared chat-threads API (`/api/chat/threads`) so a
 * conversation started in the terminal also shows up on the dashboard/desktop,
 * and lists the caller's server threads.
 *
 * This is ADDITIVE and OPT-IN: nothing here runs on a normal chat turn. Local
 * workspace transcripts remain the source of truth and are untouched — a push
 * only mirrors user + assistant text turns up to the server.
 *
 * Auth reuses the CLI's existing hosted-profile mechanism (the active `http`
 * server profile's base URL + API key, same bearer used by `brainrouter github`),
 * so there is no new config knob or env var. The server resolves the caller's
 * org from the bearer (the optional `X-BrainRouter-Org` header is not needed).
 */
import { loadOrInitConfig } from '@kinqs/brainrouter-core/config';
import { isInternalSessionKey, loadTranscript } from '@kinqs/brainrouter-core/session';
import {
  chatSyncMappingPath,
  getThreadLink,
  loadIdMapping,
  saveIdMapping,
  upsertThreadLink,
} from './idMapping.js';
import {
  deriveThreadTitle,
  transcriptEntriesToServerMessages,
  type ServerChatMessageInput,
} from './transcriptMapping.js';

/** The resolved account API binding: base URL + bearer key. */
export interface ChatSyncTarget {
  baseUrl: string;
  apiKey: string;
}

/** A server thread as returned by the list/create/replace endpoints (subset we use). */
export interface ServerChatThread {
  id: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Raised for a non-2xx response; carries the HTTP status so callers can branch (e.g. 404). */
export class ChatSyncHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ChatSyncHttpError';
  }
}

/**
 * Resolve the active hosted (`http`) profile → account base URL + API key.
 * Mirrors the resolver `brainrouter github` uses: the profile URL is the MCP
 * endpoint (`…/mcp`); the account API lives at the root.
 */
export function resolveChatSyncTarget(): ChatSyncTarget | { error: string } {
  const config = loadOrInitConfig();
  const active = config.activeServer;
  const server = active ? config.servers?.[active] : undefined;
  if (!server || server.type !== 'http' || !('url' in server) || !server.url) {
    return { error: 'No hosted BrainRouter server is configured. Run `brainrouter login` to connect to one first.' };
  }
  const baseUrl = String(server.url).replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  const apiKey = String(('apiKey' in server && server.apiKey) || '');
  if (!apiKey) return { error: 'Your BrainRouter profile has no API key. Re-run `brainrouter login`.' };
  return { baseUrl, apiKey };
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

function errorMessage(body: unknown, status: number): string {
  const r = body as { error?: unknown } | null;
  const e = r?.error;
  if (typeof e === 'string' && e) return e;
  return `HTTP ${status}`;
}

async function request<T>(target: ChatSyncTarget, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${target.baseUrl}${path}`, {
    method,
    headers: authHeaders(target.apiKey),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new ChatSyncHttpError(res.status, errorMessage(json, res.status));
  return json as T;
}

/** GET /api/chat/threads — the caller's threads (no messages), newest-touched first. */
export async function listServerThreads(target: ChatSyncTarget): Promise<ServerChatThread[]> {
  const data = await request<{ threads?: ServerChatThread[] }>(target, 'GET', '/api/chat/threads');
  return data.threads ?? [];
}

/** POST /api/chat/threads — create an (empty) thread; the server assigns its id. */
export async function createThread(target: ChatSyncTarget, title: string): Promise<ServerChatThread> {
  const data = await request<{ thread: ServerChatThread }>(target, 'POST', '/api/chat/threads', { title });
  return data.thread;
}

/** PUT /api/chat/threads/:id/messages — replace a thread's whole history. */
export async function replaceThreadMessages(
  target: ChatSyncTarget,
  threadId: string,
  messages: ServerChatMessageInput[],
): Promise<ServerChatThread> {
  const data = await request<{ thread: ServerChatThread }>(
    target,
    'PUT',
    `/api/chat/threads/${encodeURIComponent(threadId)}/messages`,
    { messages },
  );
  return data.thread;
}

export type PushOutcome =
  | { status: 'skipped'; reason: 'internal' | 'empty' }
  | { status: 'pushed'; threadId: string; title: string; messageCount: number; created: boolean };

export interface PushSessionOptions {
  /** Override the derived thread title. */
  title?: string;
}

/**
 * Read a local session's transcript, map it to server messages, and mirror it
 * up to a chat thread — creating one the first time and REPLACing the same
 * thread's messages on every subsequent push (dedupe via the id mapping).
 *
 * If the mapped thread no longer exists server-side (deleted, or the account/org
 * changed), the stale link is dropped and a fresh thread is created — the
 * owner-guarded server returns 404, which we treat as "recreate".
 */
export async function pushSessionToServer(
  target: ChatSyncTarget,
  workspaceRoot: string,
  sessionKey: string,
  opts: PushSessionOptions = {},
): Promise<PushOutcome> {
  if (isInternalSessionKey(sessionKey)) return { status: 'skipped', reason: 'internal' };

  const entries = loadTranscript(workspaceRoot, sessionKey);
  const messages = transcriptEntriesToServerMessages(entries);
  if (messages.length === 0) return { status: 'skipped', reason: 'empty' };

  const title = opts.title?.trim() || deriveThreadTitle(entries);
  const mappingPath = chatSyncMappingPath(workspaceRoot);
  const mapping = loadIdMapping(mappingPath);
  const existing = getThreadLink(mapping, sessionKey);

  let threadId = existing?.threadId;
  let created = false;
  if (threadId) {
    try {
      await replaceThreadMessages(target, threadId, messages);
    } catch (err) {
      // 404 → the mapped thread is gone (deleted / different owner). Recreate.
      if (err instanceof ChatSyncHttpError && err.status === 404) {
        threadId = undefined;
      } else {
        throw err;
      }
    }
  }
  if (!threadId) {
    const thread = await createThread(target, title);
    threadId = thread.id;
    created = true;
    await replaceThreadMessages(target, threadId, messages);
  }

  const next = upsertThreadLink(mapping, sessionKey, {
    threadId,
    syncedAt: new Date().toISOString(),
    messageCount: messages.length,
  });
  saveIdMapping(mappingPath, next);

  return { status: 'pushed', threadId, title, messageCount: messages.length, created };
}
