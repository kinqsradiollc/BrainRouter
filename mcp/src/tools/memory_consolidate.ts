import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { memoryEngine } from '../memory/engine.js';

/**
 * MCP-side memory consolidation. Collapses recall records into per-type
 * markdown files under `<workspace>/.brainrouter/memories/` so the user
 * has a human-readable view of what the cognitive memory engine has
 * learned across sessions.
 *
 * The MCP server already exposes recall + capture. This tool exposes the
 * filesystem consolidation step so any MCP-speaking client can write the
 * same artifacts without re-implementing the bucketing logic.
 */

export const memoryConsolidateToolSchema = {
  name: 'memory_consolidate',
  description:
    'Read recent memory records and write them to per-type markdown files ' +
    '(user.md, feedback.md, project.md, reference.md, raw_memories.md, MEMORY.md) ' +
    'under <workspacePath>/.brainrouter/memories/. Use this at session end or on demand ' +
    'to produce a human-readable consolidation of what the agent learned.',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User identifier for isolation' },
      sessionKey: { type: 'string', description: 'Session identifier' },
      workspacePath: { type: 'string', description: 'Absolute path to the workspace where files will be written.' },
      query: { type: 'string', description: 'Optional query to filter records before consolidation. Defaults to "*".' },
      limit: { type: 'number', description: 'Max records to consider (default 200).' },
    },
    required: ['sessionKey', 'workspacePath'],
  },
};

const inputSchema = z.object({
  userId: z.string().optional(),
  sessionKey: z.string(),
  workspacePath: z.string(),
  query: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'raw';

interface MemoryRecord {
  recordId: string;
  type: string;
  content: string;
  scene?: string;
  capturedAt?: string;
}

export async function handleMemoryConsolidate(args: unknown, options?: { defaultUserId?: string }) {
  const params = inputSchema.parse(args);
  const effectiveUserId = params.userId ?? options?.defaultUserId ?? 'default';
  const limit = params.limit ?? 200;
  const query = params.query ?? '*';

  try {
    const result = await memoryEngine.recall({
      userId: effectiveUserId,
      sessionKey: params.sessionKey,
      query,
    });
    const records = extractRecords((result as any) ?? {});
    if (records.length > limit) records.length = limit;

    const dir = path.join(params.workspacePath, '.brainrouter', 'memories');
    fs.mkdirSync(path.join(dir, 'rollout_summaries'), { recursive: true });

    const buckets: Record<MemoryType, MemoryRecord[]> = { user: [], feedback: [], project: [], reference: [], raw: [] };
    for (const rec of records) {
      const t = String(rec.type ?? '').toLowerCase();
      if (t === 'user' || t === 'feedback' || t === 'project' || t === 'reference') {
        buckets[t].push(rec);
      } else {
        buckets.raw.push(rec);
      }
    }

    const filesWritten: string[] = [];
    for (const t of ['user', 'feedback', 'project', 'reference', 'raw'] as MemoryType[]) {
      const file = path.join(dir, t === 'raw' ? 'raw_memories.md' : `${t}.md`);
      fs.writeFileSync(file, renderTypeFile(t, buckets[t]), 'utf8');
      filesWritten.push(path.relative(params.workspacePath, file));
    }
    const indexFile = path.join(dir, 'MEMORY.md');
    fs.writeFileSync(indexFile, renderIndex(records, buckets), 'utf8');
    filesWritten.push(path.relative(params.workspacePath, indexFile));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalRecords: records.length,
          perType: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
          files: filesWritten,
          dir: path.relative(params.workspacePath, dir),
        }, null, 2),
      }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: 'text', text: `memory_consolidate failed: ${err.message}` }],
    };
  }
}

function extractRecords(parsed: any): MemoryRecord[] {
  if (!parsed) return [];
  const sources = [
    parsed.records, parsed.results, parsed.items,
    Array.isArray(parsed) ? parsed : undefined,
  ].filter((x): x is any[] => Array.isArray(x));
  for (const list of sources) {
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

function renderTypeFile(type: MemoryType, records: MemoryRecord[]): string {
  const heading = type === 'raw' ? 'Raw memories' : `${cap(type)} memory`;
  const intro = type === 'raw'
    ? 'Memories that were not classified into user/feedback/project/reference.'
    : descriptionFor(type);
  if (records.length === 0) {
    return `# ${heading}\n\n${intro}\n\n_(empty — no records of this type yet)_\n`;
  }
  const body = records.sort((a, b) => a.recordId.localeCompare(b.recordId)).map(renderRecord).join('\n\n');
  return `# ${heading}\n\n${intro}\n\n${body}\n`;
}

function renderRecord(rec: MemoryRecord): string {
  const lines: string[] = [`## ${rec.recordId}`];
  if (rec.scene) lines.push(`*Scene: ${rec.scene}*`);
  if (rec.capturedAt) lines.push(`*Captured: ${rec.capturedAt}*`);
  lines.push('', rec.content.trim());
  return lines.join('\n');
}

function renderIndex(records: MemoryRecord[], buckets: Record<MemoryType, MemoryRecord[]>): string {
  const lines: string[] = [];
  lines.push('# Memory index');
  lines.push('');
  lines.push(`_${records.length} consolidated memory records across ${Object.keys(buckets).length} files._`);
  lines.push('');
  for (const t of ['user', 'feedback', 'project', 'reference', 'raw'] as MemoryType[]) {
    const list = buckets[t];
    if (list.length === 0) continue;
    const file = t === 'raw' ? 'raw_memories.md' : `${t}.md`;
    lines.push(`## ${cap(t)} (${list.length})`);
    lines.push(`File: [${file}](${file})`);
    lines.push('');
    for (const r of list.slice(0, 12)) {
      lines.push(`- \`${r.recordId}\` — ${r.content.split('\n')[0].slice(0, 140)}`);
    }
    if (list.length > 12) lines.push(`- _…and ${list.length - 12} more in ${file}_`);
    lines.push('');
  }
  return lines.join('\n');
}

function descriptionFor(type: MemoryType): string {
  switch (type) {
    case 'user': return 'Profile facts about the user — role, expertise, goals.';
    case 'feedback': return 'Validated guidance from the user about how to approach work (do/avoid).';
    case 'project': return 'In-flight project context: deadlines, stakeholders, motivation.';
    case 'reference': return 'Pointers to external systems (Linear, Grafana, GitHub) where authoritative info lives.';
    default: return '';
  }
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
