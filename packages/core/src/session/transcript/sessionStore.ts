/**
 * Durable transcript append, replay, discovery, and redaction.
 *
 * Exact session-key storage must remain collision-resistant, secrets are
 * redacted before disk writes, and peer delivery identity/trust metadata is
 * preserved so safe-boundary replay can stay idempotent after restart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  decodeSessionKey,
  encodeSessionKey,
  getStateDir,
  getSessionStateDir,
  isPathInside,
  isSafeLegacySessionEncoding,
  listSessionDirs,
  sessionEncodingRequiresExactMarker,
} from '../../storage/store.js';
import { canRewindTo, entriesAfterRewind } from './rewind.js';

export interface TranscriptEntry {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  /** Durable peer-delivery identity used to make safe-boundary replay idempotent. */
  deliveryId?: string;
  /** Peer content remains lower-authority after transcript resume. */
  trust?: 'untrusted-session';
  /** Authenticated sender metadata captured by the receiving host. */
  provenance?: Record<string, unknown>;
  isError?: boolean;
  timestamp: string;
}

/** History callers may supply pre-persistence entries without a timestamp. */
export type TranscriptReplayEntry = Omit<TranscriptEntry, 'timestamp'> & {
  timestamp?: string;
};

const SENSITIVE_TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]'],
  [/Basic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  // Raw headers end at a real newline. JSON-encoded headers end at an escaped
  // newline or the enclosing string quote; escaped quotes remain part of the
  // value. Keeping both forms avoids exposing quoted cookies or invalidating
  // the JSON representation used by redactTranscriptEntry().
  [/\b(?:Set-)?Cookie:[ \t]*(?:(?:\\(?![rn]).|[^\\\r\n"])*(?=\\[rn]|"(?=[ \t]*(?:[,}\]]|$)))|[^\r\n]*)/gi, 'Cookie: [REDACTED]'],
  [/\bbr_[A-Za-z0-9._-]{8,}\b/g, '[REDACTED]'],
  [/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[REDACTED]'],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g, '[REDACTED]'],
  [/\bgh[posru]_[A-Za-z0-9_]{8,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]'],
  // Exclude quotes and JSON delimiters from the URL tail so structured
  // transcript redaction cannot consume or invalidate the enclosing JSON.
  [/\b(?:postgres|postgresql|mongodb|mysql|mongodb\+srv|redis|sqlite):\/\/[^:\s"'\\]+:[^@\s"'\\]+@[^\s"',\]}\\]+/gi, '[REDACTED_CONN_STR]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]'],
  [/\b(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}\b/g, '[REDACTED_IP]'],
];

const ENV_SECRET_ASSIGNMENT = /(\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*[ \t]*=[ \t]*)("[^"\n]{6,}"|'[^'\n]{6,}'|[^\s,\]}]{6,})/g;

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
  return readTranscriptTail(workspaceRoot, sessionKey, limit, 0);
}

/**
 * WS8 — rewind a session's transcript to (and including) entry `targetIndex`,
 * rewriting the file in place. Blocked (no write) when code was generated after
 * the target (see {@link canRewindTo}). Returns the kept entries so the caller
 * can reload the agent's chatHistory from the rewound point.
 */
export function rewindTranscript(
  workspaceRoot: string,
  sessionKey: string,
  targetIndex: number,
): { ok: boolean; kept: TranscriptEntry[]; reason?: string } {
  const all = loadTranscript(workspaceRoot, sessionKey);
  const check = canRewindTo(all, targetIndex);
  if (!check.canRewind) return { ok: false, kept: all, reason: check.reason };
  const kept = entriesAfterRewind(all, targetIndex);
  const filePath = resolveExistingTranscriptPath(workspaceRoot, sessionKey) ?? getTranscriptPath(workspaceRoot, sessionKey);
  fs.writeFileSync(filePath, kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '', 'utf8');
  return { ok: true, kept };
}

/**
 * Bounded TAIL read for UI rendering — returns only the last `maxEntries`
 * transcript entries WITHOUT loading the whole file into memory. Full-history
 * `loadTranscript()` still has to allocate the complete transcript for agent
 * continuation export; UI paths use this bounded reader instead. This reads the
 * file BACKWARD in chunks, stops once it has enough
 * complete lines, parses them, and caps per-entry content so a single huge tool
 * result can't bloat the payload. Use this for any UI/sidebar/recap/search/
 * chapters/task view; keep loadTranscript() only for agent continuation export.
 */
export function readTranscriptTail(
  workspaceRoot: string,
  sessionKey: string,
  maxEntries = 400,
  maxCharsPerEntry = 50_000,
): TranscriptEntry[] {
  const filePath = resolveExistingTranscriptPath(workspaceRoot, sessionKey);
  if (!filePath) return [];
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const CHUNK = 64 * 1024;
    let pos = size;
    let buf = Buffer.alloc(0);
    let newlines = 0;
    // Read backward until we have one more newline than requested (so the first
    // kept line is whole) or reach the start of the file.
    while (pos > 0 && newlines <= maxEntries) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const chunk = Buffer.alloc(readLen);
      fs.readSync(fd, chunk, 0, readLen, pos);
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) newlines++;
      buf = Buffer.concat([chunk, buf]);
    }
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    const tail = lines.slice(Math.max(0, lines.length - maxEntries));
    const entries: TranscriptEntry[] = [];
    for (const line of tail) {
      try {
        const e = JSON.parse(line) as TranscriptEntry;
        if (maxCharsPerEntry > 0 && typeof e.content === 'string' && e.content.length > maxCharsPerEntry) {
          e.content = `${e.content.slice(0, maxCharsPerEntry)}\n…[${e.content.length - maxCharsPerEntry} more chars truncated for display]`;
        }
        entries.push(e);
      } catch { /* a partial boundary line — tolerate, like readTranscriptEntries */ }
    }
    return entries;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/** Cheap O(1) check that a session has a transcript on disk — used by lazy
 *  resume to avoid a full read just to know "are there messages to render". */
export function transcriptExists(workspaceRoot: string, sessionKey: string): boolean {
  return resolveExistingTranscriptPath(workspaceRoot, sessionKey) != null;
}

/** Cheap O(1) transcript byte size — a fast proxy for context fill on a lazily
 *  resumed session, so the context ring is ~right WITHOUT reading the content. */
export function transcriptSizeBytes(workspaceRoot: string, sessionKey: string): number {
  const p = resolveExistingTranscriptPath(workspaceRoot, sessionKey);
  if (!p) return 0;
  try { return fs.statSync(p).size; } catch { return 0; }
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
  const encoded = encodeSessionKey(sessionKey);
  if (!isSafeLegacySessionEncoding(encoded)) return undefined;
  const legacy = path.join(getStateDir(workspaceRoot), 'transcripts', `${encoded}.jsonl`);
  if (fs.existsSync(legacy)) return legacy;
  return undefined;
}

/**
 * DESK-6m — permanently delete a session: its `sessions/<key>/` state dir AND
 * any legacy `transcripts/<key>.jsonl`. Best-effort; returns whether anything
 * was removed. The caller also drops the session's UI meta.
 */
export function deleteSession(workspaceRoot: string, sessionKey: string): boolean {
  let removed = false;
  try {
    const encoded = encodeSessionKey(sessionKey);
    const dir = path.join(getStateDir(workspaceRoot), 'sessions', encoded);
    if (fs.existsSync(dir)) {
      const exact = !sessionEncodingRequiresExactMarker(encoded) ||
        listSessionDirs(workspaceRoot).some((entry) => entry.dir === dir && entry.sessionKey === sessionKey);
      if (exact) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed = true;
      }
    }
  } catch { /* best-effort */ }
  try {
    const encoded = encodeSessionKey(sessionKey);
    if (isSafeLegacySessionEncoding(encoded)) {
      const legacy = path.join(getStateDir(workspaceRoot), 'transcripts', `${encoded}.jsonl`);
      if (fs.existsSync(legacy)) { fs.rmSync(legacy, { force: true }); removed = true; }
    }
  } catch { /* best-effort */ }
  return removed;
}

/**
 * DESK-6m — duplicate a session's transcript into a brand-new sessionKey so the
 * user can branch a conversation. Returns the new key, or null if the source
 * has no transcript yet.
 */
export function forkSession(workspaceRoot: string, sessionKey: string, upToTs?: number): string | null {
  const src = resolveExistingTranscriptPath(workspaceRoot, sessionKey);
  if (!src) return null;
  const prefix = sessionKey.includes(':') ? sessionKey.slice(0, sessionKey.indexOf(':')) : sessionKey;
  const forkKey = `${prefix}:fork-${randomUUID().slice(0, 8)}`;
  const destDir = getSessionStateDir(workspaceRoot, forkKey); // creates the dir
  const destPath = path.join(destDir, TRANSCRIPT_FILE);
  // ADR-041 A41-14 (W2) — stamp the fork's lineage into its own bucket so it
  // travels with the session. Best-effort: a lineage write must never fail the fork.
  try {
    const lineage: SessionLineage = {
      parentSessionKey: sessionKey,
      forkedAt: new Date().toISOString(),
      ...(upToTs == null ? {} : { branchedAtTs: upToTs }),
    };
    fs.writeFileSync(path.join(destDir, LINEAGE_FILE), `${JSON.stringify(lineage)}\n`, 'utf8');
  } catch { /* best-effort — lineage is metadata, not the fork itself */ }
  if (upToTs == null) {
    fs.copyFileSync(src, destPath); // whole-conversation fork
  } else {
    // DESK-6v — branch from a specific message: keep only entries at or before
    // its timestamp, so the fork is the conversation UP TO that point. Lines
    // without a parseable timestamp are kept rather than silently dropped.
    const kept = fs.readFileSync(src, 'utf8').split('\n').filter((line) => {
      if (!line.trim()) return false;
      try { const ts = Date.parse((JSON.parse(line) as TranscriptEntry).timestamp); return Number.isNaN(ts) || ts <= upToTs; }
      catch { return true; }
    });
    fs.writeFileSync(destPath, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
  }
  return forkKey;
}

export function redactText(value: string): string {
  const redactedAssignments = value.replace(
    /((?:"(?:apiKey|api_key|BRAINROUTER_API_KEY|OPENAI_API_KEY)"|(?:apiKey|api_key|BRAINROUTER_API_KEY|OPENAI_API_KEY))\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,\]}]+)/gi,
    '$1"[REDACTED]"',
  );
  const redactedEnvironmentAssignments = redactedAssignments.replace(
    ENV_SECRET_ASSIGNMENT,
    '$1"[REDACTED]"',
  );
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    redactedEnvironmentAssignments,
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
  /**
   * ADR-041 A41-14 (W2) — the session this one was forked from, when it has a
   * lineage record. Undefined for a root session (never forked) or a legacy
   * transcript with no bucket. Lets any session list show "forked from …".
   */
  parentSessionKey?: string;
}

/**
 * ADR-041 A41-14 (W2) — a fork's lineage: which session it branched from, when,
 * and (for a mid-conversation branch) the timestamp it was cut at. Written into
 * the fork's bucket at fork time so lineage travels with the session, not a
 * central index that can drift.
 */
export interface SessionLineage {
  /** The session this one was forked from. */
  parentSessionKey: string;
  /** ISO time the fork was taken. */
  forkedAt: string;
  /** For a mid-conversation branch (`upToTs`), the cut point; absent for a whole-conversation fork. */
  branchedAtTs?: number;
}

const LINEAGE_FILE = 'lineage.json';

/** Read a session bucket's lineage record, or null when the session is a root (or legacy). */
export function readSessionLineage(sessionDir: string): SessionLineage | null {
  try {
    const raw = fs.readFileSync(path.join(sessionDir, LINEAGE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionLineage>;
    if (typeof parsed.parentSessionKey === 'string' && typeof parsed.forkedAt === 'string') {
      return {
        parentSessionKey: parsed.parentSessionKey,
        forkedAt: parsed.forkedAt,
        ...(typeof parsed.branchedAtTs === 'number' ? { branchedAtTs: parsed.branchedAtTs } : {}),
      };
    }
  } catch { /* no lineage record — a root session */ }
  return null;
}

/**
 * List all persisted transcripts under the workspace, newest first. Scans the
 * new `sessions/<encodedKey>/transcript.jsonl` layout AND the legacy
 * `transcripts/<encodedKey>.jsonl` files so the picker shows every session
 * even after the upgrade. Per-session files always win on dedupe.
 */
/** Ephemeral/internal sessions must never show up in the session picker.
 *  They use reserved path segments so normal user prompts like `fix-the-bug`
 *  remain visible while task transcripts stay in Background tasks. */
export function isInternalSessionKey(sessionKey: string): boolean {
  return /(^|:)(review|internal|fix):/i.test(sessionKey) || /(^|:)child:/i.test(sessionKey);
}

interface TranscriptCandidate {
  sessionKey: string;
  filePath: string;
  modifiedAt: string;
  sessionDir?: string;
}

export function listTranscripts(workspaceRoot: string, opts: { limit?: number } = {}): TranscriptSummary[] {
  const stateDir = getStateDir(workspaceRoot);
  const seen = new Set<string>();
  const candidates: TranscriptCandidate[] = [];
  const addCandidate = (candidate: Omit<TranscriptCandidate, 'modifiedAt'>): void => {
    if (seen.has(candidate.sessionKey)) return;
    seen.add(candidate.sessionKey);
    try {
      candidates.push({ ...candidate, modifiedAt: fs.statSync(candidate.filePath).mtime.toISOString() });
    } catch { /* unreadable transcript */ }
  };

  // New layout: sessions/<encodedKey>/transcript.jsonl
  const sessionsDir = path.join(stateDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const persisted of listSessionDirs(workspaceRoot)) {
      const sessionDir = persisted.dir;
      const transcriptPath = path.join(sessionDir, TRANSCRIPT_FILE);
      if (!fs.existsSync(transcriptPath)) continue;
      const sessionKey = persisted.sessionKey;
      if (isInternalSessionKey(sessionKey)) continue; // hide ephemeral task/internal sessions
      addCandidate({ sessionKey, filePath: transcriptPath, sessionDir });
    }
  }

  // Legacy layout: transcripts/<encodedKey>.jsonl
  const legacyDir = path.join(stateDir, 'transcripts');
  if (fs.existsSync(legacyDir)) {
    for (const fileName of fs.readdirSync(legacyDir)) {
      if (!fileName.endsWith('.jsonl')) continue;
      const encoded = fileName.slice(0, -'.jsonl'.length);
      if (!isSafeLegacySessionEncoding(encoded)) continue;
      const sessionKey = decodeSessionKey(encoded);
      if (seen.has(sessionKey) || isInternalSessionKey(sessionKey)) continue;
      const filePath = path.join(legacyDir, fileName);
      addCandidate({ sessionKey, filePath });
    }
  }

  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit ?? 0)) : undefined;
  const page = candidates
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, limit);
  return page.map((c) => summarizeTranscript(c.filePath, c.sessionKey, c.sessionDir));
}

function summarizeTranscript(filePath: string, sessionKey: string, sessionDir?: string): TranscriptSummary {
  let modifiedAt = new Date(0).toISOString();
  let turnCount = 0;
  let firstUserMessage: string | undefined;
  try {
    const stat = fs.statSync(filePath);
    modifiedAt = stat.mtime.toISOString();
    const exact = stat.size <= 1_000_000;
    const head = readFileHead(filePath, exact ? stat.size : Math.min(stat.size, 256 * 1024));
    const lines = head.split('\n').filter(Boolean);
    turnCount = exact ? lines.length : estimateLineCount(stat.size, head);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        // Skip injected system/guard messages (role:'user' WITH a name) so the
        // sidebar title is the user's real first prompt, never a guardrail note.
        if (entry.role === 'user' && !entry.name && typeof entry.content === 'string' && entry.content.trim()) {
          firstUserMessage = entry.content.toString().replace(/\s+/g, ' ').slice(0, 120);
          break;
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* unreadable file */ }
  const parentSessionKey = sessionDir ? readSessionLineage(sessionDir)?.parentSessionKey : undefined;
  return {
    sessionKey,
    fileName: path.basename(filePath),
    modifiedAt,
    turnCount,
    firstUserMessage,
    sessionDir,
    ...(parentSessionKey ? { parentSessionKey } : {}),
  };
}

function readFileHead(filePath: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

function estimateLineCount(fileSize: number, sample: string): number {
  const sampleBytes = Buffer.byteLength(sample);
  if (fileSize <= 0 || sampleBytes <= 0) return 0;
  const lines = Math.max(1, sample.split('\n').filter(Boolean).length);
  return Math.max(1, Math.round((fileSize / sampleBytes) * lines));
}

/**
 * Read all transcript entries for a session, in order. Used by `/resume`
 * to seed the Agent's chatHistory.
 */
export function loadTranscript(workspaceRoot: string, sessionKey: string): TranscriptEntry[] {
  return readTranscriptEntries(workspaceRoot, sessionKey, Number.MAX_SAFE_INTEGER);
}
