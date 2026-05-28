import path from 'node:path';
import type { Goal } from '../state/goalStore.js';
import { formatBudget, readGoal } from '../state/goalStore.js';
import { readPlan, type PlanState } from '../state/taskStore.js';
import { getCurrentWorkflow, listWorkflows, type WorkflowMeta } from '../state/workflowArtifacts.js';
import { listSessions, type ChildSessionRecord } from '../orchestration/orchestrator.js';
import type { RecalledRecord } from '../memory/briefing.js';
import { readPreferences, resolveEffort, type EffortLevel, type ExecutionMode, type ReviewPolicy } from '../state/preferencesStore.js';
import { getCliKnobs } from '../config/config.js';
import { BOX, type Theme } from './theme.js';
import { formatContextWindow } from '../runtime/contextWindow.js';

/**
 * `/where` — single-screen "where am I right now" answer.
 *
 * Pre-0.3.6 the user had to chain `/workspace`, `/goal status`, `/plan`,
 * `/workflows`, `/agents`, `/briefing` to reconstruct the same picture. That
 * was four screen-fuls of output, half of which restated info already in
 * the others. The `/where` view collapses it into one block, ordered by
 * "what's most likely to be in your head as a question right now":
 *
 *   1. WORKSPACE  — where am I writing files?
 *   2. WORKFLOW   — which durable folder is bound?
 *   3. GOAL       — what's the agent contractually trying to do?
 *   4. PLAN       — what are the in-flight steps?
 *   5. RECALL     — what memory rows did the briefing surface last turn?
 *   6. AGENTS     — any spawned children still alive?
 *
 * Sections are individually optional — a fresh workspace with no goal, no
 * plan, no children renders only the WORKSPACE block instead of five empty
 * boxes. That keeps the view useful at every stage of a session, not just
 * after you've built up state.
 *
 * Pure renderer: input is a snapshot, output is a string. The wrapper in
 * commands/ui.ts gathers the snapshot at call time. Tests assert against
 * the rendered output directly.
 */

export interface WhereInputs {
  workspaceRoot: string;
  sessionKey: string;
  model: string;
  mcpProfile: string;
  mcpTransport: string;
  mcpOnline: boolean;
  /**
   * 10c: identity of the currently-active MCP. When `'brainrouter'`, /where
   * adds a distinct `brain` line ("brain    🟢 online · cloud") under the
   * mcp row. When `'third-party'` the line is omitted. `'unknown'` (pre-
   * detection) is also omitted so we don't show stale state.
   */
  mcpIdentity?: 'brainrouter' | 'third-party' | 'unknown';
  accessMode: string;
  executionMode: ExecutionMode;
  reviewPolicy: ReviewPolicy;
  effort: EffortLevel;
  effortSource: 'config' | 'preference' | 'default';
  workflowSlug?: string;
  workflowMeta?: WorkflowMeta;
  goal?: Goal;
  plan: PlanState;
  recalledRecords: RecalledRecord[];
  briefingSources: string[];
  childSessions: ChildSessionRecord[];
  /**
   * Persona anchor state for the `/where` panel. Populated by
   * `gatherWhereInputs` from `cli.personaAnchor` (config.json) +
   * `personaAnchorEnabled` (workspace preference) + the last briefing's
   * source stats. `injectedChars > 0` means the most recent turn
   * actually pinned a Core Identity section.
   */
  persona: {
    anchorEnabled: boolean;
    /** True when `cli.personaAnchor` in `config.json` is forcing the anchor off. */
    configOff: boolean;
    injectedChars?: number;
  };
}

const RECALL_LIMIT = 5;
const PLAN_LIMIT = 8;
const CHILDREN_LIMIT = 6;

function indent(line: string, depth = 2): string {
  return ' '.repeat(depth) + line;
}

function renderHeader(title: string, theme: Theme): string {
  return theme.heading(`${BOX.midLeft}${BOX.horizontal} ${title}`);
}

function renderWorkspace(inputs: WhereInputs, theme: Theme): string[] {
  const base = path.basename(inputs.workspaceRoot) || inputs.workspaceRoot;
  const dim = theme.muted;
  // /where is the "tell me everything" surface, so we show the effort level
  // regardless of whether it's at default — unlike the statusline, which
  // hides medium to keep the prompt quiet. Tag the source in parens when
  // `cli.effort` in config.json beat the preference so users can see why
  // the value differs from what they set with /effort.
  const effortLine = inputs.effortSource === 'config'
    ? `effort  ${inputs.effort}  ${dim('(config)')}`
    : `effort  ${inputs.effort}`;
  const lines = [
    renderHeader('Workspace', theme),
    indent(theme.plain(`${base}  ${dim('(' + inputs.workspaceRoot + ')')}`)),
    // Append the model's prompt-context window ("128k ctx", "1M ctx",
    // "?" when unknown) so /where surfaces the same number as the
    // footer at a glance. Lookup is purely client-side and tolerant of
    // unknown model ids — see runtime/contextWindow.ts.
    indent(dim((() => {
      const ctxLabel = formatContextWindow(inputs.model);
      const modelSeg = ctxLabel !== '?' ? `model ${inputs.model} (${ctxLabel} ctx)` : `model ${inputs.model}`;
      return `session ${inputs.sessionKey.slice(0, 8)}  ·  ${modelSeg}  ·  mode ${inputs.accessMode}`;
    })())),
    indent(dim(`exec    ${inputs.executionMode}  ·  review ${inputs.reviewPolicy}  ·  ${effortLine}`)),
    indent(dim(`mcp     ${inputs.mcpProfile}  ·  ${inputs.mcpTransport}  ·  ${inputs.mcpOnline ? 'online' : 'offline'}`)),
  ];
  // 10c: distinct `brain` line for the BrainRouter cloud brain. Shown
  // unconditionally regardless of state when identity is brainrouter (vs.
  // the statusline which hides online to stay quiet). Third-party MCPs
  // skip the line entirely; `unknown` is pre-detection so we wait.
  if (inputs.mcpIdentity === 'brainrouter') {
    const brainState = inputs.mcpOnline ? '🟢 online' : '🔴 offline · cloud unreachable';
    lines.push(indent(dim(`brain   ${brainState}`)));
  }
  // Persona anchor state — shows whether the briefing's cache-stable
  // prefix carries a Core Identity section. Hidden entirely when the user
  // has turned the anchor off (the env override forces off too); still
  // shown as "no body yet" when on but the brain has no persona row.
  if (inputs.persona.anchorEnabled && !inputs.persona.configOff) {
    const injected = inputs.persona.injectedChars ?? 0;
    const state = injected > 0
      ? `pinned · ${injected.toLocaleString()} chars`
      : 'no body yet';
    lines.push(indent(dim(`persona ${state}`)));
  } else if (inputs.persona.configOff) {
    lines.push(indent(dim('persona off · cli.personaAnchor=off')));
  } else {
    lines.push(indent(dim('persona off')));
  }
  return lines;
}

function renderWorkflow(inputs: WhereInputs, theme: Theme): string[] {
  if (!inputs.workflowSlug) return [];
  const meta = inputs.workflowMeta;
  const dim = theme.muted;
  const lines = [renderHeader('Workflow', theme)];
  lines.push(indent(theme.info(inputs.workflowSlug) + (meta ? '  ' + dim(`(${meta.kind} · ${meta.status})`) : '')));
  if (meta) lines.push(indent(dim(`title: ${meta.title}`)));
  return lines;
}

function renderGoal(inputs: WhereInputs, theme: Theme): string[] {
  const goal = inputs.goal;
  if (!goal) return [];
  const dim = theme.muted;
  const cap = formatBudget(goal.budget.maxIterations);
  const used = goal.budget.iterationsUsed;
  const statusColor =
    goal.status === 'complete' ? theme.success :
    goal.status === 'blocked' ? theme.danger :
    goal.status === 'usage_limited' ? theme.warning :
    goal.status === 'paused' ? theme.warning :
    theme.info;
  const lines = [renderHeader('Goal', theme)];
  lines.push(indent(statusColor(goal.status.toUpperCase().replace('_', ' '))));
  // Wrap the goal text at a sensible width so long objectives don't
  // produce one giant unreadable line.
  lines.push(indent(theme.plain(wrapText(goal.text, 76))));
  const tokenLine = goal.budget.maxTokens
    ? `  ·  tokens ${(goal.budget.tokensUsed ?? 0).toLocaleString()}/${goal.budget.maxTokens.toLocaleString()}`
    : '';
  lines.push(indent(dim(`iterations ${used}/${cap}${tokenLine}`)));
  if (goal.blockedReason) lines.push(indent(dim(`reason: ${goal.blockedReason}`)));
  return lines;
}

function renderPlan(inputs: WhereInputs, theme: Theme): string[] {
  if (!inputs.plan.items.length) return [];
  const dim = theme.muted;
  const lines = [renderHeader('Plan', theme)];
  if (inputs.plan.explanation) {
    lines.push(indent(dim(inputs.plan.explanation)));
  }
  for (const item of inputs.plan.items.slice(0, PLAN_LIMIT)) {
    const mark =
      item.status === 'completed' ? theme.success('✓') :
      item.status === 'in_progress' ? theme.warning('⏳') :
      dim('☐');
    const text = item.status === 'completed' ? dim(item.step) : theme.plain(item.step);
    lines.push(indent(`${mark} ${text}`));
  }
  if (inputs.plan.items.length > PLAN_LIMIT) {
    lines.push(indent(dim(`…and ${inputs.plan.items.length - PLAN_LIMIT} more`)));
  }
  return lines;
}

function renderRecall(inputs: WhereInputs, theme: Theme): string[] {
  if (!inputs.recalledRecords.length && !inputs.briefingSources.length) return [];
  const dim = theme.muted;
  const lines = [renderHeader('Recent recall', theme)];
  if (inputs.briefingSources.length) {
    lines.push(indent(dim(`sources: ${inputs.briefingSources.join(', ')}`)));
  }
  for (const rec of inputs.recalledRecords.slice(0, RECALL_LIMIT)) {
    const typeTag = rec.type ? theme.secondary(`[${rec.type}] `) : '';
    const score = typeof rec.priority === 'number' ? dim(` (p=${rec.priority.toFixed(2)})`) : '';
    const snippet = (rec.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    lines.push(indent(`${typeTag}${theme.plain(snippet || rec.recordId)}${score}`));
  }
  if (inputs.recalledRecords.length > RECALL_LIMIT) {
    lines.push(indent(dim(`…and ${inputs.recalledRecords.length - RECALL_LIMIT} more`)));
  }
  return lines;
}

function renderChildren(inputs: WhereInputs, theme: Theme): string[] {
  // Live children = anything currently pending or running. Stale/completed
  // are visible in /agents; /where stays focused on what's blocking attention.
  const live = inputs.childSessions.filter((s) => s.status === 'pending' || s.status === 'running');
  if (!live.length) return [];
  const dim = theme.muted;
  const lines = [renderHeader(`Active children (${live.length})`, theme)];
  for (const s of live.slice(0, CHILDREN_LIMIT)) {
    const statusColor = s.status === 'running' ? theme.success : theme.warning;
    const role = theme.secondary(s.role);
    const id = theme.info(s.id);
    const promptPreview = s.prompt
      ? '  ' + dim(s.prompt.replace(/\s+/g, ' ').slice(0, 80))
      : '';
    lines.push(indent(`${statusColor(s.status)}  ${id}  ${role}${promptPreview}`));
  }
  if (live.length > CHILDREN_LIMIT) {
    lines.push(indent(dim(`…and ${live.length - CHILDREN_LIMIT} more`)));
  }
  return lines;
}

function wrapText(text: string, width: number): string {
  if (text.length <= width) return text;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) { current = word; continue; }
    if (current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current += ' ' + word;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n' + ' '.repeat(2));
}

/**
 * Render the full /where block. Sections are dropped when empty; a fresh
 * workspace with no goal / plan / children renders just WORKSPACE.
 */
export function renderWhere(inputs: WhereInputs, theme: Theme): string {
  const sections: string[][] = [];
  sections.push(renderWorkspace(inputs, theme));
  const workflow = renderWorkflow(inputs, theme);
  if (workflow.length) sections.push(workflow);
  const goal = renderGoal(inputs, theme);
  if (goal.length) sections.push(goal);
  const plan = renderPlan(inputs, theme);
  if (plan.length) sections.push(plan);
  const recall = renderRecall(inputs, theme);
  if (recall.length) sections.push(recall);
  const children = renderChildren(inputs, theme);
  if (children.length) sections.push(children);

  return sections.map((lines) => lines.join('\n')).join('\n\n');
}

/**
 * Gather the snapshot the renderer needs. Single function so the command
 * handler is two lines (gather + render + print).
 */
export function gatherWhereInputs(args: {
  workspaceRoot: string;
  sessionKey: string;
  model: string;
  mcpProfile: string;
  mcpTransport: string;
  mcpOnline: boolean;
  /** 10c: pass through from `mcpClient.getIdentity()` when available. */
  mcpIdentity?: 'brainrouter' | 'third-party' | 'unknown';
  accessMode: string;
  recalledRecords: RecalledRecord[];
  briefingSources: string[];
  /**
   * Per-source stats from the most recent briefing. Used by the persona
   * panel — when `memory_persona` produced any chars, the `/where`
   * persona line renders "pinned · <chars> chars".
   */
  briefingSourceStats?: Array<{ source: string; chars: number; records: number }>;
}): WhereInputs {
  const workflowSlug = (() => {
    // 9d-bugfix: session-scoped binding so a fresh CLI shows no workflow
    // even when an earlier session in the same workspace had one bound.
    try { return getCurrentWorkflow(args.workspaceRoot, args.sessionKey); } catch { return undefined; }
  })();
  const workflowMeta = workflowSlug
    ? listWorkflows(args.workspaceRoot).find((w) => w.slug === workflowSlug)
    : undefined;
  const goal = (() => {
    try { return readGoal(args.workspaceRoot, args.sessionKey) ?? undefined; } catch { return undefined; }
  })();
  const plan = (() => {
    try { return readPlan(args.workspaceRoot, args.sessionKey); } catch { return { items: [], updatedAt: '' }; }
  })();
  const childSessions = (() => {
    try { return listSessions(args.workspaceRoot); } catch { return []; }
  })();
  const prefs = readPreferences(args.workspaceRoot);
  const resolvedEffort = resolveEffort(args.workspaceRoot);
  const configOff = getCliKnobs().personaAnchor === 'off';
  const personaStat = args.briefingSourceStats?.find((s) => s.source === 'memory_persona');
  return {
    ...args,
    executionMode: prefs.executionMode,
    reviewPolicy: prefs.reviewPolicy,
    effort: resolvedEffort.effort,
    effortSource: resolvedEffort.source,
    workflowSlug,
    workflowMeta,
    goal,
    plan,
    childSessions,
    persona: {
      anchorEnabled: prefs.personaAnchorEnabled,
      configOff,
      injectedChars: personaStat?.chars,
    },
  };
}
