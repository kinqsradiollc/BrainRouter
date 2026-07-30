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
import { isInternalSessionKey, loadTranscript } from '@kinqs/brainrouter-core/session';
import {
  AccountApiHttpError,
  accountApiRequest,
  resolveAccountApiTarget,
  type AccountApiTarget,
} from '../account/accountClient.js';
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

/** Compatibility names retained for existing chat-sync consumers. */
export type ChatSyncTarget = AccountApiTarget;
export { AccountApiHttpError as ChatSyncHttpError };

/** A server thread as returned by the list/create/replace endpoints (subset we use). */
export interface ServerChatThread {
  id: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Resolve the active hosted (`http`) profile → account base URL + API key.
 * Mirrors the resolver `brainrouter github` uses: the profile URL is the MCP
 * endpoint (`…/mcp`); the account API lives at the root.
 */
export function resolveChatSyncTarget(): ChatSyncTarget | { error: string } {
  return resolveAccountApiTarget();
}

/** GET /api/chat/threads — the caller's threads (no messages), newest-touched first. */
export async function listServerThreads(target: ChatSyncTarget): Promise<ServerChatThread[]> {
  const data = await accountApiRequest<{ threads?: ServerChatThread[] }>(target, 'GET', '/api/chat/threads');
  return data.threads ?? [];
}

/** POST /api/chat/threads — create an (empty) thread; the server assigns its id. */
export async function createThread(target: ChatSyncTarget, title: string): Promise<ServerChatThread> {
  const data = await accountApiRequest<{ thread: ServerChatThread }>(target, 'POST', '/api/chat/threads', { title });
  return data.thread;
}

/** PUT /api/chat/threads/:id/messages — replace a thread's whole history. */
export async function replaceThreadMessages(
  target: ChatSyncTarget,
  threadId: string,
  messages: ServerChatMessageInput[],
): Promise<ServerChatThread> {
  const data = await accountApiRequest<{ thread: ServerChatThread }>(
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
      if (err instanceof AccountApiHttpError && err.status === 404) {
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
