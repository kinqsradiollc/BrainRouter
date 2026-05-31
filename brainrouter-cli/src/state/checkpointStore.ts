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

/** CLI-21b — replay the offline queue only when enabled, reconnected, and there's something to replay. */
export function shouldAutoReplayOffline(opts: { enabled: boolean; connected: boolean; count: number }): boolean {
  return opts.enabled && opts.connected && opts.count > 0;
}

/** True when an error looks like a transient connectivity failure (→ offline queue, not lost). */
export function isConnectivityError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${(err as any).code ?? ''} ${(err as any).cause?.code ?? ''}` : String(err ?? '');
  return CONNECTIVITY_RE.test(msg);
}

/**
 * Whether a failed LLM call should be retried: only for transient connectivity
 * errors, and only while attempts remain (`attempt` is 1-based). Keeps the
 * agent's LLM retry policy pure + testable.
 */
export function shouldRetryConnectivity(err: unknown, attempt: number, maxAttempts: number): boolean {
  return attempt < maxAttempts && isConnectivityError(err);
}

// HTTP statuses worth retrying: request/gateway timeouts (408/504), rate limits
// (429), and transient server / gateway / overload errors (500/502/503 + the
// 52x Cloudflare and 529 "overloaded" variants). NOT 4xx like 400/401/403/404 —
// those are deterministic client errors that a retry can't fix.
const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 523, 524, 529]);

// Textual forms of the same transient server/gateway failures, for providers
// whose errors arrive as a string (no structured `status`). The numeric branch
// is anchored to an "(API) error: <code>" / "status: <code>" prefix so a bare
// "500" elsewhere in a message (e.g. "500 tokens") can't masquerade as a
// retryable status; the gateway/overload phrases match on their own.
const RETRYABLE_SERVER_RE =
  /(?:api )?error:?\s*(?:40[89]|425|429|5\d{2})\b|status(?: code)?:?\s*(?:40[89]|425|429|5\d{2})\b|gateway time-?out|bad gateway|service (?:is )?unavailable|temporarily unavailable|server (?:is )?overloaded|overloaded_error|too many requests|internal server error|server had an error/i;

/**
 * True when an error is a transient SERVER-side failure that a retry can fix:
 * HTTP 5xx, gateway timeouts (504), rate limits (429), and overload errors.
 * Distinct from `isConnectivityError` (the client couldn't reach the server at
 * all) — here the server WAS reached but returned a retryable status. Checks a
 * structured `status`/`statusCode`/`response.status` first, then the message.
 */
export function isRetryableServerError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as any;
    const status = typeof e.status === 'number' ? e.status
      : typeof e.statusCode === 'number' ? e.statusCode
      : typeof e.response?.status === 'number' ? e.response.status
      : undefined;
    if (typeof status === 'number' && RETRYABLE_HTTP_STATUS.has(status)) return true;
  }
  const msg = err instanceof Error ? `${err.message} ${(err as any).code ?? ''}` : String(err ?? '');
  return RETRYABLE_SERVER_RE.test(msg);
}

/**
 * Whether a failed LLM call should be retried in place: transient connectivity
 * OR a retryable server/gateway/rate-limit status, while attempts remain
 * (`attempt` is 1-based). This is the predicate the agent's `invokeLlmResilient`
 * loop uses — broader than `shouldRetryConnectivity` (which stays scoped to the
 * offline-queue decision: a 504 means the server is UP, so it must not be
 * treated as "offline").
 */
export function shouldRetryLlm(err: unknown, attempt: number, maxAttempts: number): boolean {
  return attempt < maxAttempts && (isConnectivityError(err) || isRetryableServerError(err));
}
