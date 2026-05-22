import type { McpClientWrapper } from './mcpClient.js';
import { redactText } from './sessionStore.js';
import { callMcpTool } from './mcpUtils.js';

export interface BriefingInputs {
  mcpClient: McpClientWrapper;
  mcpTools: Array<{ name: string }>;
  sessionKey: string;
  workspaceRoot: string;
  query: string;
  activeSkill?: string;
  /** Cap on injected briefing content per source — guards against runaway payloads eating the context window. */
  maxCharsPerSource?: number;
}

export interface RecalledRecord {
  recordId: string;
  content?: string;
  type?: string;
  priority?: number;
}

export interface BriefingResult {
  /** A single markdown block to be injected as a system message before the turn. Empty if nothing was recalled. */
  block: string;
  /** Recalled record IDs, used downstream for memory_mark_cited. */
  recalledRecordIds: string[];
  /** Recalled record content snippets, used for the citation heuristic. */
  recalledRecords: RecalledRecord[];
  /** Names of MCP tools we actually consulted (for telemetry / /briefing). */
  sourcesQueried: string[];
}

/**
 * Run pre-turn memory queries in parallel and assemble a compact briefing block.
 * This is the System-1 entry point: every turn pays a small fixed cost to ask
 * the BrainRouter brain "what do I already know that matters here?" so the LLM
 * does not redo work the agent has done before in this workspace.
 */
export async function buildMemoryBriefing(inputs: BriefingInputs): Promise<BriefingResult> {
  const { mcpClient, mcpTools, sessionKey, workspaceRoot, query, activeSkill } = inputs;
  const maxChars = inputs.maxCharsPerSource ?? 4000;
  const toolNames = new Set(mcpTools.map((t) => t.name));

  const tasks: Array<Promise<{ source: string; text: string | null; records?: RecalledRecord[] }>> = [];

  if (toolNames.has('memory_recall')) {
    tasks.push(callSafe('memory_recall', { sessionKey, query, activeSkill }, mcpClient, maxChars, extractRecords));
  }
  if (toolNames.has('memory_working_context')) {
    tasks.push(callSafe('memory_working_context', { sessionKey, workspacePath: workspaceRoot }, mcpClient, maxChars));
  }
  if (toolNames.has('memory_task_state')) {
    tasks.push(callSafe('memory_task_state', { query }, mcpClient, maxChars));
  }

  const results = await Promise.all(tasks);

  const sections: string[] = [];
  const sourcesQueried: string[] = [];
  const recalledRecords: RecalledRecord[] = [];
  for (const r of results) {
    if (!r.text) continue;
    sourcesQueried.push(r.source);
    if (r.records && r.records.length > 0) {
      // Render structured cards instead of dumping the raw JSON. The previous
      // form emitted ~2-4KB of `recallExplanation`/`sparkedNodes`/etc. per
      // turn — high signal-to-noise loss AND a 4000-char hard slice that
      // routinely chopped the payload mid-string. Cards are ~120 chars each.
      const cards = r.records.slice(0, 8).map((rec) => {
        const idTag = `[${rec.recordId}]`;
        const typeTag = rec.type ? ` (${rec.type})` : '';
        const content = (rec.content ?? '').replace(/\s+/g, ' ').trim();
        const preview = content.length > 240 ? content.slice(0, 239) + '…' : content;
        return `- ${idTag}${typeTag} ${preview}`;
      });
      sections.push(`### ${prettyLabel(r.source)}\n${cards.join('\n')}`);
      recalledRecords.push(...r.records);
    } else {
      // No structured records to render. Treat the JSON dump as opaque and
      // only include it when it carries actual signal (skip the
      // `keyword-empty` / zero-hits responses that the MCP returns when
      // recall genuinely had nothing to surface).
      const trimmed = r.text.trim();
      if (
        !trimmed ||
        /"recallStrategy"\s*:\s*"(keyword|hybrid)-empty"/.test(trimmed) ||
        /^[\s\S]{0,40}"ftsHits"\s*:\s*0\s*,\s*"vecHits"\s*:\s*0/.test(trimmed)
      ) {
        continue;
      }
      sections.push(`### ${prettyLabel(r.source)}\n${redactText(trimmed.slice(0, 1500))}`);
    }
  }

  if (sections.length === 0) {
    return { block: '', recalledRecordIds: [], recalledRecords: [], sourcesQueried };
  }

  const block = [
    '## BrainRouter Memory Briefing',
    `Session: ${sessionKey}`,
    `Workspace: ${workspaceRoot}`,
    '',
    'The following context was recalled before this turn. Cite the IDs of records you actually used in your reasoning.',
    '',
    ...sections,
  ].join('\n');

  const recalledRecordIds = dedupe(recalledRecords.map((r) => r.recordId));
  return { block, recalledRecordIds, recalledRecords, sourcesQueried };
}

/**
 * Heuristic for which recalled records actually informed the assistant's
 * final answer. We mark a record as "cited" when:
 *  - its recordId literally appears in the answer text, OR
 *  - a distinctive snippet (≥ 24 chars of non-trivial content) from its
 *    content appears verbatim in the answer.
 * Conservative on purpose — false positives hurt memory quality more than
 * false negatives, since uncited records get demoted next time around.
 */
export function selectCitedRecordIds(records: RecalledRecord[], finalAnswer: string): string[] {
  if (!finalAnswer || records.length === 0) return [];
  const haystack = finalAnswer.toLowerCase();
  const cited: string[] = [];
  for (const record of records) {
    if (!record.recordId) continue;
    if (haystack.includes(record.recordId.toLowerCase())) {
      cited.push(record.recordId);
      continue;
    }
    const snippet = extractDistinctiveSnippet(record.content);
    if (snippet && haystack.includes(snippet.toLowerCase())) {
      cited.push(record.recordId);
    }
  }
  return dedupe(cited);
}

function extractDistinctiveSnippet(content?: string): string | undefined {
  if (!content) return undefined;
  const trimmed = content.trim();
  if (trimmed.length < 24) return undefined;
  // Use the longest line that looks like substantive content; skip headings / bullets.
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ranked = lines
    .filter((l) => !/^[#>\-*]/.test(l) && l.length >= 24)
    .sort((a, b) => b.length - a.length);
  const candidate = ranked[0] ?? trimmed;
  return candidate.slice(0, Math.min(60, candidate.length));
}

async function callSafe(
  toolName: string,
  args: Record<string, unknown>,
  mcpClient: McpClientWrapper,
  maxChars: number,
  extractRecordsFn?: (parsed: any) => RecalledRecord[],
): Promise<{ source: string; text: string | null; records?: RecalledRecord[] }> {
  const res = await callMcpTool(mcpClient, toolName, args);
  if (res.isError || !res.text.trim()) return { source: toolName, text: null };
  const records = extractRecordsFn && res.parsed ? extractRecordsFn(res.parsed) : undefined;
  return { source: toolName, text: res.text.slice(0, maxChars), records };
}

function extractRecords(parsed: any): RecalledRecord[] {
  if (!parsed) return [];
  const records =
    parsed.recalledCognitiveMemories ??
    parsed.recalledCognitiveRecords ??
    parsed.records ??
    [];
  if (!Array.isArray(records)) return [];
  return records
    .filter((r: any) => r && (typeof r.recordId === 'string' || typeof r.recordId === 'number'))
    .map((r: any) => ({
      recordId: String(r.recordId),
      content: typeof r.content === 'string' ? r.content : undefined,
      type: typeof r.type === 'string' ? r.type : undefined,
      priority: typeof r.priority === 'number' ? r.priority : undefined,
    }));
}

function prettyLabel(toolName: string): string {
  switch (toolName) {
    case 'memory_recall': return 'Recalled cognitive memories';
    case 'memory_working_context': return 'Working memory canvas';
    case 'memory_task_state': return 'Open task / handover state';
    default: return toolName;
  }
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
