import fs from 'node:fs';
import path from 'node:path';
import {
  decodeSessionKey,
  encodeSessionKey,
  getCliStateDir,
  getSessionStateDir,
  isPathInside,
} from './cliState.js';

export interface TranscriptEntry {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  isError?: boolean;
  timestamp: string;
}

const SECRET_TOKEN_PATTERNS: RegExp[] = [
  /\bbr_[A-Za-z0-9._-]{8,}\b/g,
  /\bsk-[A-Za-z0-9._-]{8,}\b/g,
];

const TRANSCRIPT_FILE = 'transcript.jsonl';

export function appendTranscriptEntry(workspaceRoot: string, sessionKey: string, entry: Omit<TranscriptEntry, 'timestamp'> & { timestamp?: string }): void {
  const filePath = getTranscriptPath(workspaceRoot, sessionKey);
  const payload: TranscriptEntry = redactTranscriptEntry({
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  });

  // Dedup consecutive identical user prompts (e.g. arrow-up + Enter to repeat
  // the same prompt) so /transcript and /resume don't accumulate identical
  // replay-spam entries. Only applied to role='user' entries — assistant +
  // tool replies legitimately differ between turns even when the prompt is
  // the same.
  if (payload.role === 'user' && isConsecutiveDuplicate(filePath, payload)) {
    return;
  }

  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

/**
 * Check if the last line of the transcript file matches the new entry on
 * role + content. Bounded read (last ~32KB) so the dedup check stays cheap
 * even for huge transcripts; consecutive duplicates that span beyond that
 * window weren't going to be visually adjacent anyway.
 */
function isConsecutiveDuplicate(filePath: string, candidate: TranscriptEntry): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return false;
    const start = Math.max(0, stat.size - 32 * 1024);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const tail = buf.toString('utf8').trimEnd();
      if (!tail) return false;
      const lastLine = tail.slice(tail.lastIndexOf('\n') + 1);
      const last = JSON.parse(lastLine) as TranscriptEntry;
      return last.role === candidate.role && last.content === candidate.content;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Any read/parse failure: don't dedup — write the entry normally.
    return false;
  }
}

export function readTranscriptEntries(workspaceRoot: string, sessionKey: string, limit = 40): TranscriptEntry[] {
  const filePath = resolveExistingTranscriptPath(workspaceRoot, sessionKey);
  if (!filePath) {
    return [];
  }

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  // A single corrupted line — most often the tail line from a Ctrl-C mid-write
  // because appendFileSync is not atomic for large payloads — must not crash
  // /resume or anything else that scans the transcript. Tolerate bad lines
  // and warn once; the visible-entry slice handles the rest.
  const entries: TranscriptEntry[] = [];
  let dropped = 0;
  for (const line of lines.slice(Math.max(0, lines.length - limit))) {
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) {
    console.warn(`[brainrouter] dropped ${dropped} unparseable transcript line(s) in ${filePath}`);
  }
  return entries;
}

/**
 * Resolve the transcript path for writes. Always uses the per-session bucket
 * at `<state>/sessions/<encodedKey>/transcript.jsonl` so each chat session
 * keeps its history co-located with its goal/plan/etc.
 */
export function getTranscriptPath(workspaceRoot: string, sessionKey: string): string {
  const sessionDir = getSessionStateDir(workspaceRoot, sessionKey);
  const filePath = path.join(sessionDir, TRANSCRIPT_FILE);
  if (!isPathInside(sessionDir, filePath)) {
    throw new Error('Transcript path escapes session directory.');
  }
  return filePath;
}

/**
 * Read-side resolver: prefer the per-session bucket, fall back to the legacy
 * `transcripts/<encodedKey>.jsonl` location so `/resume` still works for
 * sessions captured by older builds.
 */
function resolveExistingTranscriptPath(workspaceRoot: string, sessionKey: string): string | undefined {
  const sessionPath = getTranscriptPath(workspaceRoot, sessionKey);
  if (fs.existsSync(sessionPath)) return sessionPath;
  const legacy = path.join(getCliStateDir(workspaceRoot), 'transcripts', `${encodeSessionKey(sessionKey)}.jsonl`);
  if (fs.existsSync(legacy)) return legacy;
  return undefined;
}

export function redactText(value: string): string {
  const redactedAssignments = value.replace(
    /((?:"(?:apiKey|api_key|BRAINROUTER_API_KEY|OPENAI_API_KEY)"|(?:apiKey|api_key|BRAINROUTER_API_KEY|OPENAI_API_KEY))\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,\]}]+)/gi,
    '$1"[REDACTED]"',
  );
  return SECRET_TOKEN_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, '[REDACTED]'),
    redactedAssignments,
  );
}

export function redactTranscriptEntry(entry: TranscriptEntry): TranscriptEntry {
  return JSON.parse(redactText(JSON.stringify(entry))) as TranscriptEntry;
}

export interface TranscriptSummary {
  sessionKey: string;
  fileName: string;
  modifiedAt: string;
  turnCount: number;
  firstUserMessage?: string;
  /** Absolute path to the session bucket (new layout) or undefined for legacy. */
  sessionDir?: string;
}

/**
 * List all persisted transcripts under the workspace, newest first. Scans the
 * new `sessions/<encodedKey>/transcript.jsonl` layout AND the legacy
 * `transcripts/<encodedKey>.jsonl` files so the picker shows every session
 * even after the upgrade. Per-session files always win on dedupe.
 */
export function listTranscripts(workspaceRoot: string): TranscriptSummary[] {
  const stateDir = getCliStateDir(workspaceRoot);
  const seen = new Map<string, TranscriptSummary>();

  // New layout: sessions/<encodedKey>/transcript.jsonl
  const sessionsDir = path.join(stateDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(sessionsDir, entry.name);
      const transcriptPath = path.join(sessionDir, TRANSCRIPT_FILE);
      if (!fs.existsSync(transcriptPath)) continue;
      const sessionKey = decodeSessionKey(entry.name);
      const summary = summarizeTranscript(transcriptPath, sessionKey, sessionDir);
      seen.set(sessionKey, summary);
    }
  }

  // Legacy layout: transcripts/<encodedKey>.jsonl
  const legacyDir = path.join(stateDir, 'transcripts');
  if (fs.existsSync(legacyDir)) {
    for (const fileName of fs.readdirSync(legacyDir)) {
      if (!fileName.endsWith('.jsonl')) continue;
      const encoded = fileName.slice(0, -'.jsonl'.length);
      const sessionKey = decodeSessionKey(encoded);
      if (seen.has(sessionKey)) continue;
      const filePath = path.join(legacyDir, fileName);
      seen.set(sessionKey, summarizeTranscript(filePath, sessionKey));
    }
  }

  return Array.from(seen.values()).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function summarizeTranscript(filePath: string, sessionKey: string, sessionDir?: string): TranscriptSummary {
  let modifiedAt = new Date(0).toISOString();
  let turnCount = 0;
  let firstUserMessage: string | undefined;
  try {
    modifiedAt = fs.statSync(filePath).mtime.toISOString();
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    turnCount = lines.length;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        if (entry.role === 'user' && typeof entry.content === 'string' && entry.content.trim()) {
          firstUserMessage = entry.content.toString().replace(/\s+/g, ' ').slice(0, 120);
          break;
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* unreadable file */ }
  return {
    sessionKey,
    fileName: path.basename(filePath),
    modifiedAt,
    turnCount,
    firstUserMessage,
    sessionDir,
  };
}

/**
 * Read all transcript entries for a session, in order. Used by `/resume`
 * to seed the Agent's chatHistory.
 */
export function loadTranscript(workspaceRoot: string, sessionKey: string): TranscriptEntry[] {
  return readTranscriptEntries(workspaceRoot, sessionKey, Number.MAX_SAFE_INTEGER);
}
