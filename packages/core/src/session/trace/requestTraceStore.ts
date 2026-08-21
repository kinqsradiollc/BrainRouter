/**
 * ADR-041 D14 (glass box, commitment #1) — "every request is inspectable, exactly".
 *
 * When `cli.traceRequests` is on, each LLM request records a header — the model,
 * endpoint, effort, message count, and a bounded excerpt of the rendered system
 * prompt plus the exact tool names sent — so a human can open any step and see
 * what the model actually saw, rather than a reconstruction. Off by default:
 * nothing is written and the turn path is byte-identical.
 *
 * The store is an append-only `request-trace.jsonl` in the SESSION bucket (it
 * travels with a fork/export, like the transcript and message-feedback ledgers),
 * NOT the transcript itself — a request header is log-only (a human sees it, the
 * model never does), so keeping it out of the transcript keeps replay/model
 * context untouched. Writes are best-effort and self-trimming; a trace failure
 * must never break a turn.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionStateDir } from '../../storage/store.js';

const REQUEST_TRACE_FILE = 'request-trace.jsonl';
/** Keep the tail bounded — this is a debugging aid, not an archive. */
const MAX_RECORDS = 200;
/** Cap the rendered-prompt excerpt so one file cannot balloon. */
const MAX_EXCERPT_CHARS = 4000;

/** One captured request header — what a single LLM request actually carried. */
export interface RequestTraceRecord {
  /** When the request was issued (ISO). */
  at: string;
  /** The resolved model id. */
  model: string;
  /** The endpoint/route the request went to, when known. */
  endpoint?: string;
  /** The reasoning effort actually sent, when applicable. */
  effort?: string;
  /** How many messages were in the rendered request. */
  messageCount: number;
  /** Total characters of rendered system-prompt text (before the excerpt cap). */
  systemChars: number;
  /** A bounded excerpt of the rendered system prompt — what the model saw. */
  systemExcerpt: string;
  /** The exact tool names offered on this request. */
  toolNames: string[];
}

function tracePath(workspaceRoot: string, sessionKey: string): string {
  return path.join(getSessionStateDir(workspaceRoot, sessionKey), REQUEST_TRACE_FILE);
}

/** Clamp the excerpt so no single record can be unbounded. */
export function clampExcerpt(text: string): string {
  if (text.length <= MAX_EXCERPT_CHARS) return text;
  return `${text.slice(0, MAX_EXCERPT_CHARS)}…[+${text.length - MAX_EXCERPT_CHARS} chars]`;
}

/**
 * Append one request header. Best-effort: on any failure it returns false rather
 * than throwing, so a trace write can never fail a turn. Self-trims to the last
 * MAX_RECORDS so the file stays bounded across a long session.
 */
export function recordRequestTrace(workspaceRoot: string, sessionKey: string, record: RequestTraceRecord): boolean {
  try {
    const file = tracePath(workspaceRoot, sessionKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    trim(file);
    return true;
  } catch {
    return false;
  }
}

/** Read the most recent request headers (newest last), at most `limit`. */
export function readRequestTrace(workspaceRoot: string, sessionKey: string, limit = 20): RequestTraceRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(tracePath(workspaceRoot, sessionKey), 'utf8');
  } catch {
    return [];
  }
  const records: RequestTraceRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as RequestTraceRecord);
    } catch {
      // A torn last line (a crash mid-append) is skipped, not fatal.
    }
  }
  return limit > 0 && records.length > limit ? records.slice(records.length - limit) : records;
}

/** Keep only the last MAX_RECORDS lines on disk. Best-effort. */
function trim(file: string): void {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    if (lines.length <= MAX_RECORDS) return;
    fs.writeFileSync(file, `${lines.slice(lines.length - MAX_RECORDS).join('\n')}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}
