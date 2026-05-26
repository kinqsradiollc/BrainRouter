import type { McpClientPool as McpClientWrapper } from '../runtime/mcpPool.js';
import { redactText } from '../state/sessionStore.js';
import { callMcpTool, hasMcpTool } from '../runtime/mcpUtils.js';
import { extractFilePathHints, looksLikeDebugOrRetry } from './briefingTriggers.js';

export interface BriefingInputs {
  mcpClient: McpClientWrapper;
  mcpTools: Array<{ name: string }>;
  sessionKey: string;
  workspaceRoot: string;
  query: string;
  activeSkill?: string;
  /** Cap on injected briefing content per source — guards against runaway payloads eating the context window. */
  maxCharsPerSource?: number;
  sourcePlan?: BriefingSourcePlan;
  /**
   * Set by the caller when a `goal-anchor` system message is already
   * carrying the current objective. The briefing skips `memory_task_state`
   * in that case to avoid double-injecting the "what we're doing right
   * now" context — the goal-anchor is the authoritative owner. When
   * there is no active goal (pre-goal exploration, after `/goal pause`,
   * silent child agents) the task-state surface still fires so handover
   * notes and prior blockers stay visible. Part of 0.3.6 item 9d.
   */
  hasActiveGoal?: boolean;
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
  /** Names of sources the router planned before availability checks. */
  sourcesPlanned: string[];
  /** Sources skipped because the MCP tool was absent or a required cue was missing. */
  skippedSources: Array<{ source: string; reason: string }>;
  /** Source-level stats for the `/briefing` inspector. */
  sourceStats: Array<{ source: string; chars: number; records: number }>;
  warnings: string[];
}

export interface BriefingSourcePlan {
  includeRecall: boolean;
  includeWorkingContext: boolean;
  includeTaskState: boolean;
  includeExplainRecall: boolean;
  fileHistoryPaths: string[];
  includeFailedAttempts: boolean;
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
  const sourcePlan = inputs.sourcePlan ?? buildDefaultSourcePlan(query, inputs.hasActiveGoal);
  const sourcesPlanned = describeSourcePlan(sourcePlan);
  const skippedSources: Array<{ source: string; reason: string }> = [];
  const warnings: string[] = [];

  const tasks: Array<Promise<{ source: string; text: string | null; records?: RecalledRecord[] }>> = [];

  if (sourcePlan.includeRecall && hasMcpTool(toolNames, 'memory_recall')) {
    tasks.push(callSafe('memory_recall', { sessionKey, query, activeSkill }, mcpClient, maxChars, extractRecords));
  } else if (sourcePlan.includeRecall) {
    skippedSources.push({ source: 'memory_recall', reason: 'tool unavailable' });
  }
  if (sourcePlan.includeWorkingContext && hasMcpTool(toolNames, 'memory_working_context')) {
    tasks.push(callSafe('memory_working_context', { sessionKey, workspacePath: workspaceRoot }, mcpClient, maxChars));
  } else if (sourcePlan.includeWorkingContext) {
    skippedSources.push({ source: 'memory_working_context', reason: 'tool unavailable' });
  }
  if (sourcePlan.includeTaskState && hasMcpTool(toolNames, 'memory_task_state') && !inputs.hasActiveGoal) {
    tasks.push(callSafe('memory_task_state', { query }, mcpClient, maxChars));
  } else if (sourcePlan.includeTaskState && inputs.hasActiveGoal) {
    skippedSources.push({ source: 'memory_task_state', reason: 'active goal-anchor owns task state' });
  } else if (sourcePlan.includeTaskState) {
    skippedSources.push({ source: 'memory_task_state', reason: 'tool unavailable' });
  }
  if (sourcePlan.includeExplainRecall && hasMcpTool(toolNames, 'memory_explain_recall')) {
    tasks.push(callSafe('memory_explain_recall', { sessionKey, query, activeSkill }, mcpClient, maxChars));
  } else if (sourcePlan.includeExplainRecall) {
    skippedSources.push({ source: 'memory_explain_recall', reason: 'tool unavailable' });
  }
  if (sourcePlan.includeFailedAttempts && hasMcpTool(toolNames, 'memory_failed_attempts')) {
    tasks.push(callSafe('memory_failed_attempts', { query, limit: 5 }, mcpClient, maxChars, extractRecords));
  } else if (sourcePlan.includeFailedAttempts) {
    skippedSources.push({ source: 'memory_failed_attempts', reason: 'tool unavailable' });
  }
  if (sourcePlan.fileHistoryPaths.length > 0 && hasMcpTool(toolNames, 'memory_file_history')) {
    for (const filePath of sourcePlan.fileHistoryPaths.slice(0, 3)) {
      tasks.push(callSafe('memory_file_history', { filePath, limit: 5 }, mcpClient, maxChars, extractRecords));
    }
  } else if (sourcePlan.fileHistoryPaths.length > 0) {
    skippedSources.push({ source: 'memory_file_history', reason: 'tool unavailable' });
  }

  const results = await Promise.all(tasks);

  const sections: string[] = [];
  const sourcesQueried: string[] = [];
  const recalledRecords: RecalledRecord[] = [];
  const sourceStats: Array<{ source: string; chars: number; records: number }> = [];
  for (const r of results) {
    if (!r.text) continue;
    sourcesQueried.push(r.source);
    sourceStats.push({ source: r.source, chars: r.text.length, records: r.records?.length ?? 0 });
    if (r.source === 'memory_working_context') {
      const workingSection = renderWorkingMemorySection(r.text);
      if (workingSection) {
        sections.push(workingSection);
        continue;
      }
      // Fall through to the opaque-dump branch when the payload didn't
      // match the expected shape — that path runs redactText and keeps
      // the secrets test honest.
    }
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
      if (/stale|superseded|archived|needs_verification/i.test(trimmed)) {
        warnings.push(`${r.source} may contain stale or low-confidence records`);
      }
      sections.push(`### ${prettyLabel(r.source)}\n${redactText(trimmed.slice(0, 1500))}`);
    }
  }

  if (sections.length === 0) {
    return { block: '', recalledRecordIds: [], recalledRecords: [], sourcesQueried, sourcesPlanned, skippedSources, sourceStats, warnings };
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
  return { block, recalledRecordIds, recalledRecords, sourcesQueried, sourcesPlanned, skippedSources, sourceStats, warnings };
}

export function buildDefaultSourcePlan(query: string, hasActiveGoal?: boolean): BriefingSourcePlan {
  const fileHistoryPaths = extractFilePathHints(query);
  const debugCue = looksLikeDebugOrRetry(query);
  return {
    includeRecall: true,
    includeWorkingContext: true,
    includeTaskState: !hasActiveGoal,
    includeExplainRecall: debugCue || fileHistoryPaths.length > 0,
    fileHistoryPaths,
    includeFailedAttempts: debugCue,
  };
}

function describeSourcePlan(plan: BriefingSourcePlan): string[] {
  const sources: string[] = [];
  if (plan.includeRecall) sources.push('memory_recall');
  if (plan.includeWorkingContext) sources.push('memory_working_context');
  if (plan.includeTaskState) sources.push('memory_task_state');
  if (plan.includeExplainRecall) sources.push('memory_explain_recall');
  if (plan.includeFailedAttempts) sources.push('memory_failed_attempts');
  if (plan.fileHistoryPaths.length > 0) sources.push('memory_file_history');
  return sources;
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
    (Array.isArray(parsed) ? parsed : undefined) ??
    parsed.recalledCognitiveMemories ??
    parsed.recalledCognitiveRecords ??
    parsed.records ??
    parsed.hits ??
    [];
  if (!Array.isArray(records)) return [];
  return records
    .filter((r: any) => r && (
      typeof r.recordId === 'string' ||
      typeof r.recordId === 'number' ||
      typeof r.record_id === 'string' ||
      typeof r.id === 'string'
    ))
    .map((r: any) => ({
      recordId: String(r.recordId ?? r.record_id ?? r.id),
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
    case 'memory_explain_recall': return 'Recall explanation';
    case 'memory_failed_attempts': return 'Prior failed attempts';
    case 'memory_file_history': return 'File history';
    default: return toolName;
  }
}

interface WorkingStepShape {
  nodeId?: string;
  title?: string;
  summary?: string;
  kind?: string;
}

/**
 * 0.3.6 item 2c — structurally surface working-memory steps in the
 * briefing. Two slices:
 *   - the recentSteps tail the MCP already injected (last 5–10 steps,
 *     regardless of kind), which gives the model the latest tool
 *     outputs in order; and
 *   - up to 3 most-recent reasoning-kind steps from the full step log,
 *     which keeps the "why" trail visible even after a chatty tool
 *     burst has pushed reasoning off the tail.
 *
 * Returns null when the payload doesn't look like a working-context
 * JSON blob — caller falls back to the opaque-dump branch so secrets
 * still get redacted on unstructured text.
 */
function renderWorkingMemorySection(text: string): string | null {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const recentSteps: WorkingStepShape[] = Array.isArray(parsed?.state?.injectedState?.recentSteps)
    ? parsed.state.injectedState.recentSteps
    : [];
  const allSteps: WorkingStepShape[] = Array.isArray(parsed?.steps) ? parsed.steps : recentSteps;
  if (recentSteps.length === 0 && allSteps.length === 0) return null;

  const renderStep = (step: WorkingStepShape): string => {
    const kind = step.kind ? `[${step.kind}] ` : '';
    const title = (step.title ?? '').replace(/\s+/g, ' ').trim() || '(no title)';
    const summary = (step.summary ?? '').replace(/\s+/g, ' ').trim();
    const preview = summary.length > 200 ? summary.slice(0, 199) + '…' : summary;
    return `- ${kind}${title}${preview ? ` — ${preview}` : ''}`;
  };

  const lines: string[] = [`### ${prettyLabel('memory_working_context')}`];
  if (recentSteps.length > 0) {
    lines.push('Recent steps:');
    for (const step of recentSteps) lines.push(renderStep(step));
  }

  // Surface up to 3 most-recent reasoning-kind steps that the recentSteps
  // tail didn't already include. Cap on purpose — without it a turn that
  // offloaded reasoning every batch would stuff the briefing with its own
  // past commentary.
  const recentNodeIds = new Set(recentSteps.map((s) => s.nodeId).filter(Boolean));
  const reasoningTail = allSteps
    .filter((s) => s.kind === 'reasoning' && (!s.nodeId || !recentNodeIds.has(s.nodeId)))
    .slice(-3);
  if (reasoningTail.length > 0) {
    lines.push('', 'Recent reasoning (why-trail):');
    for (const step of reasoningTail) lines.push(renderStep(step));
  }

  return redactText(lines.join('\n'));
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
