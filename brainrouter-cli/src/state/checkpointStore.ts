import fs from 'node:fs';
import path from 'node:path';
import { getCliStateDir } from './cliState.js';

/**
 * CLI-21 (0.4.4) — crash-checkpoint + offline prompt queue.
 *
 * Two durable, per-session JSON files under the CLI state dir:
 *   - the *in-flight* checkpoint: the prompt currently being processed, written
 *     before a turn and cleared after it. If the process dies mid-turn it
 *     survives, so the next launch can offer to resend it ("crash recovery").
 *   - the *offline queue*: prompts whose turn failed with a connectivity error
 *     (LLM/MCP unreachable) — kept so they aren't lost and can be replayed.
 *
 * The store is small + synchronous (a turn is already an await boundary) and
 * never throws on I/O — a checkpoint that can't be written just means no
 * recovery hint, which must not break the session.
 */

export interface QueuedPrompt {
  prompt: string;
  at: string; // ISO
  kind: 'crash' | 'offline';
}

function encodeKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}
function inflightPath(ws: string, sessionKey: string): string {
  return path.join(getCliStateDir(ws), 'checkpoints', `${encodeKey(sessionKey)}.inflight.json`);
}
function offlinePath(ws: string, sessionKey: string): string {
  return path.join(getCliStateDir(ws), 'checkpoints', `${encodeKey(sessionKey)}.offline.json`);
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return fallback; }
}
function writeJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), 'utf-8');
  } catch { /* best-effort — recovery is a convenience, not a guarantee */ }
}
function rm(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* noop */ }
}

/** Record the prompt about to be processed (before runTurn). */
export function beginTurnCheckpoint(ws: string, sessionKey: string, prompt: string, nowIso: string): void {
  writeJson(inflightPath(ws, sessionKey), { prompt, at: nowIso, kind: 'crash' } satisfies QueuedPrompt);
}
/** Clear the in-flight checkpoint (after the turn settles — success OR a normal error). */
export function endTurnCheckpoint(ws: string, sessionKey: string): void {
  rm(inflightPath(ws, sessionKey));
}

/** Append a prompt to the offline queue (a turn that failed on connectivity). */
export function queueOfflinePrompt(ws: string, sessionKey: string, prompt: string, nowIso: string): void {
  const file = offlinePath(ws, sessionKey);
  const queue = readJson<QueuedPrompt[]>(file, []);
  queue.push({ prompt, at: nowIso, kind: 'offline' });
  writeJson(file, queue.slice(-50)); // bound the queue
}
export function readOfflineQueue(ws: string, sessionKey: string): QueuedPrompt[] {
  const q = readJson<QueuedPrompt[]>(offlinePath(ws, sessionKey), []);
  return Array.isArray(q) ? q : [];
}
export function clearOfflineQueue(ws: string, sessionKey: string): void {
  rm(offlinePath(ws, sessionKey));
}

/**
 * What a fresh launch can recover for this session: a leftover in-flight prompt
 * (= a crash mid-turn) plus any offline-queued prompts. Empty when nothing is
 * pending.
 */
export function readRecoverable(ws: string, sessionKey: string): { crashed: QueuedPrompt | null; offline: QueuedPrompt[] } {
  const crashed = readJson<QueuedPrompt | null>(inflightPath(ws, sessionKey), null);
  return { crashed: crashed && typeof crashed.prompt === 'string' ? crashed : null, offline: readOfflineQueue(ws, sessionKey) };
}

const CONNECTIVITY_RE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|network|socket hang up|request to .* failed|getaddrinfo|aborted|timed? ?out|Connection error/i;

/** True when an error looks like a transient connectivity failure (→ offline queue, not lost). */
export function isConnectivityError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${(err as any).code ?? ''} ${(err as any).cause?.code ?? ''}` : String(err ?? '');
  return CONNECTIVITY_RE.test(msg);
}
