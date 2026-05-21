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
