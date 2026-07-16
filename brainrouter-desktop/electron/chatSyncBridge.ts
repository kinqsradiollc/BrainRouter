/**
 * K-desktop — cross-surface chat sync bridge. Pushes the ACTIVE desktop chat
 * session's user/assistant turns up to the shared chat-threads API
 * (`/api/chat/threads`) so a conversation started on the desktop also shows up
 * on the dashboard + CLI. Registered once from main.ts (`registerChatSyncBridge`).
 *
 * ADDITIVE and OPT-IN: nothing here runs on a normal chat turn — only on an
 * explicit "Sync to cloud" click. Local workspace transcripts stay the source of
 * truth and are never touched; a push only MIRRORS user/assistant text turns up.
 *
 * The renderer never holds the account bearer, so push/list are proxied here in
 * the main process. This file carries its OWN self-contained account fetch
 * (reproducing meetingsBridge's loopback/redirect/signed-out safety) so it never
 * has to touch a file owned by another in-flight feature.
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { loadConfig } from '@kinqs/brainrouter-core/config';
import { isInternalSessionKey, readTranscriptEntries } from '@kinqs/brainrouter-core/session';
import { isWorkspaceTrusted } from '@kinqs/brainrouter-core/workspace';
import { resolveBrainRouterAccountApi } from './accountIntegration.js';
import {
  deriveThreadTitle,
  emptyMapping,
  getThreadLink,
  isSafeSessionKey,
  normalizeMapping,
  removeThreadLink,
  transcriptEntriesToServerMessages,
  upsertThreadLink,
  type ChatSyncMapping,
  type ServerChatMessage,
} from './chatSyncMapping.js';

const SIGNED_OUT = 'Sign in to BrainRouter to sync this chat to the cloud.';
const MAPPING_FILE = 'chat-sync-threads.json';

interface FetchLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Authenticated call to the account backend. Null when signed out or the base
 * URL is unsafe. The account bearer must never travel in cleartext to a
 * non-loopback host (CWE-319), so plain http is only allowed to localhost.
 */
async function accountFetch(apiPath: string, init?: { method?: string; body?: string }): Promise<FetchLike | null> {
  const api = resolveBrainRouterAccountApi(loadConfig());
  if (!api?.baseUrl || !api.apiKey) return null;
  const base = api.baseUrl.replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(base); } catch { return null; }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  const res = await fetch(`${base}${apiPath}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${api.apiKey}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: init.body } : {}),
    redirect: 'error',
  });
  return res as unknown as FetchLike;
}

/** Absolute path to the single userData-scoped link store. */
function mappingFilePath(): string {
  return path.join(app.getPath('userData'), MAPPING_FILE);
}

/**
 * Read the link store. Tolerant: a missing, empty, malformed, or wrong-shaped
 * file yields an empty mapping rather than throwing — a corrupt cache can never
 * block a push (the worst case is one duplicate thread).
 */
function loadMapping(): ChatSyncMapping {
  try {
    const p = mappingFilePath();
    if (!fs.existsSync(p)) return emptyMapping();
    return normalizeMapping(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return emptyMapping();
  }
}

function saveMapping(mapping: ChatSyncMapping): void {
  try {
    fs.writeFileSync(mappingFilePath(), `${JSON.stringify(mapping, null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort: a failed persist just means the next push may create a
    // duplicate thread. It must never surface as a sync failure to the user.
  }
}

/** POST /api/chat/threads — create an (empty) thread; the server assigns its id. */
async function createServerThread(title: string): Promise<string> {
  const r = await accountFetch('/api/chat/threads', { method: 'POST', body: JSON.stringify({ title }) });
  if (!r) throw new Error(SIGNED_OUT);
  if (!r.ok) throw new Error('Could not create the cloud chat thread.');
  const data = (await r.json().catch(() => ({}))) as { thread?: { id?: unknown } };
  const id = data.thread?.id;
  if (typeof id !== 'string' || !id) throw new Error('The server did not return a chat thread id.');
  return id;
}

/**
 * PUT /api/chat/threads/:id/messages — replace a thread's whole history.
 * Returns false on 404 (the mapped thread is gone — deleted or a different
 * owner) so the caller can drop the stale link and recreate.
 */
async function replaceServerMessages(threadId: string, messages: ServerChatMessage[]): Promise<boolean> {
  const r = await accountFetch(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'PUT',
    body: JSON.stringify({ messages }),
  });
  if (!r) throw new Error(SIGNED_OUT);
  if (r.status === 404) return false;
  if (!r.ok) throw new Error('Could not update the cloud chat thread.');
  return true;
}

interface PushArgs {
  workspaceRoot?: unknown;
  sessionKey?: unknown;
  title?: unknown;
}

export function registerChatSyncBridge(): void {
  // Push the active session's transcript up to a server chat thread — creating
  // one the first time, then REPLACing the SAME thread on every later push.
  ipcMain.handle('chatSync:push', async (_e, rawArgs: unknown) => {
    const args = (rawArgs ?? {}) as PushArgs;
    if (typeof args.workspaceRoot !== 'string' || !args.workspaceRoot.trim()) {
      throw new Error('Open a workspace before syncing a chat.');
    }
    if (!isSafeSessionKey(args.sessionKey)) {
      throw new Error('There is no chat session to sync yet.');
    }
    const workspaceRoot = path.resolve(args.workspaceRoot);
    // CWE-22 — the renderer must not be able to point this at an arbitrary path and
    // exfiltrate transcripts from outside the app's workspaces. Only read from a
    // workspace the user has explicitly TRUSTED (the app's existing boundary for
    // sensitive workspace ops; the agent won't produce transcripts in an untrusted
    // workspace anyway). An attacker-supplied path is never trusted, so it's rejected.
    if (!isWorkspaceTrusted(workspaceRoot)) {
      throw new Error('This workspace is not trusted — open and trust it before syncing.');
    }
    const sessionKey = args.sessionKey;
    if (isInternalSessionKey(sessionKey)) {
      throw new Error('Internal sessions cannot be synced.');
    }
    // Short-circuit signed-out BEFORE any transcript read, so a missing account
    // key always yields the same clear message regardless of session state.
    if (!resolveBrainRouterAccountApi(loadConfig())) throw new Error(SIGNED_OUT);

    const entries = readTranscriptEntries(workspaceRoot, sessionKey, Number.MAX_SAFE_INTEGER);
    const messages = transcriptEntriesToServerMessages(entries);
    if (messages.length === 0) throw new Error('This chat has no messages to sync yet.');

    const title = typeof args.title === 'string' && args.title.trim()
      ? args.title.trim()
      : deriveThreadTitle(entries);

    let mapping = loadMapping();
    const existing = getThreadLink(mapping, workspaceRoot, sessionKey);
    let threadId = existing?.threadId;
    let created = false;

    if (threadId) {
      const ok = await replaceServerMessages(threadId, messages);
      if (!ok) {
        mapping = removeThreadLink(mapping, workspaceRoot, sessionKey);
        threadId = undefined;
      }
    }
    if (!threadId) {
      threadId = await createServerThread(title);
      created = true;
      const ok = await replaceServerMessages(threadId, messages);
      if (!ok) throw new Error('Could not save messages to the new cloud chat thread.');
    }

    mapping = upsertThreadLink(mapping, workspaceRoot, sessionKey, {
      threadId,
      syncedAt: new Date().toISOString(),
      messageCount: messages.length,
    });
    saveMapping(mapping);

    return { threadId, messageCount: messages.length, created, title };
  });

  // List the caller's server chat threads (no messages), newest-touched first.
  ipcMain.handle('chatSync:list', async () => {
    const r = await accountFetch('/api/chat/threads');
    if (!r) throw new Error(SIGNED_OUT);
    if (!r.ok) throw new Error('Could not list your cloud chat threads.');
    const data = (await r.json().catch(() => ({}))) as { threads?: unknown };
    return Array.isArray(data.threads) ? data.threads : [];
  });
}
