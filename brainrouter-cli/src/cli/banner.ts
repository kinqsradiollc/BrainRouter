import crypto from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config/config.js';
import type { Goal } from '../state/goalStore.js';
import { formatBudget } from '../state/goalStore.js';
import { getCurrentWorkflow, getLastUsedWorkflow } from '../state/workflowArtifacts.js';
import { readGoal } from '../state/goalStore.js';
import { BOX, type Theme } from './theme.js';
import { VERSION } from '../version.js';

/**
 * Compose the boxed startup banner. Replaces the prior three-line text dump
 * (chalk title + workspace line + connecting-to line) with a single visually
 * scannable block:
 *
 *   ╭─ 🧠 BrainRouter CLI 0.3.8 ──────────────────────────────╮
 *   │ workspace  BrainRouter  ·  c5b8c12d                     │
 *   │ mcp        local-http  ·  http  ·  online               │
 *   │ workflow   cli-shell-redesign  (in-progress)            │
 *   │ goal       active 3 of unlimited iterations             │
 *   │ session    7f3a1e0c                                     │
 *   │ model      gpt-4o-mini                                  │
 *   ╰─────────────────────────────────────────────────────────╯
 *
 * Designed so a glance tells the user where they are: which repo, which MCP
 * profile, what's the in-flight goal, which model is running. Anything not
 * applicable (e.g. no goal set, no current workflow) is silently omitted —
 * the box shrinks to fit instead of showing "—" placeholders.
 *
 * The function returns a single string with embedded ANSI; the caller prints
 * it once. Pure-function so tests can assert against the rendered output.
 */

// VERSION is read once from package.json in ../version.ts — the single
// source of truth shared with the MCP clientInfo (see runtime/mcpClient.ts).
const TITLE = '🧠 BrainRouter CLI';
// Width floor for the BOXED banner. Below this we fall through to the
// `renderPlainBanner` plaintext format. Was 56 — that caused the box to
// overflow on terminals narrower than 58 cols (each row wrapped to
// multiple terminal rows with broken border alignment). 38 fits a
// 40-col terminal (the smallest realistic phone / split-pane width).
const MIN_BOX_WIDTH = 38;
const MAX_WIDTH = 100;
// Below this width we skip the box entirely and render the rows as
// "label: value" lines. The boxed format with horizontal borders +
// title is meaningless when each border row wraps.
const PLAIN_TEXT_THRESHOLD = 38;

export interface BannerInputs {
  workspaceRoot: string;
  /** "local-http", "stdio", "custom" — config.activeServer. */
  mcpProfile: string;
  /** "stdio" | "http". */
  mcpTransport: string;
  /** True when the MCP handshake succeeded. */
  mcpOnline: boolean;
  /**
   * 10c: which MCP this profile actually IS — drives the distinct "brain"
   * row when the active MCP is BrainRouter (or unknown, which we treat as
   * "likely brain"). When the active MCP is explicitly third-party, the
   * brain row is omitted entirely so the box stays compact.
   */
  mcpIdentity?: 'brainrouter' | 'third-party' | 'unknown';
  /** Resolved sessionKey for this CLI process. */
  sessionKey: string;
  /** Chat-LLM model name (e.g. gpt-4o-mini). */
  model: string;
  /** Slug + status of the currently-bound workflow, if any. */
  workflow?: { slug: string; status: string };
  /**
   * Slug of the last workflow that was active in this workspace, surfaced
   * only when the current session has NO workflow bound. Rendered as a
   * one-line hint so the user can `/workflow switch <slug>` to resume.
   * Doesn't auto-bind anything — workflows are pure storage now (goals
   * are session-scoped runtime state). Empty / matching the active
   * workflow → no hint row.
   */
  lastUsedWorkflow?: string;
  /** Goal-store snapshot, if any. */
  goal?: Goal;
  /** Version override (test fixture). */
  version?: string;
}

interface Row {
  label: string;
  value: string;
}

export interface DisplayedMcpState {
  profile: string;
  transport: string;
  online: boolean;
  identity: 'brainrouter' | 'third-party' | 'unknown';
}

function shortHash(absPath: string): string {
  return crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 8);
}

function formatGoalSummary(goal: Goal): string {
  const cap = formatBudget(goal.budget.maxIterations);
  const used = goal.budget.iterationsUsed;
  // Status verbs read naturally inline. "usage_limited" → "limited".
  const statusWord =
    goal.status === 'usage_limited' ? 'limited' :
    goal.status === 'active' ? 'active' :
    goal.status;
  if (goal.status === 'complete') return 'complete';
  if (goal.status === 'blocked') return `blocked — ${goal.blockedReason?.slice(0, 40) ?? 'see /goal'}`;
  return `${statusWord} ${used} of ${cap} iterations`;
}

/**
 * Workspace label — basename of the workspace root, with a short hash so
 * two repos with the same basename (e.g. two clones of "playground") don't
 * look identical.
 */
function formatWorkspace(workspaceRoot: string): string {
  const base = path.basename(workspaceRoot) || workspaceRoot;
  return `${base}  ·  ${shortHash(workspaceRoot)}`;
}

function formatMcp(profile: string, transport: string, online: boolean): string {
  const dot = online ? 'online' : 'offline';
  return `${profile}  ·  ${transport}  ·  ${dot}`;
}

/**
 * 10c: brain row — distinct from the generic MCP row so the user can tell
 * "the BrainRouter cloud brain is down" from "a third-party MCP is down".
 * Renders only when the active MCP is BrainRouter (or unknown). Returns
 * `undefined` when there's nothing meaningful to say (e.g. user only has a
 * third-party MCP connected).
 */
function formatBrain(identity: 'brainrouter' | 'third-party' | 'unknown' | undefined, online: boolean): string | undefined {
  if (identity === 'third-party') return undefined;
  if (identity === 'unknown') return undefined; // wait for tool-signature detection
  if (online) return '🟢 online';
  return '🔴 offline · cloud unreachable';
}

function formatWorkflow(workflow?: { slug: string; status: string }): string | undefined {
  if (!workflow) return undefined;
  return `${workflow.slug}  (${workflow.status})`;
}

function clipValue(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return value.slice(0, width - 1) + '…';
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Pure renderer — returns the box as a single newline-joined string with
 * ANSI sequences from `theme`. Caller appends the trailing newline.
 */
export function renderBanner(inputs: BannerInputs, theme: Theme): string {
  const rows: Row[] = [];
  rows.push({ label: 'workspace', value: formatWorkspace(inputs.workspaceRoot) });
  rows.push({ label: 'mcp', value: formatMcp(inputs.mcpProfile, inputs.mcpTransport, inputs.mcpOnline) });
  // 10c: brain status sits below the mcp row — same level of visibility,
  // but distinct so multi-MCP setups (Item 11) won't be ambiguous.
  const brain = formatBrain(inputs.mcpIdentity, inputs.mcpOnline);
  if (brain) rows.push({ label: 'brain', value: brain });
  const wf = formatWorkflow(inputs.workflow);
  if (wf) {
    rows.push({ label: 'workflow', value: wf });
  } else if (inputs.lastUsedWorkflow) {
    // Fresh session with no current workflow but a known last-used
    // workflow in this workspace — offer the resume incantation without
    // auto-binding. Quiet so the user notices but isn't pushed into it.
    rows.push({ label: 'last on', value: `${inputs.lastUsedWorkflow}   /workflow switch ${inputs.lastUsedWorkflow}` });
  }
  if (inputs.goal) rows.push({ label: 'goal', value: formatGoalSummary(inputs.goal) });
  rows.push({ label: 'session', value: inputs.sessionKey.slice(0, 8) });
  rows.push({ label: 'model', value: inputs.model });

  const version = inputs.version ?? VERSION;
  const titleText = `${TITLE} ${version}`;
  const labelWidth = rows.reduce((w, r) => Math.max(w, r.label.length), 0);
  // Inner width is the widest "label + 2 spaces + value", clamped.
  const naturalInner = rows.reduce(
    (w, r) => Math.max(w, labelWidth + 2 + r.value.length),
    titleText.length + 4,
  );
  const targetCols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : MAX_WIDTH;

  // Below the plaintext threshold the boxed layout is hostile (each
  // border row wraps and looks chaotic). Fall back to a label:value
  // text dump that the terminal can wrap naturally.
  if (targetCols < PLAIN_TEXT_THRESHOLD) {
    return renderPlainBanner(titleText, rows, theme);
  }

  // Reserve 2 columns for the side borders.
  const innerWidth = Math.max(MIN_BOX_WIDTH, Math.min(MAX_WIDTH, Math.min(naturalInner, targetCols - 2)));

  const top = (() => {
    // ╭─ <title> ──╮  — title sits inline at the top border.
    const titlePiece = ` ${titleText} `;
    const horizontalFill = Math.max(0, innerWidth - 1 - titlePiece.length);
    return theme.primary(BOX.topLeft + BOX.horizontal + titlePiece + BOX.horizontal.repeat(horizontalFill) + BOX.topRight);
  })();

  const bodyLines = rows.map((row) => {
    const valueWidth = innerWidth - labelWidth - 3; // 1 left pad + 2 gap
    const clipped = clipValue(row.value, valueWidth);
    const inside = ' ' + theme.muted(padRight(row.label, labelWidth)) + '  ' + theme.plain(padRight(clipped, valueWidth));
    return theme.primary(BOX.vertical) + inside + theme.primary(BOX.vertical);
  });

  const bottom = theme.primary(BOX.bottomLeft + BOX.horizontal.repeat(innerWidth) + BOX.bottomRight);
  return [top, ...bodyLines, bottom].join('\n');
}

/**
 * Compact label:value text banner — used on terminals narrower than
 * PLAIN_TEXT_THRESHOLD cols where the boxed layout's border rows
 * would wrap and look broken. Same information, no chrome.
 */
function renderPlainBanner(titleText: string, rows: Row[], theme: Theme): string {
  const labelWidth = rows.reduce((w, r) => Math.max(w, r.label.length), 0);
  const headerLine = theme.primary(titleText);
  const bodyLines = rows.map(
    (row) => theme.muted(padRight(row.label, labelWidth) + '  ') + theme.plain(row.value),
  );
  return [headerLine, ...bodyLines].join('\n');
}

/**
 * Convenience: assemble the inputs from live agent + config + workspace
 * state. Pure read; no side effects. Anything that throws while reading the
 * goal or current-workflow files is treated as "not set" so a half-set-up
 * workspace doesn't crash the banner.
 */
export function buildBannerInputs(
  config: Config,
  agent: { sessionKey: string; workspaceRoot: string; getModel: () => string },
  mcpClient: {
    isConnected: () => boolean;
    getIdentity?: () => 'brainrouter' | 'third-party' | 'unknown';
    getStatus?: (serverId: string) => { status: string; identity: 'brainrouter' | 'third-party' | 'unknown' } | undefined;
    getActiveBrainrouterServerId?: () => string | undefined;
  },
): BannerInputs {
  const displayedMcp = resolveDisplayedMcpState(config, mcpClient);
  let workflow: { slug: string; status: string } | undefined;
  let lastUsedWorkflow: string | undefined;
  try {
    // 9d-bugfix: read the session-scoped binding so a fresh CLI session
    // shows no workflow row even when another CLI in the same workspace
    // has one bound.
    const slug = getCurrentWorkflow(agent.workspaceRoot, agent.sessionKey);
    if (slug) {
      // We don't crack open workflowArtifacts.listWorkflows here — just the
      // pointer file. Status would require parsing meta.json, which has its
      // own cost on a slow disk; "bound" is enough to communicate state.
      workflow = { slug, status: 'bound' };
    } else {
      // Fresh session in a workspace where a previous CLI was on
      // workflow X — surface that as a hint so the user can rebind via
      // `/workflow switch X` if they want continuity. Doesn't auto-bind
      // (per the decoupling design — workflows are storage, goals are
      // runtime, the two have orthogonal lifecycles).
      try { lastUsedWorkflow = getLastUsedWorkflow(agent.workspaceRoot); } catch { /* ignore */ }
    }
  } catch { /* ignore — no workflow bound */ }

  let goal: Goal | undefined;
  try {
    goal = readGoal(agent.workspaceRoot, agent.sessionKey) ?? undefined;
  } catch { /* ignore — no goal yet */ }

  return {
    workspaceRoot: agent.workspaceRoot,
    mcpProfile: displayedMcp.profile,
    mcpTransport: displayedMcp.transport,
    mcpOnline: displayedMcp.online,
    mcpIdentity: displayedMcp.identity,
    sessionKey: agent.sessionKey,
    model: agent.getModel(),
    workflow,
    lastUsedWorkflow,
    goal,
  };
}

export function resolveDisplayedMcpState(
  config: Config,
  mcpClient: {
    isConnected: () => boolean;
    getIdentity?: () => 'brainrouter' | 'third-party' | 'unknown';
    getStatus?: (serverId: string) => { status: string; identity: 'brainrouter' | 'third-party' | 'unknown' } | undefined;
    getActiveBrainrouterServerId?: () => string | undefined;
  },
): DisplayedMcpState {
  const liveBrain = mcpClient.getActiveBrainrouterServerId?.();
  const profile = liveBrain || config.activeServer;
  const server = config.servers[profile];
  const status = profile ? mcpClient.getStatus?.(profile) : undefined;
  return {
    profile,
    transport: server?.type ?? 'unknown',
    online: status ? status.status === 'connected' : mcpClient.isConnected(),
    identity: status?.identity ?? server?.identity ?? mcpClient.getIdentity?.() ?? 'unknown',
  };
}
