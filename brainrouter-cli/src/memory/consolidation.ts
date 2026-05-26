import fs from 'node:fs';
import path from 'node:path';
import type { McpClientPool as McpClientWrapper } from '../runtime/mcpPool.js';
import { callMcpTool } from '../runtime/mcpUtils.js';
import { getWorkspaceStateRoot } from '../state/cliState.js';

/**
 * Filesystem memory consolidation — the human-readable companion to the
 * cognitive memory database.
 *
 * Brainrouter's MCP already stores recall records in the cognitive memory DB.
 * This module writes filesystem artifacts so users get a human-readable view
 * of what was learned across sessions:
 *
 *   ~/.brainrouter/workspaces/<encoded>/memories/
 *     MEMORY.md              - one-line index of all consolidated entries
 *     raw_memories.md        - merged "raw" memories in stable order
 *     user.md                - profile facts about the user
 *     feedback.md            - "do this / don't do this" guidance
 *     project.md             - in-flight project context
 *     reference.md           - pointers to external systems
 *     rollout_summaries/     - one .md per recent session summary
 *
 * The CLI populates these from `memory_search`/`memory_recall` results at the
 * end of a session or when the user runs `/memories consolidate`. This file is
 * pure — it never calls the LLM; the records were already extracted by the
 * agent loop and stored via memory_capture_turn.
 */

export function memoriesDir(workspaceRoot: string): string {
  return path.join(getWorkspaceStateRoot(workspaceRoot), 'memories');
}

export function ensureMemoriesDir(workspaceRoot: string): string {
  const dir = memoriesDir(workspaceRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const summaries = path.join(dir, 'rollout_summaries');
  if (!fs.existsSync(summaries)) fs.mkdirSync(summaries, { recursive: true });
  return dir;
}

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryRecord {
  recordId: string;
  type: MemoryType | string;
  content: string;
  scene?: string;
  capturedAt?: string;
}

interface ConsolidationResult {
  totalRecords: number;
  perType: Record<string, number>;
  files: string[];
}

/**
 * Pull every memory record we can see from MCP and write the per-type
 * markdown files. Records without a known type land in `raw_memories.md` so
 * nothing is lost.
 */
export async function consolidateMemories(
  mcpClient: McpClientWrapper,
  workspaceRoot: string,
  options: { sessionKey?: string; query?: string } = {},
): Promise<ConsolidationResult> {
  const dir = ensureMemoriesDir(workspaceRoot);
  const query = options.query ?? '*';
  const recall = await callMcpTool<any>(mcpClient, 'memory_search', { query, sessionKey: options.sessionKey });
  if (recall.isError) {
    throw new Error(`memory_search failed: ${recall.text || '(no message)'}`);
  }

  const records = extractRecordsFromMcp(recall.parsed);
  const buckets: Record<string, MemoryRecord[]> = {
    user: [], feedback: [], project: [], reference: [], raw: [],
  };
  for (const rec of records) {
    const t = String(rec.type ?? '').toLowerCase();
    if (t === 'user' || t === 'feedback' || t === 'project' || t === 'reference') {
      buckets[t].push(rec);
    } else {
      buckets.raw.push(rec);
    }
  }

  const filesWritten: string[] = [];
  for (const t of ['user', 'feedback', 'project', 'reference', 'raw'] as const) {
    const file = path.join(dir, t === 'raw' ? 'raw_memories.md' : `${t}.md`);
    fs.writeFileSync(file, renderMemoryFile(t, buckets[t]), 'utf8');
    filesWritten.push(file);
  }

  const index = renderIndex(records, buckets);
  const indexFile = path.join(dir, 'MEMORY.md');
  fs.writeFileSync(indexFile, index, 'utf8');
  filesWritten.push(indexFile);

  return {
    totalRecords: records.length,
    perType: {
      user: buckets.user.length,
      feedback: buckets.feedback.length,
      project: buckets.project.length,
      reference: buckets.reference.length,
      raw: buckets.raw.length,
    },
    files: filesWritten.map((p) => path.relative(workspaceRoot, p)),
  };
}

function extractRecordsFromMcp(parsed: any): MemoryRecord[] {
  if (!parsed) return [];
  const candidates = [
    parsed?.records,
    parsed?.results,
    parsed?.items,
    Array.isArray(parsed) ? parsed : undefined,
  ].filter((x): x is any[] => Array.isArray(x));
  for (const list of candidates) {
    const out: MemoryRecord[] = [];
    for (const r of list) {
      if (!r) continue;
      const recordId = String(r.recordId ?? r.id ?? r.record_id ?? '');
      if (!recordId) continue;
      out.push({
        recordId,
        type: String(r.type ?? r.memoryType ?? 'raw'),
        content: String(r.content ?? r.text ?? r.body ?? r.summary ?? ''),
        scene: r.scene ?? r.focusScene,
        capturedAt: r.capturedAt ?? r.createdAt ?? r.timestamp,
      });
    }
    if (out.length > 0) return out;
  }
  return [];
}

function renderMemoryFile(type: string, records: MemoryRecord[]): string {
  const heading = type === 'raw' ? 'Raw memories' : `${capitalize(type)} memory`;
  const intro = type === 'raw'
    ? 'Memories whose type the agent did not classify into user/feedback/project/reference.'
    : descriptionFor(type);
  const body = records.length === 0
    ? '_(empty — no records of this type yet)_'
    : records.sort(stableSort).map(renderRecord).join('\n\n');
  return [`# ${heading}`, '', intro, '', body, ''].join('\n');
}

function descriptionFor(type: string): string {
  switch (type) {
    case 'user': return 'Profile facts about the user — role, expertise, goals.';
    case 'feedback': return 'Validated guidance from the user about how to approach work (do/avoid).';
    case 'project': return 'In-flight project context: deadlines, stakeholders, motivation.';
    case 'reference': return 'Pointers to external systems (Linear, Grafana, GitHub) where authoritative info lives.';
    default: return '';
  }
}

function renderRecord(rec: MemoryRecord): string {
  const lines: string[] = [];
  lines.push(`## ${rec.recordId}`);
  if (rec.scene) lines.push(`*Scene: ${rec.scene}*`);
  if (rec.capturedAt) lines.push(`*Captured: ${rec.capturedAt}*`);
  lines.push('');
  lines.push(rec.content.trim());
  return lines.join('\n');
}

function renderIndex(records: MemoryRecord[], buckets: Record<string, MemoryRecord[]>): string {
  const lines: string[] = [];
  lines.push('# Memory index');
  lines.push('');
  lines.push(`_${records.length} consolidated memory records across ${Object.keys(buckets).length} files._`);
  lines.push('');
  for (const t of ['user', 'feedback', 'project', 'reference', 'raw'] as const) {
    const list = buckets[t];
    if (list.length === 0) continue;
    const file = t === 'raw' ? 'raw_memories.md' : `${t}.md`;
    lines.push(`## ${capitalize(t)} (${list.length})`);
    lines.push(`File: [${file}](${file})`);
    lines.push('');
    for (const r of list.slice(0, 12).sort(stableSort)) {
      const oneLine = r.content.split('\n')[0].slice(0, 140);
      lines.push(`- \`${r.recordId}\` — ${oneLine}`);
    }
    if (list.length > 12) lines.push(`- _…and ${list.length - 12} more in ${file}_`);
    lines.push('');
  }
  return lines.join('\n');
}

function stableSort(a: MemoryRecord, b: MemoryRecord): number {
  return a.recordId.localeCompare(b.recordId);
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * Write a per-session rollout summary file. Used by /handover or auto-capture
 * at session end. Each summary lives alongside the others so users can scan
 * across sessions without trawling transcripts.
 */
export function writeRolloutSummary(
  workspaceRoot: string,
  sessionKey: string,
  summary: { firstPrompt?: string; lastPrompt?: string; turnCount: number; totalTokens: number; body: string },
): string {
  ensureMemoriesDir(workspaceRoot);
  const safe = sessionKey.replace(/[^A-Za-z0-9._-]+/g, '-');
  const file = path.join(memoriesDir(workspaceRoot), 'rollout_summaries', `${safe}.md`);
  const lines: string[] = [];
  lines.push(`# Session: ${sessionKey}`);
  lines.push('');
  lines.push(`- Turns: ${summary.turnCount}`);
  lines.push(`- Total tokens: ${summary.totalTokens}`);
  if (summary.firstPrompt) lines.push(`- First prompt: ${truncate(summary.firstPrompt, 200)}`);
  if (summary.lastPrompt) lines.push(`- Last prompt: ${truncate(summary.lastPrompt, 200)}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(summary.body.trim());
  lines.push('');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return path.relative(workspaceRoot, file);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
