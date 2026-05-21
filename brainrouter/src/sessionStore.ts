import fs from 'node:fs';
import path from 'node:path';
import { getCliStateDir, isPathInside } from './cliState.js';

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

export function appendTranscriptEntry(workspaceRoot: string, sessionKey: string, entry: Omit<TranscriptEntry, 'timestamp'> & { timestamp?: string }): void {
  const filePath = getTranscriptPath(workspaceRoot, sessionKey);
  const payload: TranscriptEntry = redactTranscriptEntry({
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export function readTranscriptEntries(workspaceRoot: string, sessionKey: string, limit = 40): TranscriptEntry[] {
  const filePath = getTranscriptPath(workspaceRoot, sessionKey);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(Math.max(0, lines.length - limit)).map((line) => JSON.parse(line) as TranscriptEntry);
}

export function getTranscriptPath(workspaceRoot: string, sessionKey: string): string {
  const stateDir = getCliStateDir(workspaceRoot);
  const transcriptsDir = path.join(stateDir, 'transcripts');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  const filePath = path.join(transcriptsDir, `${encodeSessionKey(sessionKey)}.jsonl`);
  if (!isPathInside(transcriptsDir, filePath)) {
    throw new Error('Transcript path escapes transcript directory.');
  }
  return filePath;
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

function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, 'utf8')
    .toString('base64url')
    .slice(0, 180);
}

function decodeSessionKey(encoded: string): string {
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return encoded;
  }
}

export interface TranscriptSummary {
  sessionKey: string;
  fileName: string;
  modifiedAt: string;
  turnCount: number;
  firstUserMessage?: string;
}

/**
 * List all persisted transcripts under the workspace, newest first.
 * Used by `/sessions` to render a picker for `/resume`.
 */
export function listTranscripts(workspaceRoot: string): TranscriptSummary[] {
  const stateDir = getCliStateDir(workspaceRoot);
  const transcriptsDir = path.join(stateDir, 'transcripts');
  if (!fs.existsSync(transcriptsDir)) return [];
  const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.jsonl'));
  const summaries: TranscriptSummary[] = files.map((fileName) => {
    const filePath = path.join(transcriptsDir, fileName);
    const stat = fs.statSync(filePath);
    const encoded = fileName.slice(0, -'.jsonl'.length);
    const sessionKey = decodeSessionKey(encoded);
    let turnCount = 0;
    let firstUserMessage: string | undefined;
    try {
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
      fileName,
      modifiedAt: stat.mtime.toISOString(),
      turnCount,
      firstUserMessage,
    };
  });
  return summaries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * Read all transcript entries for a session, in order. Used by `/resume`
 * to seed the Agent's chatHistory.
 */
export function loadTranscript(workspaceRoot: string, sessionKey: string): TranscriptEntry[] {
  return readTranscriptEntries(workspaceRoot, sessionKey, Number.MAX_SAFE_INTEGER);
}
