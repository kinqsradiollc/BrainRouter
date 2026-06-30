import { Agent } from '../agent/agent.js';
import fs from 'node:fs';
import path from 'node:path';
// 0.3.7 — Multi-MCP support. The orchestrator forwards the parent's
// pool to spawned children so a child can call tools across every
// configured MCP server, not just the one the parent happened to be
// connected to. The Pool's facade matches the single-Wrapper API so
// this is a near-no-op type swap.
import type { McpClientPool as McpClientWrapper } from '../mcp/mcpPool.js';
import type { LLMConfig } from '../config/config.js';
import { getCliKnobs, loadOrInitConfig } from '../config/config.js';
import { resolveAgentLlm } from '../provider/agentModels.js';
// MAS-P5-T2: the child-output offload thresholds are now the shared
// result-handoff constants (single source of truth in runtime/resultHandoff).
import { RESULT_HANDOFF_THRESHOLD_CHARS, RESULT_PREVIEW_CHARS } from '../util/resultHandoff.js';
import {
  createSession,
  formatSessionSummary,
  getSession,
  listSessions,
  updateSession,
  type ChildSessionRecord,
} from './orchestrator.js';
import { buildRolePrompt, resolveRole, type AccessMode } from './roles.js';
import { runWorkflow } from '../workflow/workflowTool.js';
import { loadWorkflowGraph } from '../workflow/graphStore.js';
import { runGraph } from '../workflow/graphEngine.js';
import { countRunningChildren, spawnSlotDecision } from './spawnSlots.js';
import { ownershipRequirementError } from './ownership.js';
import { findById, listAll, type Tier } from './agentRegistry.js';
import { buildSystemPrompt, loadWorkspaceInstructionSummary } from '../prompt/systemPrompt.js';
import { appendTranscriptEntry, loadTranscript, readTranscriptEntries } from '../session/sessionStore.js';
import { callMcpTool, childSessionKey } from '../mcp/mcpUtils.js';
import { readPreferences } from '../session/preferencesStore.js';
import { resolveAutoChainMode, autoChainRoles } from './autoChain.js';
import { resolveDelegationPolicy, evaluateDelegationGate } from './delegationPolicy.js';
import { aggregateChildUsage } from './childAccounting.js';
import { buildParentExecutionContextSnapshot } from './parentContext.js';
import { enqueueCompletion, acknowledgeCompletions } from '../session/completionInbox.js';
import { getOutputContract, parseChildOutput } from './outputContracts.js';
import { routeTask } from './router.js';
import { emitAgentRouteFeedback, emitAgentEvent, agentOutputEvent, type RouteOutcome } from '../memory/memoryEvents.js';
import { prepareChildWorkspace, removeChildWorktree, isSharedWorktreeOf, sharedWorktreeLaunchCwd, mergeBackLine, worktreePatchFile, type WorktreeHoldReason, type ChildWorkspaceResolution } from '../worktree/worktreeIsolation.js';
import { getStateDir } from '../storage/store.js';

export interface OrchestrationContext {
  workspaceRoot: string;
  parentSessionKey: string;
  /**
   * Parent agent's access mode. Child agents may not exceed this — a `read`
   * parent cannot spawn a `shell` child, even if the LLM passes `access:'shell'`
   * to spawn_agent. Without this clamp, `spawn_agent` was a privilege-escalation
   * primitive: a read-mode parent could request a shell-mode child and the
   * child would silently run with elevated permissions.
   */
  parentAccessMode?: AccessMode;
  /**
   * HONK-H0 — true when the spawning agent is itself a fleet executor (or has a
   * fleet ancestor). The locked-down sandbox + secret-scoping posture cascades to
   * EVERY descendant, so a fleet child can't escape it by spawning a plain worker.
   */
  ancestorFleet?: boolean;
  /**
   * Parent OTEL trace context. When set, child agents nest their per-turn
   * spans under the dispatching `spawn_agent` tool span instead of starting
   * a fresh trace. Lets observability viewers reconstruct fan-out trees.
   */
  parentTraceId?: string;
  parentSpanId?: string;
  /** Parent agent_id so children can be grouped via attribute even without trace links. */
  parentAgentId?: string;
  /** Parent agent tier — used for hierarchy checks (worker cannot spawn; reasoning can only spawn workers). */
  parentTier?: Tier;
  /** Current spawn-chain depth (0 = direct child of chat root). */
  depth?: number;
  /** DESK-6 — the parent turn's interrupt signal, so a Stop makes wait_agent(s)
   *  return immediately ({status:'interrupted'}) instead of blocking up to the
   *  wait timeout. The children keep running (detached) and auto-drain later. */
  interruptSignal?: AbortSignal;
  mcpClient: McpClientWrapper;
  llmConfig: LLMConfig;
  launchCwd: string;
  /** Called when a child output got offloaded — chars beyond preview that didn't land in parent context. */
  recordOffload?: (charsAvoided: number) => void;
  /** FOOTER-TELEMETRY-2 — called when a child completes, with its total token
   *  spend (prompt + completion), so the parent can surface cumulative child
   *  cost in the footer `offload` segment without a per-render disk scan. */
  recordChildTokens?: (tokens: number) => void;
  /**
   * Paired child tool lifecycle callbacks. Fire from the child agent's
   * onToolStart / onToolEnd so the parent's REPL can render explicit
   * "child began X" / "child finished X" rows in the scrollback — without
   * these, long child runs look like the parent has frozen (roadmap §3).
   */
  onChildToolStart?: (event: { childId: string; role: string; tool: string; args: Record<string, any> }) => void;
  onChildToolEnd?: (event: { childId: string; role: string; tool: string; ok: boolean; summary: string; preview?: string; durationMs: number }) => void;
  /**
   * Called when a child agent's runTurn ends — success, fail, or empty answer.
   * Lets the REPL surface "✓ agent X completed" so the user knows when to act,
   * instead of seeing tool events and then silence.
   */
  onChildComplete?: (event: { childId: string; role: string; status: 'completed' | 'failed'; preview?: string; error?: string; worktree?: { changedFiles?: number; applied?: boolean; patchPath?: string; applyError?: string; heldForReview?: boolean } }) => void;
  /**
   * MAS-P4-T2 supervisor gate. When the delegation policy needs approval,
   * `handleSpawn` calls this to ask the user (returns true to allow).
   * Wired only for an interactive parent; absent in headless runs, where
   * an `ask-*` policy fails closed. May throw a clear error when no
   * terminal is attached.
   */
  confirmDelegation?: (info: { role: string; access: AccessMode; prompt: string }) => Promise<boolean>;
  /**
   * CODEX-PARENT-APPROVAL — child agents run silently, so risky tool prompts
   * are routed back through the parent/UI instead of being denied solely because
   * the child cannot read from the terminal.
   */
  confirmToolApproval?: (info: {
    childId: string;
    role: string;
    tool: string;
    command?: string;
    path?: string;
    summary?: string;
    reason: string;
    dangerous?: boolean;
  }) => Promise<boolean>;
  // MAS-P2-M3 parent-context accessors. Each returns the parent's
  // runtime state at spawn time — all optional so callers can adopt
  // incrementally. When omitted, the snapshot field stays undefined
  // rather than guessing.
  parentBriefingBlock?: () => string | null | undefined;
  parentRecalledRecordIds?: () => string[];
  parentGoal?: () => { text: string; status: string } | null | undefined;
  parentPlanText?: () => string | null | undefined;
  parentVisibleTools?: () => string[];
  parentExecutionMode?: string;
  parentReviewPolicy?: string;
}

// Threshold above which a child agent's final output is offloaded to the
// BrainRouter working-memory canvas rather than embedded directly in the
// parent's context. ~6k chars ≈ 1.5k tokens — enough room for short reports
// in-line, big enough that a 20k-char architecture analysis goes out-of-band.
const OFFLOAD_THRESHOLD_CHARS = RESULT_HANDOFF_THRESHOLD_CHARS;
const OFFLOAD_PREVIEW_CHARS = RESULT_PREVIEW_CHARS;

/**
 * Order the three access modes by power so spawn_agent can refuse to grant
 * a child more than the parent already has.
 */
const ACCESS_RANK: Record<AccessMode, number> = { read: 0, write: 1, shell: 2 };

export function clampAccess(parent: AccessMode, requested: AccessMode): AccessMode {
  return ACCESS_RANK[requested] <= ACCESS_RANK[parent] ? requested : parent;
}

/**
 * Build the parent-visible preview of an offloaded child output. The naive
 * `slice(0, N)` form hid the conclusion when children wrote long reports;
 * here we prefer an explicit summary section (the role overlays nudge each
 * child to start with one) and fall back to head+tail so both the framing
 * and the punchline survive the clamp.
 *
 * Exported for testability.
 */
export function extractChildPreview(output: string, maxChars: number): string {
  // 1. Pick a leading Markdown summary heading if present. The role overlays
  //    encourage children to open with one of these.
  const HEADING_PATTERNS = [
    /^#{1,3}\s+(headline|tl;?dr|summary|key findings?|bottom line|conclusion)[^\n]*/im,
  ];
  for (const heading of HEADING_PATTERNS) {
    const match = heading.exec(output);
    if (match) {
      const start = match.index;
      // Section runs until the next `##` heading or end of doc.
      const next = output.slice(start + match[0].length).search(/\n#{1,3}\s/);
      const end = next < 0 ? output.length : start + match[0].length + next;
      const section = output.slice(start, end).trim();
      if (section.length <= maxChars) return section;
      return section.slice(0, maxChars - 1) + '…';
    }
  }
  // 2. Otherwise show head + tail so the conclusion isn't hidden.
  if (output.length <= maxChars) return output;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 6; // 6 chars for the `\n...\n` divider
  return output.slice(0, head) + '\n…\n' + output.slice(-tail);
}

// Default wait timeout for foreground delegation. 0 = wait until completion.
// Child execution itself is not killed by this value; its inner loops are
// bounded by maxToolLoops plus per-call LLM/MCP/shell timeouts and reconnect.
const DEFAULT_TASK_AGENT_TIMEOUT_MS = 0;
const DEFAULT_CHILD_AGENT_TIMEOUT_MS = 0;

const ORCHESTRATION_TOOL_NAMES = new Set([
  'task_agent',
  'delegate_agent',
  'spawn_agent',
  'spawn_agents',
  'list_agents',
  'wait_agent',
  'wait_agents',
  'read_agent_transcript',
  'close_agent',
  'send_input',
  'resume_agent',
  'route_task',
  'run_workflow',
  'run_workflow_graph',
]);

/**
 * Heuristic auto-router. Maps a free-text task to the best role based on
 * leading verbs and intent keywords. Pure text-classification — used by
 * `route_task` and the batch-spawn role inference, no LLM turn required.
 */
export function inferRoleFromTask(task: string): 'explorer' | 'architect' | 'reviewer' | 'worker' | 'verifier' {
  const t = task.trim().toLowerCase();
  if (/^(investigate|explore|map|survey|find|locate|inspect|audit|scan|read|look at|grep|trace)/.test(t)
    || /\b(where is|where does|how does|what files|which files)\b/.test(t)) {
    return 'explorer';
  }
  if (/^(design|propose|architect|plan|outline|sketch|model|compare)/.test(t)
    || /\b(architecture|design alternatives|tradeoff|spec)\b/.test(t)) {
    return 'architect';
  }
  if (/^(review|critique|evaluate|assess|grade)/.test(t)
    || /\b(code review|nitpick|smell|maintainability)\b/.test(t)) {
    return 'reviewer';
  }
  if (/^(test|verify|run tests|check|validate)/.test(t)
    || /\b(typecheck|lint|build passes?|tests? pass)\b/.test(t)) {
    return 'verifier';
  }
  // Default — implementation work.
  return 'worker';
}

export function isOrchestrationToolName(name: string): boolean {
  // MAS-P2-M1: any `delegate_<...>` (except the legacy generic
  // `delegate_agent` which is already in the set) routes through
  // the orchestration dispatcher as a synthesized delegate tool.
  if (name.startsWith(DELEGATE_TOOL_PREFIX) && name !== 'delegate_agent') {
    return true;
  }
  return ORCHESTRATION_TOOL_NAMES.has(name);
}

const runningPromises = new Map<string, Promise<void>>();

export function trackedPromiseFor(id: string): Promise<void> | undefined {
  return runningPromises.get(id);
}

// DESK-6 — live child Agent handles keyed by child id, so a parent Stop can
// cascade requestInterrupt() into in-flight delegated children. Holds the
// agent (not just the Promise) and the parent session that owns it, so the
// cascade is scoped to one session and never touches a sibling chat's children.
const runningChildAgents = new Map<string, { agent: Agent; parentSessionKey: string }>();

/** DESK-6 — live child agents whose parent is `parentSessionKey` (for interrupt cascade). */
export function childAgentsFor(parentSessionKey: string): Agent[] {
  const out: Agent[] = [];
  for (const { agent, parentSessionKey: p } of runningChildAgents.values()) {
    if (p === parentSessionKey) out.push(agent);
  }
  return out;
}

/** WS6 — register a live agent handle (a child OR a worker) so a parent Stop
 *  cascades into it via childAgentsFor → requestInterrupt. Workers previously
 *  weren't registered, so a Stop left them running. */
export function registerInterruptibleAgent(id: string, agent: Agent, parentSessionKey: string): void {
  runningChildAgents.set(id, { agent, parentSessionKey });
}

/** WS6 — drop a handle once it finishes; it's no longer interruptible. */
export function unregisterInterruptibleAgent(id: string): void {
  runningChildAgents.delete(id);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveChildLaunchCwd(ctx: OrchestrationContext, rawWorkdir: unknown): string {
  const parentCwd = (() => {
    try {
      const root = fs.realpathSync(ctx.workspaceRoot);
      const real = fs.realpathSync(ctx.launchCwd);
      return isInside(root, real) ? real : root;
    } catch {
      return ctx.workspaceRoot;
    }
  })();
  if (typeof rawWorkdir !== 'string' || rawWorkdir.trim() === '') return parentCwd;

  try {
    const root = fs.realpathSync(ctx.workspaceRoot);
    const requested = path.isAbsolute(rawWorkdir)
      ? path.resolve(rawWorkdir)
      : path.resolve(parentCwd, rawWorkdir);
    if (!fs.existsSync(requested)) return parentCwd;
    const realRequested = fs.realpathSync(requested);
    if (!fs.statSync(realRequested).isDirectory()) return parentCwd;
    if (!isInside(root, realRequested)) return parentCwd;
    return realRequested;
  } catch {
    return parentCwd;
  }
}

function parentWaitTimeoutMsFromArgs(args: any): number {
  const knobValue = getCliKnobs().childAgentTimeoutMs;
  const raw = Number(args?.timeoutMs ?? knobValue ?? DEFAULT_CHILD_AGENT_TIMEOUT_MS);
  // 0 / invalid / negative ⇒ no parent wait timeout.
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export { createSpawnAgentTool, createTaskAgentTool, createDelegateAgentTool, createListAgentsTool, createWaitAgentTool, createReadAgentTranscriptTool, createCloseAgentTool, createSendInputTool, createResumeAgentTool, createSpawnAgentsTool, createWaitAgentsTool, createRouteTaskTool, createRunWorkflowTool, createRunWorkflowGraphTool } from './agentTools.js';

/**
 * MAS-P2-M1: per-turn synthesized `delegate_<agentId>` tools.
 *
 * Walks the active agent registry (built-ins + user + workspace) and
 * emits one tool per definition with description = the agent's
 * `whenToUse`. The synthesized tool routes through `handleTaskAgent`
 * (foreground `wait: true` spawn) — that's the high-discoverability
 * pattern the LLM picks naturally vs. choosing role names inside a
 * generic `spawn_agent({ role: '...' })`. The legacy `spawn_agent` /
 * `delegate_agent` stay as escape hatches for prompts the registry
 * doesn't cover.
 *
 * Per-turn (not cached): a workspace pack swap or a `/persona refresh`
 * changes the def set without restart, so the tool list reflects
 * the live registry on every assistant turn.
 *
 * Routes through `task_agent` semantics (foreground wait + structured
 * return), not background `delegate_agent`. The naming is a bit of a
 * lie historically — "delegate_*" in MAS-P2 actually means "send the
 * work over and get the answer back". That matches what the LLM
 * expects when it sees `delegate_reviewer`.
 */
export function synthesizeDelegateTools(
  loadedDefs: Array<{ def: { id: string; delegateName: string; whenToUse: string; defaultAccess?: AccessMode } }>,
): Array<{
  name: string;
  description: string;
  inputSchema: any;
  agentId: string;
}> {
  const tools: Array<{ name: string; description: string; inputSchema: any; agentId: string }> = [];
  const seen = new Set<string>();
  for (const loaded of loadedDefs) {
    const def = loaded.def;
    const name = def.delegateName || `delegate_${def.id}`;
    // Defensive: a workspace override that names two defs with the
    // same delegateName would otherwise stomp the model's tool list.
    // First-write-wins, but log so the operator notices.
    if (seen.has(name)) {
      console.error(`[BrainRouter] duplicate delegate tool name "${name}" — dropping the later definition.`);
      continue;
    }
    seen.add(name);
    tools.push({
      name,
      agentId: def.id,
      description:
        `Delegate this task to the typed \`${def.id}\` agent and wait for its structured output. ` +
        `${def.whenToUse} ` +
        `Use this in preference to spawn_agent({ role: '${def.id}' }) — the typed tool surface is what \`route_task\` recommends.`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The bounded task prompt for the child agent.' },
          label: { type: 'string', description: 'Optional short label for the child run.' },
          ownership: {
            type: 'string',
            description: 'Optional ownership constraint (file glob, module, or responsibility) — recorded on the parent-context snapshot.',
          },
          access: {
            type: 'string',
            enum: ['read', 'write', 'shell'],
            description: `Override the agent's default access mode (${def.defaultAccess ?? 'read'}).`,
          },
          timeoutMs: { type: 'integer', description: 'Optional parent wait timeout in ms. 0 or omitted waits until completion; timeout leaves the child running.' },
          workdir: { type: 'string', description: 'Optional workspace-relative child launch directory.' },
          seedRecordIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional BrainRouter memory record IDs the parent already recalled.',
          },
        },
        required: ['prompt'],
      },
    });
  }
  return tools;
}

const DELEGATE_TOOL_PREFIX = 'delegate_';

/**
 * Match a synthesized delegate tool name to its underlying agent id.
 * Returns `null` for plain `delegate_agent` (the legacy generic tool)
 * so the existing dispatch path keeps working.
 */
function resolveDelegateAgentId(
  name: string,
  loadedDefs: Array<{ def: { id: string; delegateName: string } }>,
): string | null {
  if (name === 'delegate_agent') return null;
  for (const loaded of loadedDefs) {
    if (loaded.def.delegateName === name) return loaded.def.id;
  }
  // Fallback: prefix-strip and check the registry by id directly.
  if (name.startsWith(DELEGATE_TOOL_PREFIX)) {
    const id = name.slice(DELEGATE_TOOL_PREFIX.length);
    if (loadedDefs.some((l) => l.def.id === id)) return id;
  }
  return null;
}

export async function executeOrchestrationTool(
  name: string,
  args: any,
  ctx: OrchestrationContext,
): Promise<string> {
  // MAS-P2-M1: synthesized delegate_<agentId> tools route through
  // task_agent (foreground wait). Resolved against the live registry
  // so an in-session pack swap takes effect on the next call.
  if (name.startsWith(DELEGATE_TOOL_PREFIX) && name !== 'delegate_agent') {
    const loadedDefs = listAll(ctx.workspaceRoot);
    const agentId = resolveDelegateAgentId(name, loadedDefs);
    if (agentId) {
      return await handleTaskAgent({ ...args, agentId }, ctx);
    }
    // Fall through to the unknown-tool error so the loop surfaces it.
  }

  switch (name) {
    case 'task_agent':
      return await handleTaskAgent(args, ctx);
    case 'delegate_agent':
      return await handleDelegateAgent(args, ctx);
    case 'spawn_agent':
      return await handleSpawn(args, ctx);
    case 'spawn_agents':
      return await handleSpawnBatch(args, ctx);
    case 'list_agents':
      return handleList(ctx);
    case 'wait_agent':
      return await handleWait(args, ctx);
    case 'wait_agents':
      return await handleWaitBatch(args, ctx);
    case 'read_agent_transcript':
      return handleReadTranscript(args, ctx);
    case 'close_agent':
      return handleClose(args, ctx);
    case 'send_input':
      return await handleSendInput(args, ctx);
    case 'resume_agent':
      return await handleResumeAgent(args, ctx);
    case 'route_task':
      return await handleRouteTask(args, ctx);
    case 'run_workflow':
      // WF-TOOL — execute a declarative PhasePlan deterministically. Inject this
      // very dispatcher as the spawn backend (run_workflow's children go through
      // the same spawn_agents/wait_agents path everything else does).
      return await runWorkflow(args, ctx, { dispatch: executeOrchestrationTool });
    case 'run_workflow_graph':
      // §7 L4 — run a saved visual-workflow GRAPH. Agent nodes delegate to the
      // same task_agent spawn path; sub-workflow nodes load from the same store.
      return await handleRunWorkflowGraph(args, ctx);
    default:
      throw new Error(`Unknown orchestration tool: ${name}`);
  }
}

/**
 * MAS-P2-M6 — best-effort route-feedback emit on child completion.
 * Computes durationMs from the persisted record's startedAt timestamp
 * so the brain can join on real wall-clock spans.
 */
async function emitRouteFeedback(
  ctx: OrchestrationContext,
  args: {
    task: string;
    chosenAgentId: string;
    parentAgentId?: string;
    ownership: string | null;
    outcome: RouteOutcome;
    record: ChildSessionRecord;
    completedAt: string;
    tokenCost?: number;
  },
): Promise<void> {
  const startedMs = Date.parse(args.record.startedAt);
  const completedMs = Date.parse(args.completedAt);
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(completedMs)
      ? Math.max(0, completedMs - startedMs)
      : undefined;
  const emitCtx = { mcpClient: ctx.mcpClient, sessionKey: ctx.parentSessionKey };
  await emitAgentRouteFeedback(emitCtx, {
    task: args.task,
    chosenAgentId: args.chosenAgentId,
    parentAgentId: args.parentAgentId,
    ownership: args.ownership,
    outcome: args.outcome,
    durationMs,
    tokenCost: args.tokenCost,
  });
  // MAS-P6-T1: also capture the delegation-aware `agent_output` event
  // (best-effort; piggybacks the same MCP capture path).
  await emitAgentEvent(
    emitCtx,
    agentOutputEvent({
      agentId: args.chosenAgentId,
      task: args.task,
      outcome: args.outcome,
      durationMs,
      tokenCost: args.tokenCost,
      preview: typeof args.record.finalOutput === 'string' ? args.record.finalOutput : undefined,
    }),
  );
}

async function handleRouteTask(args: any, ctx: OrchestrationContext): Promise<string> {
  const task = String(args?.task ?? '');
  if (!task.trim()) throw new Error('route_task requires `task`.');
  // Snapshot the connected MCP tool set so the router knows whether
  // it can attempt the memory_recall hop.
  let toolNames: Set<string> | undefined;
  try {
    const res = await ctx.mcpClient.listTools();
    toolNames = new Set(((res as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name));
  } catch {
    toolNames = undefined;
  }
  const result = await routeTask({
    task,
    mcpClient: ctx.mcpClient,
    mcpToolNames: toolNames,
    sessionKey: ctx.parentSessionKey,
  });
  return JSON.stringify(result, null, 2);
}

async function handleTaskAgent(args: any, ctx: OrchestrationContext): Promise<string> {
  return await handleSpawn({ ...args, wait: true, timeoutMs: args?.timeoutMs ?? DEFAULT_TASK_AGENT_TIMEOUT_MS }, ctx);
}

/**
 * §7 L4 — run a saved visual-workflow graph by id. Each `agent` node delegates to
 * the same `task_agent` foreground-spawn path (so the graph's AI work is real
 * child agents, clamped to the parent's access mode), and `subworkflow` nodes load
 * from the same store (the engine's own depth + recursion guard prevents runaway
 * nesting). Returns the graph's final output plus a one-line run summary.
 */
async function handleRunWorkflowGraph(args: any, ctx: OrchestrationContext): Promise<string> {
  const id = String(args?.id ?? args?.workflowId ?? '').trim();
  if (!id) throw new Error('run_workflow_graph requires an `id` — the saved workflow-graph id/name (see the Workflows canvas).');
  const graph = loadWorkflowGraph(ctx.workspaceRoot, id);
  if (!graph) throw new Error(`No saved workflow graph "${id}". Build and save one in the Workflows canvas, or check the id with the desktop's workflow list.`);

  // Seed run vars from the caller's `vars` object over the graph's own defaults.
  const callerVars = args?.vars && typeof args.vars === 'object' && !Array.isArray(args.vars)
    ? (args.vars as Record<string, unknown>)
    : {};
  const seeded = { ...graph, vars: { ...(graph.vars ?? {}), ...callerVars } };

  const result = await runGraph(seeded, {
    runAgent: async (prompt) => {
      const out = await handleTaskAgent({ prompt }, ctx);
      // handleTaskAgent may return raw text or a JSON envelope — surface the text.
      try {
        const j = JSON.parse(out) as Record<string, unknown>;
        if (j && typeof j === 'object') return String(j.output ?? j.raw ?? j.text ?? out);
      } catch { /* raw text */ }
      return out;
    },
    loadSubWorkflow: async (ref) => loadWorkflowGraph(ctx.workspaceRoot, ref),
  });

  if (!result.ok) return `Workflow "${id}" failed: ${result.error ?? 'unknown error'}`;
  const ran = result.order.filter((n) => result.nodes[n]?.status === 'ok').length;
  return `Workflow "${id}" completed (${ran} node${ran === 1 ? '' : 's'} ran).\n\n${result.finalOutput ?? '(no output node produced text)'}`;
}

async function handleDelegateAgent(args: any, ctx: OrchestrationContext): Promise<string> {
  const spawned = await handleSpawn({ ...args, wait: false }, ctx);
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(spawned);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value;
  } catch {
    // not JSON; fall through to verbatim propagation
  }
  // If handleSpawn returned an error string or a non-object payload (no id to
  // attach next-step semantics to), propagate it verbatim — wrapping it in
  // { raw, nextAction } would hide the failure from the model and prevent the
  // child-drain guardrail from finding a child id to wait on.
  if (!parsed || typeof parsed.id !== 'string') return spawned;
  return JSON.stringify({
    ...parsed,
    nextAction: 'continue working in the parent turn; call wait_agent when this child output is needed',
  }, null, 2);
}

async function handleSpawnBatch(args: any, ctx: OrchestrationContext): Promise<string> {
  const list = Array.isArray(args?.agents) ? args.agents : [];
  if (list.length === 0) throw new Error('spawn_agents requires at least one entry in `agents`.');

  // MAS-P3 — ownership gate. Resolve each entry's effective access and
  // refuse write/shell fan-out that declared no ownership glob (parallel
  // writers would otherwise be free to clobber each other's files). This
  // runs BEFORE any child is spawned, so a bad batch fails atomically
  // rather than half-spawning. Read-only fan-out is allowed but noted.
  const roleNames = list.map((entry: any) => entry.role ?? inferRoleFromTask(String(entry.prompt ?? '')));
  const warnings: string[] = [];
  list.forEach((entry: any, i: number) => {
    let effectiveAccess: AccessMode;
    if (entry.access === 'read' || entry.access === 'write' || entry.access === 'shell') {
      effectiveAccess = entry.access;
    } else {
      try {
        effectiveAccess = resolveRole(roleNames[i]).defaultAccess;
      } catch {
        effectiveAccess = 'read';
      }
    }
    const err = ownershipRequirementError(effectiveAccess, entry.ownership, entry.allowOverlap);
    if (err) {
      const who = entry.label ? `"${entry.label}"` : `agents[${i}] (${roleNames[i]})`;
      throw new Error(`spawn_agents: ${who} — ${err}`);
    }
    if (effectiveAccess === 'read' && !entry.ownership) {
      warnings.push(`agents[${i}] (${roleNames[i]}) is read-only with no ownership — fine for reads, but it cannot write.`);
    }
  });

  const results: Array<Record<string, unknown>> = [];
  // Spawn sequentially so each gets a unique session id and createSession's
  // write isn't racy. The CHILDREN themselves still run in parallel — handleSpawn
  // kicks off the runTurn detached via runningPromises.set, then returns.
  for (let i = 0; i < list.length; i++) {
    const out = await handleSpawn({ ...list[i], role: roleNames[i] }, ctx);
    try {
      results.push(JSON.parse(out));
    } catch {
      results.push({ raw: out });
    }
  }
  const payload: Record<string, unknown> = { spawned: results.length, agents: results };
  if (warnings.length > 0) payload.warnings = warnings;
  return JSON.stringify(payload, null, 2);
}

async function handleWaitBatch(args: any, ctx: OrchestrationContext): Promise<string> {
  const ids = Array.isArray(args?.ids) ? args.ids.map(String) : [];
  if (ids.length === 0) throw new Error('wait_agents requires a non-empty `ids` array.');
  const rawTimeoutMs = args?.timeoutMs === undefined ? 240_000 : Number(args.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeoutMs) ? rawTimeoutMs : 240_000;
  // ORCH-FIX — allSettled, not all: one child's wait rejecting must NOT reject
  // the whole batch (which would surface as a tool failure and lose the other
  // children's results). A rejected wait becomes a per-child error result.
  const results = await Promise.allSettled(
    ids.map(async (id: string) => {
      const single = await handleWait({ id, timeoutMs }, ctx);
      try {
        return JSON.parse(single);
      } catch {
        return { id, raw: single };
      }
    }),
  );
  const settled = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { id: ids[i], status: 'error', error: r.reason?.message ?? String(r.reason) },
  );
  // MAS-P4-T3: roll the children's usage into one total so the parent sees
  // the cost split (and offload savings) of the whole batch at a glance.
  const childTotals = aggregateChildUsage(settled);
  return JSON.stringify({ waited: settled.length, agents: settled, childTotals }, null, 2);
}

async function handleSpawn(args: any, ctx: OrchestrationContext): Promise<string> {
  // Resolve agent definition via agentId (registry) or role (legacy).
  let role: ReturnType<typeof resolveRole>;
  let childTier: Tier | undefined;
  // MAS-P4-T1: an agent def may scope which MCP tools its children see.
  let childToolScope: { local: string[]; mcp: string[] } | undefined;
  let childDisallowedTools: string[] | undefined;
  // AGENTS-WIZARD: a def may carry a default ownership glob, used when the
  // spawner doesn't pass an explicit one.
  let childDefOwnership: string | null | undefined;

  if (typeof args.agentId === 'string' && args.agentId.trim()) {
    const loaded = findById(args.agentId.trim(), ctx.workspaceRoot);
    if (!loaded) {
      const known = listAll(ctx.workspaceRoot).map((l) => l.def.id).join(', ');
      throw new Error(`Unknown agentId "${args.agentId}". Known agents: ${known}.`);
    }
    role = {
      name: loaded.def.id,
      description: loaded.def.whenToUse,
      defaultAccess: loaded.def.defaultAccess,
      promptOverlay: loaded.def.prompt,
    };
    childTier = loaded.def.tier;
    childToolScope = loaded.def.toolScope;
    childDisallowedTools = loaded.def.disallowedTools;
    childDefOwnership = loaded.def.ownership ?? undefined;
  } else {
    const roleName = String(args.role ?? '');
    if (!roleName.trim()) throw new Error('spawn_agent requires either "agentId" or "role".');
    role = resolveRole(roleName);
    childTier = findById(role.name, ctx.workspaceRoot)?.def.tier;
  }

  const prompt = String(args.prompt ?? '');
  if (!prompt.trim()) throw new Error('spawn_agent requires a non-empty prompt.');

  // P1.2 — spawn hierarchy checks.
  const rawMaxDepth = getCliKnobs().maxSpawnDepth;
  const maxDepth = Number.isFinite(rawMaxDepth) && rawMaxDepth > 0 ? rawMaxDepth : 3;
  const currentDepth = ctx.depth ?? 0;
  const parentTier = ctx.parentTier;

  if (parentTier === 'worker') {
    throw new Error('Tier "worker" cannot delegate — ask the parent agent to spawn instead.');
  }
  if (parentTier === 'reasoning' && childTier && (childTier === 'chat' || childTier === 'reasoning')) {
    throw new Error(`Tier "reasoning" cannot spawn a "${childTier}" agent — only "worker" children are allowed.`);
  }
  if (currentDepth >= maxDepth) {
    throw new Error(`Spawn depth cap reached (${currentDepth}/${maxDepth}). Reduce agent nesting or raise cli.maxSpawnDepth in ~/.config/brainrouter/config.json.`);
  }
  // CODEX-AGENT-LIFECYCLE — spawn slots: cap the number of children THIS parent
  // has running concurrently (breadth) so it can't fan out unbounded agents that
  // exhaust the LLM semaphore and leave orphans drifting. Scoped to the parent's
  // session key (Codex's per-controller slots) and counts `running` only, so an
  // orphan `pending` from a crashed spawn never wedges the cap.
  {
    const mine = listSessions(ctx.workspaceRoot).filter((s) => s.parentSessionKey === ctx.parentSessionKey);
    const running = countRunningChildren(mine);
    const slot = spawnSlotDecision(running, getCliKnobs().maxConcurrentChildren);
    if (!slot.allow) throw new Error(slot.reason);
  }

  const requested = (args.access as AccessMode | undefined) ?? role.defaultAccess;
  const access = clampAccess(ctx.parentAccessMode ?? 'shell', requested);

  // PARITY-Q — soft delegation-prompt nudge. A terse child prompt with no
  // return-format cue tends to come back vague; rather than reject it (the
  // parent already committed to spawning), append ONE role-appropriate line
  // steering the child to a self-contained, evidence-quoting answer. Read-only
  // children are told to report findings only; write/shell children to report
  // what they changed and how they verified. Untouched when the parent already
  // briefed well (long prompt) or stated a return/format cue.
  const hasReturnCue = /\b(return|report back|format|output|provide|summar|list|table|pseudocode|cite|quote|file:line)\b/i.test(prompt);
  const effectivePrompt = (prompt.length < 220 && !hasReturnCue)
    ? `${prompt}\n\n${access === 'read'
        ? 'Return a self-contained answer: lead with the conclusion, then the evidence — quote key `file:line` references. Report findings only; do not modify files.'
        : 'Return a self-contained answer: lead with what you changed and why, then quote the key `file:line` edits and how you verified them (tests/output).'}`
    : prompt;

  // MAS-P4-T2 — supervisor gate. Consult the delegation policy before
  // creating the session. `no-children` denies outright; `ask-*` policies
  // prompt the interactive parent (and fail closed in headless runs).
  const delegationPolicy = resolveDelegationPolicy(readPreferences(ctx.workspaceRoot));
  const rawGate = evaluateDelegationGate({ policy: delegationPolicy, childAccess: access, depth: ctx.depth ?? 0 });
  // Auto-chain follow-ups (the reviewer/verifier the user opted into via
  // `/auto-chain review|verify|both`) are PRE-AUTHORIZED — they must not re-prompt
  // "approve this delegation?" on every worker completion. A hard `deny` policy
  // ("no-children") still blocks them.
  const gate = args.autoChainFollowup === true && rawGate === 'ask' ? 'auto' : rawGate;
  if (gate === 'deny') {
    throw new Error(
      `Delegation is disabled (policy "no-children"). The agent may not spawn child agents. ` +
        `Change it with /delegation-policy auto.`,
    );
  }
  if (gate === 'ask') {
    if (!ctx.confirmDelegation) {
      throw new Error(
        `Delegation policy "${delegationPolicy}" requires approval, but no interactive terminal is attached. ` +
          `Run interactively, or set /delegation-policy auto to spawn non-interactively.`,
      );
    }
    const approved = await ctx.confirmDelegation({ role: role.name, access, prompt: String(args.prompt ?? '') });
    if (!approved) {
      throw new Error(`Spawn of "${role.name}" (${access}) declined under delegation policy "${delegationPolicy}".`);
    }
  }

  const requestedChildLaunchCwd = resolveChildLaunchCwd(ctx, args.workdir);
  const parentWaitTimeoutMs = parentWaitTimeoutMsFromArgs(args);
  const record = createSession(ctx.workspaceRoot, {
    role: role.name,
    prompt,
    parentSessionKey: ctx.parentSessionKey,
    access,
    label: typeof args.label === 'string' ? args.label : undefined,
    tier: childTier,
    depth: currentDepth + 1,
  });
  // BUILD-LOOP P2 (0.4.12) — when the build orchestrator passes an explicit
  // `workspaceRootOverride` (the ONE worktree shared by a build run's
  // implement/verify/review children), the child runs IN that worktree with NO
  // per-child isolation handle — so it never merges back on its own; the build
  // loop owns the shared worktree's lifecycle + the gated merge at the end.
  // The override is honored ONLY when it's a git worktree of the SAME repo as the
  // parent workspace — never an arbitrary path — so a child's writes can't be
  // redirected outside the workspace (ownership + write-validation key off
  // `workspaceRoot`). Anything else falls through to normal per-child isolation.
  const sharedRootOverride = typeof args.workspaceRootOverride === 'string' && args.workspaceRootOverride.trim()
    ? args.workspaceRootOverride.trim()
    : undefined;
  const sharedRootValid = sharedRootOverride ? isSharedWorktreeOf(ctx.workspaceRoot, sharedRootOverride) : false;
  const childWorkspace: ChildWorkspaceResolution = (sharedRootOverride && sharedRootValid)
    ? (() => {
        const root = fs.realpathSync(sharedRootOverride);
        // Map the requested cwd into the shared worktree (fall back to its root).
        return { workspaceRoot: root, launchCwd: sharedWorktreeLaunchCwd(ctx.workspaceRoot, requestedChildLaunchCwd, root), isolated: true };
      })()
    : prepareChildWorkspace({
        parentWorkspaceRoot: ctx.workspaceRoot,
        parentLaunchCwd: requestedChildLaunchCwd,
        childId: record.id,
        access,
        mode: getCliKnobs().childWorkspaceIsolation,
      });
  const childWorkspaceRoot = childWorkspace.workspaceRoot;
  const childLaunchCwd = childWorkspace.launchCwd;
  if (childWorkspace.isolated || childWorkspace.notice) {
    updateSession(ctx.workspaceRoot, record.id, {
      childWorkspaceRoot: childWorkspace.isolated ? childWorkspaceRoot : undefined,
      childLaunchCwd,
      childWorkspaceIsolation: childWorkspace.isolation,
      childWorkspaceNotice: childWorkspace.notice,
    });
  }

  const childKey = childSessionKey(ctx.parentSessionKey, record.id);
  const seededIds: string[] = Array.isArray(args.seedRecordIds)
    ? args.seedRecordIds.filter((id: unknown): id is string => typeof id === 'string').slice(0, 20)
    : [];

  // MAS-P2-M3: build the typed parent-context snapshot from the
  // accessor methods the agent exposes. Skip silently when a piece
  // of state isn't available — partial snapshots are explicitly OK.
  const parentBriefing = ctx.parentBriefingBlock?.();
  const parentRecalledIds = ctx.parentRecalledRecordIds?.() ?? seededIds;
  const parentGoal = ctx.parentGoal?.();
  const parentPlan = ctx.parentPlanText?.();
  const parentExecutionMode = ctx.parentExecutionMode;
  const parentReviewPolicy = ctx.parentReviewPolicy;
  // AGENTS-WIZARD: explicit spawn arg wins; else fall back to the def's
  // declared ownership glob (so a custom write/shell agent stays bounded
  // without the spawner repeating its ownership each time).
  const ownership = typeof args.ownership === 'string' ? args.ownership
    : (typeof childDefOwnership === 'string' && childDefOwnership.trim() !== '' ? childDefOwnership : null);
  const snapshot = buildParentExecutionContextSnapshot({
    parentSessionKey: ctx.parentSessionKey,
    childSessionKey: childKey,
    parentAgentId: role.name,
    accessMode: access,
    trace: ctx.parentTraceId && ctx.parentSpanId
      ? { traceId: ctx.parentTraceId, spanId: ctx.parentSpanId }
      : undefined,
    goal: parentGoal ?? undefined,
    planText: parentPlan ?? undefined,
    recalledRecordIds: parentRecalledIds,
    briefingBlock: parentBriefing ?? undefined,
    visibleTools: ctx.parentVisibleTools?.(),
    reviewPolicy: parentReviewPolicy,
    executionMode: parentExecutionMode,
    workspaceInstructions: loadWorkspaceInstructionSummary(ctx.workspaceRoot),
    ownership,
    outputContract: getOutputContract(role.name)?.id ?? null,
  });
  updateSession(ctx.workspaceRoot, record.id, { parentContext: snapshot });
  appendTranscriptEntry(childWorkspaceRoot, childKey, {
    role: 'system',
    name: 'parent_context',
    content: JSON.stringify(snapshot),
  });

  const basePrompt = buildSystemPrompt({
    workspaceRoot: childWorkspaceRoot,
    launchCwd: childLaunchCwd,
    sessionKey: childKey,
    instructionSummary: loadWorkspaceInstructionSummary(childWorkspaceRoot),
  });
  let systemPromptOverride = buildRolePrompt(role, basePrompt, '');
  if (seededIds.length > 0) {
    systemPromptOverride +=
      `\n\n## Parent-recalled BrainRouter records\n` +
      `The parent agent already recalled these memory record IDs: ${seededIds.join(', ')}. ` +
      `Call memory_recall (or memory_search) with the same intent before doing duplicate exploration, and prefer building on these records over re-deriving them.`;
  }
  // 0.4.x-1: operator overlay — a one-off instruction block (≤4000 chars,
  // same cap as /goal) appended to the role prompt. The escape hatch for a
  // bespoke contractor the five preset roles don't cover. A child with an
  // overlay is marked `synthetic` so /agents and recall can tell it apart
  // from a vanilla role spawn.
  const overlay = typeof args.overlay === 'string' ? args.overlay.trim().slice(0, 4000) : '';
  if (overlay) {
    systemPromptOverride += `\n\n## Operator overlay (one-off instructions for this run)\n${overlay}`;
    updateSession(ctx.workspaceRoot, record.id, { synthetic: true });
  }
  // 0.4.x-5: per-child reasoning-effort override (otherwise inherits /effort).
  const effortOverride =
    args.effort === 'low' || args.effort === 'medium' || args.effort === 'high' ? args.effort : undefined;

  // 0.4.15 — route this child to its ROLE's configured provider/model
  // (config.providers + config.agentModels). Falls back to the parent's LLM
  // (ctx.llmConfig — which already honors any per-session override) when the
  // role has no assignment, so default behavior is unchanged.
  const childLlm = resolveAgentLlm(loadOrInitConfig(), ctx.llmConfig, role.name);
  const childAgent = new Agent(ctx.mcpClient, childLlm, {
    workspaceRoot: childWorkspaceRoot,
    launchCwd: childLaunchCwd,
    sessionKey: childKey,
    // The role overlay is already embedded inside `systemPromptOverride` via
    // buildRolePrompt() above — passing it again as a separate field would
    // append a second copy and waste 1.5–3k tokens per child turn.
    roleOverlay: undefined,
    accessMode: access,
    silent: true,
    forceFleetSandbox: role.forceSandbox || ctx.ancestorFleet, // HONK-H0 — fleet role OR fleet ancestor → locked-down posture

    // Children NEED memory: skipping the briefing makes them amnesiac and the
    // parent LLM eventually learns inline work outperforms fan-out. With recall
    // enabled, children join the same cognitive context as the parent.
    enableRecall: true,
    systemPromptOverride,
    // Inherit the parent's OTEL trace context so spans nest under the
    // dispatching spawn_agent tool span instead of starting a fresh tree.
    parentTraceId: ctx.parentTraceId,
    parentSpanId: ctx.parentSpanId,
    // Propagate tier and depth so grandchildren can enforce hierarchy caps.
    tier: childTier,
    agentDepth: currentDepth + 1,
    // MAS-P3: the ownership glob gates this child's file writes.
    ownership,
    // MAS-P4-T1: the agent def's tool scope limits the child's MCP surface.
    toolScope: childToolScope,
    disallowedTools: childDisallowedTools,
    // 0.4.x-5: per-child reasoning-effort override.
    effortOverride,
    confirmToolApproval: ctx.confirmToolApproval
      ? (info) => ctx.confirmToolApproval!({ childId: record.id, role: role.name, ...info })
      : undefined,
    // DESK-5n — thread the parent's review stance so the child's write/edit/
    // patch gate can honor the user's "Auto mode" (proceed) without asking.
    // ctx types these as plain string; the Agent narrows them.
    parentReviewPolicy: ctx.parentReviewPolicy as 'request' | 'proceed' | undefined,
    parentExecutionMode: ctx.parentExecutionMode as 'planning' | 'fast' | undefined,
  });
  if (ctx.parentAgentId) childAgent.setParentAgentId(ctx.parentAgentId);
  // DESK-6 — register the live handle so a parent Stop can cascade into it.
  runningChildAgents.set(record.id, { agent: childAgent, parentSessionKey: ctx.parentSessionKey });

  updateSession(ctx.workspaceRoot, record.id, { status: 'running' });

  // COMPLETION-FEEDBACK — a DETACHED child (delegate_agent / spawn_agent with
  // wait:false) returns only its id now; its result is reported back to the
  // parent's next turn via the completion inbox. A waited child (task_agent)
  // returns in-turn, so it's acknowledged at wait time instead (no duplicate).
  const reportCompletionToParent = !args.wait;

  const promise = (async () => {
    // CODEX-WORKTREE-MERGEBACK — guards against double cleanup: the success path
    // merges the worktree back BEFORE the completion notice + auto-chain; the
    // `finally` then only runs for the failure/throw path (capture + preserve).
    let worktreeSettled = false;
    try {
      // Track per-tool start times so the paired onChildToolEnd carries a
      // real duration — the REPL renders this on the child's end row.
      const childToolStarts = new Map<string, number>();
      // Synthetic dangling-tool-call recovery: every child must resolve to
      // an explicit result instead of leaving
      // the session running forever when an LLM/MCP call hangs.
      const output = await childAgent.runTurn(effectivePrompt, {
        onStatusUpdate: () => {},
        onToolStart: (tool, args) => {
          childToolStarts.set(tool, Date.now());
          ctx.onChildToolStart?.({
            childId: record.id,
            role: role.name,
            tool,
            args: args ?? {},
          });
        },
        onToolEnd: (tool, result) => {
          const startedAt = childToolStarts.get(tool);
          childToolStarts.delete(tool);
          const durationMs = startedAt ? Date.now() - startedAt : 0;
          ctx.onChildToolEnd?.({
            childId: record.id,
            role: role.name,
            tool,
            ok: result.success,
            summary: result.summary,
            preview: result.preview,
            durationMs,
          });
        },
      });

      // Working-memory offload: when a child returns a sizeable payload, push
      // the full body into the BrainRouter working canvas and keep only a
      // pointer in the session record. This is the main context-saving win
      // for parents synthesizing multiple child outputs.
      //
      // The preview the parent sees was previously `output.slice(0, 800)`,
      // which often hid the actual conclusion — e.g. a 15k-char review
      // report with the headline finding at the BOTTOM. Now we prefer an
      // explicit `## Headline` / `## Summary` / `## TL;DR` section when
      // the child wrote one (the role overlays nudge for this), and fall
      // back to the head-and-tail slice so we capture both the framing
      // and the conclusion.
      let storedOutput = output;
      let workingRef: string | undefined;
      if (output && output.length >= OFFLOAD_THRESHOLD_CHARS) {
        workingRef = await offloadChildOutput(ctx, record.id, role.name, prompt, output);
        if (workingRef) {
          const preview = extractChildPreview(output, OFFLOAD_PREVIEW_CHARS);
          storedOutput =
            `[offloaded to working memory ref=${workingRef}]\n` +
            `Preview (${preview.length} chars of ${output.length}):\n` +
            preview;
        }
      }

      const completedAt = new Date().toISOString();
      // MAS-P4-T3: per-child accounting — chars kept out of the parent's
      // context via offload, and wall-clock spawn→complete.
      const offloadedChars = workingRef ? Math.max(0, output.length - storedOutput.length) : 0;
      const startedMs = record.startedAt ? Date.parse(record.startedAt) : NaN;
      const wallClockMs = Number.isFinite(startedMs) ? Math.max(0, Date.parse(completedAt) - startedMs) : undefined;
      updateSession(ctx.workspaceRoot, record.id, {
        status: 'completed',
        completedAt,
        finalOutput: storedOutput,
        // MAS-READMANIFEST — capture the files this child read so the phase
        // engine can forward an "already mapped" manifest to later phases.
        filesRead: childAgent.filesRead,
        usage: { ...childAgent.sessionUsage, offloadedChars, wallClockMs },
      });
      // MAS-P2-M6: fire-and-forget feedback record. Skipped silently
      // when MCP is offline or memory_capture_turn isn't exposed.
      void emitRouteFeedback(ctx, {
        task: prompt,
        chosenAgentId: role.name,
        parentAgentId: ctx.parentAgentId,
        ownership,
        outcome: 'success',
        record,
        completedAt,
        tokenCost:
          (childAgent.sessionUsage?.promptTokens ?? 0) +
          (childAgent.sessionUsage?.completionTokens ?? 0),
      });
      // Roll the offload savings into the parent's metrics so /tokens can
      // report what didn't have to land back in the parent's context window.
      if (workingRef && output.length > OFFLOAD_PREVIEW_CHARS) {
        ctx.recordOffload?.(output.length - OFFLOAD_PREVIEW_CHARS);
      }
      // FOOTER-TELEMETRY-2 — roll this child's token spend into the parent's
      // in-memory counter so the footer `offload` segment can show it live.
      ctx.recordChildTokens?.(
        (childAgent.sessionUsage?.promptTokens ?? 0) +
        (childAgent.sessionUsage?.completionTokens ?? 0),
      );
      // Tell the REPL the child finished — otherwise the user sees the child's
      // tool calls scroll by and then silence, with no signal that it's safe
      // to ask the parent agent to continue.
      //
      // Surface a SUBSTANTIAL preview instead of the previous 160-char
      // slice that the user couldn't even read because the notice render
      // truncated it to terminal width. Now:
      //   - Short outputs (≤ AGENT_PREVIEW_MAX): show the FULL body so the
      //     user sees findings + recommendations, not just the headline.
      //   - Long outputs (> AGENT_PREVIEW_MAX): use the heading-aware
      //     `extractChildPreview` to grab the Headline / TL;DR / Summary
      //     section (role overlays nudge children to open with one).
      // The REPL renders this in a multi-line `agent-result` scrollback
      // block so the body wraps freely. Configurable via env var for power
      // users who want to cap it tighter on small terminals.
      // CODEX-WORKTREE-MERGEBACK — merge the child's isolated work back onto the
      // parent tree HERE (clean completion), before the completion notice and any
      // auto-chain review/verify. Doing it in `finally` instead would merge AFTER
      // an auto-chained reviewer already read a stale (un-merged) parent tree.
      // Best-effort: a throw must not turn a succeeded child into a failure.
      let worktreeSummary: { changedFiles?: number; applied?: boolean; patchPath?: string; applyError?: string; heldForReview?: boolean } | undefined;
      let mergeLine = '';
      if (childWorkspace.isolation && !worktreeSettled) {
        try {
          // BUILD-LOOP P2.5 — HOLD the child's changes (don't auto-merge) when it's a
          // build fan-out slice (`holdWorktree` → the synthesis gate owns the merge) or
          // when `cli.worktreeMergeReview` is on (the user applies). Either way the work
          // is captured as a recovery patch and surfaced via `/agents diff <id>`.
          const holdReason: WorktreeHoldReason | null =
            args.holdWorktree === true ? 'fanout' : getCliKnobs().worktreeMergeReview === 'on' ? 'review' : null;
          const cleanup = removeChildWorktree(childWorkspace.isolation, {
            applyBack: !holdReason,
            patchFile: worktreePatchFile(ctx.workspaceRoot, record.id),
          });
          worktreeSettled = true;
          applyWorktreeCleanup(ctx.workspaceRoot, record.id, cleanup);
          if (cleanup.changedFiles) {
            worktreeSummary = {
              changedFiles: cleanup.changedFiles,
              applied: cleanup.applied,
              patchPath: cleanup.patchPath,
              applyError: cleanup.applyError,
              heldForReview: !!holdReason,
            };
            mergeLine = mergeBackLine(cleanup, record.id, holdReason);
          }
        } catch (mergeErr: any) {
          console.error(`[BrainRouter] child ${record.id} merge-back threw (isolated):`, mergeErr?.message ?? mergeErr);
        }
      }

      const AGENT_PREVIEW_MAX = Math.max(400, getCliKnobs().agentPreviewChars);
      const previewBody = (output
        ? (output.length <= AGENT_PREVIEW_MAX
            ? output
            : extractChildPreview(output, AGENT_PREVIEW_MAX))
        : (storedOutput ?? '').slice(0, AGENT_PREVIEW_MAX)) + mergeLine;
      ctx.onChildComplete?.({
        childId: record.id,
        role: role.name,
        status: 'completed',
        preview: previewBody,
        worktree: worktreeSummary,
      });
      if (reportCompletionToParent) {
        enqueueCompletion(ctx.parentSessionKey, {
          kind: 'agent', id: record.id, status: 'completed',
          label: role.name, summary: storedOutput, completedAt,
        });
      }

      // Auto-chain (MAS-P4-T4): when a worker finishes, optionally chain a
      // review and/or verify follow-up on its output — closing the "agent
      // shipped, did it actually work?" loop without the user remembering
      // to ask. Only workers chain, and reviewers/verifiers aren't workers,
      // so a follow-up never triggers another follow-up. `autoChain` is the
      // canonical mode; legacy `/auto-review on` resolves to `review`.
      if (role.name === 'worker') {
        const prefs = readPreferences(ctx.workspaceRoot);
        const mode = resolveAutoChainMode(prefs);
        const roles = autoChainRoles(mode, getCliKnobs().autoChainMaxFollowups);
        const followUps: string[] = [];
        for (const followRole of roles) {
          const verb = followRole === 'verifier' ? 'Verify' : 'Review';
          const detail =
            followRole === 'verifier'
              ? 'Run the relevant tests / build and confirm the work is correct.'
              : 'Review the diff for correctness, regressions, and missed requirements.';
          const out = await handleSpawn(
            {
              role: followRole,
              prompt: `Auto-${followRole === 'verifier' ? 'verify' : 'review'} the changes made by worker agent ${record.id}. ${detail}\n\nOriginal task:\n${prompt}\n\nWorker output (or ref):\n${storedOutput}`,
              label: `auto-${followRole}-${record.id}`,
              access: followRole === 'verifier' ? 'shell' : 'read',
              seedRecordIds: seededIds,
              // Pre-authorized by the user's /auto-chain setting → no approval prompt.
              autoChainFollowup: true,
            },
            ctx,
          );
          try {
            const id = JSON.parse(out)?.id;
            if (typeof id === 'string') followUps.push(id);
          } catch {
            /* spawn returned a non-JSON string — skip id capture */
          }
          void verb;
        }
        if (followUps.length > 0) {
          // Record on the worker so wait/summarize can surface the chain,
          // and emit a visible note for the live REPL.
          updateSession(ctx.workspaceRoot, record.id, { autoChainFollowups: roles });
          ctx.onChildComplete?.({
            childId: record.id,
            role: role.name,
            status: 'completed',
            preview: `Follow-up agents: ${roles.join(', ')} (auto-chain: ${mode})`,
          });
        }
      }
    } catch (err: any) {
      // ORCH-FIX — a child failure must stay ISOLATED. Do all failure
      // bookkeeping inside its own try/catch so a throwing callback
      // (onChildComplete / updateSession / emitRouteFeedback) can't turn this
      // into a REJECTED promise → unhandled rejection → process exit.
      try {
        const message = err?.message ?? String(err);
        const syntheticOutput = `ERROR: ${message}`;
        const completedAt = new Date().toISOString();
        updateSession(ctx.workspaceRoot, record.id, {
          status: 'failed',
          completedAt,
          error: message,
          finalOutput: syntheticOutput,
        });
        void emitRouteFeedback(ctx, {
          task: prompt,
          chosenAgentId: role.name,
          parentAgentId: ctx.parentAgentId,
          ownership,
          outcome: 'failure',
          record,
          completedAt,
        });
        ctx.onChildComplete?.({
          childId: record.id,
          role: role.name,
          status: 'failed',
          error: message,
        });
        if (reportCompletionToParent) {
          enqueueCompletion(ctx.parentSessionKey, {
            kind: 'agent', id: record.id, status: 'failed',
            label: role.name, summary: message, completedAt,
          });
        }
      } catch (bookkeepingErr: any) {
        console.error(`[BrainRouter] child ${record.id} failure-bookkeeping threw (isolated):`, bookkeepingErr?.message ?? bookkeepingErr);
      }
    } finally {
      runningPromises.delete(record.id);
      runningChildAgents.delete(record.id); // DESK-6 — handle no longer interruptible
      // CODEX-WORKTREE-CLEANUP — tear down the child's git worktree when it
      // finishes (success or failure). Captures a capped diff into the record
      // first so the child's work isn't silently lost, then removes the
      // worktree + prunes git's admin entry (no more unbounded $TMPDIR growth).
      // CODEX-WORKTREE-MERGEBACK — only reached when the success-path merge-back
      // did NOT run (the child failed/threw, or merge-back itself threw). Capture
      // + PRESERVE the child's work as a recovery patch (no apply — a non-clean
      // child must never auto-mutate the parent tree), then remove the worktree.
      if (childWorkspace.isolation && !worktreeSettled) {
        try {
          const cleanup = removeChildWorktree(childWorkspace.isolation, {
            applyBack: false,
            patchFile: worktreePatchFile(ctx.workspaceRoot, record.id),
          });
          applyWorktreeCleanup(ctx.workspaceRoot, record.id, cleanup);
        } catch (cleanupErr: any) {
          console.error(`[BrainRouter] child ${record.id} worktree cleanup threw:`, cleanupErr?.message ?? cleanupErr);
        }
      }
    }
  })();
  // ORCH-FIX — backstop: a child promise must NEVER reject unhandled (that would
  // hit the global unhandledRejection handler and kill the session). The IIFE
  // already isolates child errors; this guarantees it even if something slips
  // through. handleWait awaits this guarded promise, so a child failure resolves
  // the wait rather than rejecting it.
  runningPromises.set(
    record.id,
    promise.catch((e: any) => {
      console.error(`[BrainRouter] child ${record.id} promise rejected (isolated):`, e?.message ?? e);
    }),
  );

  if (args.wait) {
    return await handleWait({ id: record.id, timeoutMs: args.timeoutMs ?? parentWaitTimeoutMs }, ctx);
  }
  return JSON.stringify({
    id: record.id,
    role: role.name,
    access,
    status: 'running',
    workdir: childLaunchCwd,
    workspaceRoot: childWorkspaceRoot,
    isolatedWorkspace: childWorkspace.isolated,
    isolation: childWorkspace.isolation,
    notice: childWorkspace.notice,
    timeoutMs: parentWaitTimeoutMs,
  }, null, 2);
}

function handleList(ctx: OrchestrationContext): string {
  const sessions = listSessions(ctx.workspaceRoot);
  return JSON.stringify(sessions.map(s => summarize(s)), null, 2);
}

async function handleWait(args: any, ctx: OrchestrationContext): Promise<string> {
  const id = String(args.id ?? '');
  if (!id) throw new Error('wait_agent requires an id.');
  const rawTimeoutMs = args.timeoutMs === undefined ? 120_000 : Number(args.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeoutMs) ? rawTimeoutMs : 120_000;

  const promise = runningPromises.get(id);
  if (promise) {
    // DESK-6 — a Stop makes the wait return immediately. The child is NOT
    // killed (it keeps running detached and auto-drains next turn via
    // lastTurnPendingChildIds); the parent just stops blocking on it.
    const interruptedJson = (): string => {
      const record = getSession(ctx.workspaceRoot, id);
      return JSON.stringify({
        id, status: 'interrupted', childStatus: record?.status ?? 'running',
        role: record?.role, label: record?.label,
        summary: 'Wait interrupted by user — the child keeps running in the background.',
      }, null, 2);
    };
    const sig = ctx.interruptSignal;
    if (sig?.aborted) return interruptedJson();
    const interruptRacer = sig
      ? new Promise<void>((resolve) => sig.addEventListener('abort', () => resolve(), { once: true }))
      : null;
    if (timeoutMs <= 0) {
      await (interruptRacer ? Promise.race([promise, interruptRacer]) : promise);
      if (sig?.aborted) return interruptedJson();
    } else {
      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;
      const racers: Promise<void>[] = [
        promise,
        new Promise<void>((resolve) => { timeout = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); }),
      ];
      if (interruptRacer) racers.push(interruptRacer);
      await Promise.race(racers);
      if (timeout) clearTimeout(timeout);
      if (sig?.aborted) return interruptedJson();
      if (timedOut) {
        const record = getSession(ctx.workspaceRoot, id);
        return JSON.stringify({
          id,
          status: 'timeout',
          childStatus: record?.status ?? 'unknown',
          role: record?.role,
          label: record?.label,
          summary: record ? formatSessionSummary(record) : `No child session with id ${id}.`,
        }, null, 2);
      }
    }
  }

  // Delivered in-turn — drop any pending next-turn feedback for this child.
  acknowledgeCompletions(ctx.parentSessionKey, [id]);

  const record = getSession(ctx.workspaceRoot, id);
  if (!record) {
    // ORCH-FIX — return a value, never throw: a missing record (closed / never
    // started / bad id) must not reject a wait batch and stall the parent.
    return JSON.stringify(
      { id, status: 'gone', summary: `No child session with id ${id} (closed, never started, or unknown id).` },
      null,
      2,
    );
  }
  return JSON.stringify(summarize(record, true), null, 2);
}

function handleReadTranscript(args: any, ctx: OrchestrationContext): string {
  const id = String(args.id ?? '');
  const limit = Number(args.limit ?? 40);
  const record = getSession(ctx.workspaceRoot, id);
  if (!record) throw new Error(`No child session with id ${id}.`);
  const childKey = childSessionKey(record.parentSessionKey, record.id);
  const transcriptRoot = record.childWorkspaceRoot ?? ctx.workspaceRoot;
  const entries = readTranscriptEntries(transcriptRoot, childKey, limit);
  return JSON.stringify({ id, entries }, null, 2);
}

function handleClose(args: any, ctx: OrchestrationContext): string {
  const id = String(args.id ?? '');
  const record = getSession(ctx.workspaceRoot, id);
  if (!record) throw new Error(`No child session with id ${id}.`);
  // CODEX-WORKTREE-CLEANUP — explicit close also removes a lingering worktree
  // (e.g. a wait:false child the parent never drained). Idempotent: the spawn
  // finally usually removed it already, and removeChildWorktree no-ops if gone.
  const patch: Partial<ChildSessionRecord> = { status: 'closed', completedAt: new Date().toISOString() };
  if (record.childWorkspaceIsolation) {
    try {
      // Capture-only on manual close (no applyBack): the spawn lifecycle already
      // merged a cleanly-completed child. Close just GCs a lingering worktree and
      // preserves any unmerged work as a recovery patch for `git apply`.
      const cleanup = removeChildWorktree(record.childWorkspaceIsolation, {
        patchFile: worktreePatchFile(ctx.workspaceRoot, record.id),
      });
      if (cleanup.diff && !record.worktreeDiff) patch.worktreeDiff = cleanup.diff;
      if (typeof cleanup.changedFiles === 'number' && record.worktreeChangedFiles == null) patch.worktreeChangedFiles = cleanup.changedFiles;
      if (cleanup.patchPath && !record.worktreePatchPath) patch.worktreePatchPath = cleanup.patchPath;
    } catch { /* best-effort */ }
  }
  const next = updateSession(ctx.workspaceRoot, id, patch);
  return JSON.stringify(summarize(next, true), null, 2);
}

async function handleSendInput(args: any, ctx: OrchestrationContext): Promise<string> {
  const id = String(args.id ?? '').trim();
  const message = String(args.message ?? '').trim();
  if (!id) throw new Error('send_input requires an id.');
  if (!message) throw new Error('send_input requires a non-empty message.');
  return await continueChildAgent({ id, message, interrupt: args.interrupt === true }, ctx);
}

async function handleResumeAgent(args: any, ctx: OrchestrationContext): Promise<string> {
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('resume_agent requires an id.');
  const message = typeof args.message === 'string' && args.message.trim()
    ? args.message.trim()
    : 'Continue from the current child-agent transcript. If the prior task is already complete, summarize the current state and any remaining next step.';
  return await continueChildAgent({ id, message, interrupt: false }, ctx);
}

function resolveRecordRole(record: ChildSessionRecord, workspaceRoot: string): {
  role: ReturnType<typeof resolveRole>;
  tier?: Tier;
  toolScope?: { local: string[]; mcp: string[] };
  disallowedTools?: string[];
} {
  const loaded = findById(record.role, workspaceRoot);
  if (loaded) {
    return {
      role: {
        name: loaded.def.id,
        description: loaded.def.whenToUse,
        defaultAccess: loaded.def.defaultAccess,
        promptOverlay: loaded.def.prompt,
      },
      tier: loaded.def.tier,
      toolScope: loaded.def.toolScope,
      disallowedTools: loaded.def.disallowedTools,
    };
  }
  return { role: resolveRole(record.role), tier: record.tier };
}

async function continueChildAgent(
  input: { id: string; message: string; interrupt: boolean },
  ctx: OrchestrationContext,
): Promise<string> {
  let record = getSession(ctx.workspaceRoot, input.id);
  if (!record) throw new Error(`No child session with id ${input.id}.`);
  if (record.childWorkspaceIsolation) {
    throw new Error(
      `send_input/resume_agent cannot continue isolated-worktree child ${input.id}. ` +
      `Its temporary workspace may have been merged or removed; spawn a new child with the needed context instead.`,
    );
  }

  const running = runningPromises.get(input.id);
  if (running) {
    if (!input.interrupt) {
      throw new Error(`Child agent ${input.id} is already running. Call wait_agent, or pass interrupt:true to send_input first.`);
    }
    runningChildAgents.get(input.id)?.agent.requestInterrupt();
    await running;
    record = getSession(ctx.workspaceRoot, input.id);
    if (!record) throw new Error(`Child session ${input.id} disappeared after interrupt.`);
  } else if (record.status === 'running' || record.status === 'pending') {
    throw new Error(`Child agent ${input.id} is marked ${record.status} but has no live task in this process. Wait for it, close it, or restart and resume once it is stale/closed.`);
  }

  const transcriptRoot = record.childWorkspaceRoot && fs.existsSync(record.childWorkspaceRoot)
    ? record.childWorkspaceRoot
    : ctx.workspaceRoot;
  const childLaunchCwd = record.childLaunchCwd && fs.existsSync(record.childLaunchCwd)
    ? record.childLaunchCwd
    : ctx.launchCwd;
  const childKey = childSessionKey(record.parentSessionKey, record.id);
  const { role, tier, toolScope, disallowedTools } = resolveRecordRole(record, ctx.workspaceRoot);
  const basePrompt = buildSystemPrompt({
    workspaceRoot: transcriptRoot,
    launchCwd: childLaunchCwd,
    sessionKey: childKey,
    instructionSummary: loadWorkspaceInstructionSummary(transcriptRoot),
  });
  const childLlm = resolveAgentLlm(loadOrInitConfig(), ctx.llmConfig, role.name);
  const childAgent = new Agent(ctx.mcpClient, childLlm, {
    workspaceRoot: transcriptRoot,
    launchCwd: childLaunchCwd,
    sessionKey: childKey,
    roleOverlay: undefined,
    accessMode: record.access,
    silent: true,
    forceFleetSandbox: role.forceSandbox || ctx.ancestorFleet, // HONK-H0 — fleet role OR fleet ancestor → locked-down posture
    enableRecall: true,
    systemPromptOverride: buildRolePrompt(role, basePrompt, ''),
    parentTraceId: ctx.parentTraceId,
    parentSpanId: ctx.parentSpanId,
    tier,
    agentDepth: record.depth ?? 1,
    ownership: record.parentContext?.ownership ?? null,
    toolScope,
    disallowedTools,
    parentReviewPolicy: ctx.parentReviewPolicy as 'request' | 'proceed' | undefined,
    parentExecutionMode: ctx.parentExecutionMode as 'planning' | 'fast' | undefined,
    confirmToolApproval: ctx.confirmToolApproval
      ? (info) => ctx.confirmToolApproval!({ childId: record!.id, role: role.name, ...info })
      : undefined,
  });
  childAgent.loadHistory(loadTranscript(transcriptRoot, childKey));
  if (ctx.parentAgentId) childAgent.setParentAgentId(ctx.parentAgentId);

  runningChildAgents.set(record.id, { agent: childAgent, parentSessionKey: ctx.parentSessionKey });
  updateSession(ctx.workspaceRoot, record.id, { status: 'running', error: undefined });
  const childToolStarts = new Map<string, number>();

  try {
    const output = await childAgent.runTurn(input.message, {
      onStatusUpdate: () => {},
      onToolStart: (tool, args) => {
        childToolStarts.set(tool, Date.now());
        ctx.onChildToolStart?.({ childId: record!.id, role: role.name, tool, args: args ?? {} });
      },
      onToolEnd: (tool, result) => {
        const startedAt = childToolStarts.get(tool);
        childToolStarts.delete(tool);
        ctx.onChildToolEnd?.({
          childId: record!.id,
          role: role.name,
          tool,
          ok: result.success,
          summary: result.summary,
          preview: result.preview,
          durationMs: startedAt ? Date.now() - startedAt : 0,
        });
      },
    });
    const completedAt = new Date().toISOString();
    const next = updateSession(ctx.workspaceRoot, record.id, {
      status: 'completed',
      completedAt,
      finalOutput: output,
      filesRead: childAgent.filesRead,
      usage: { ...childAgent.sessionUsage },
    });
    ctx.recordChildTokens?.(
      (childAgent.sessionUsage?.promptTokens ?? 0) +
      (childAgent.sessionUsage?.completionTokens ?? 0),
    );
    ctx.onChildComplete?.({
      childId: record.id,
      role: role.name,
      status: 'completed',
      preview: output.length <= getCliKnobs().agentPreviewChars
        ? output
        : extractChildPreview(output, getCliKnobs().agentPreviewChars),
    });
    return JSON.stringify({ resumed: true, ...summarize(next, true) }, null, 2);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const next = updateSession(ctx.workspaceRoot, record.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: message,
      finalOutput: `ERROR: ${message}`,
    });
    ctx.onChildComplete?.({ childId: record.id, role: role.name, status: 'failed', error: message });
    return JSON.stringify({ resumed: false, ...summarize(next, true) }, null, 2);
  } finally {
    runningChildAgents.delete(record.id);
  }
}

async function offloadChildOutput(
  ctx: OrchestrationContext,
  childId: string,
  role: string,
  prompt: string,
  output: string,
): Promise<string | undefined> {
  const res = await callMcpTool<any>(ctx.mcpClient, 'memory_working_offload', {
    sessionKey: childSessionKey(ctx.parentSessionKey, childId),
    workspacePath: ctx.workspaceRoot,
    payload: output,
    title: `Child ${childId} (${role}) output`,
    summary: prompt.slice(0, 240),
    kind: `child-agent-${role}`,
  });
  if (res.isError) return undefined;
  return res.parsed?.refNodeId ?? res.parsed?.nodeId ?? res.parsed?.ref ?? undefined;
}

// CODEX-WORKTREE-MERGEBACK — persist a worktree-cleanup result onto the child
// record (capped diff + change count + recovery patch path + apply outcome).
// Shared by the success path (merge-back) and the failure/teardown path.
function applyWorktreeCleanup(
  workspaceRoot: string,
  childId: string,
  cleanup: { diff?: string; changedFiles?: number; patchPath?: string; applied?: boolean; applyError?: string },
): void {
  const patch: Partial<ChildSessionRecord> = {};
  if (cleanup.diff) patch.worktreeDiff = cleanup.diff;
  if (typeof cleanup.changedFiles === 'number') patch.worktreeChangedFiles = cleanup.changedFiles;
  if (cleanup.patchPath) patch.worktreePatchPath = cleanup.patchPath;
  if (typeof cleanup.applied === 'boolean') patch.worktreeApplied = cleanup.applied;
  if (cleanup.applyError) patch.worktreeApplyError = cleanup.applyError;
  if (Object.keys(patch).length > 0) {
    try { updateSession(workspaceRoot, childId, patch); } catch { /* record may be closed */ }
  }
}

function summarize(record: ChildSessionRecord, includeOutput = false): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: record.id,
    role: record.role,
    status: record.status,
    access: record.access,
    label: record.label,
    // MAS-P3: surface the child's ownership boundary so the parent can see
    // which files each child was allowed to touch when synthesizing.
    ownership: record.parentContext?.ownership ?? null,
    // MAS-P4-T4: follow-up agents auto-chained after this worker, if any.
    followUps: record.autoChainFollowups ?? undefined,
    // MAS-P4-T3: per-child accounting (tokens, calls, offloaded chars, wall-clock).
    usage: record.usage ?? undefined,
    workspaceRoot: record.childWorkspaceRoot ?? undefined,
    workdir: record.childLaunchCwd ?? undefined,
    isolation: record.childWorkspaceIsolation ?? undefined,
    isolationNotice: record.childWorkspaceNotice ?? undefined,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    summary: formatSessionSummary(record),
  };
  // CODEX-WORKTREE-MERGEBACK — surface the child's isolated-worktree changes so the
  // parent can see + recover them. With merge-back the edits land in the parent tree
  // (`applied: true`); otherwise the full patch waits at `patchPath` for `git apply`.
  if (record.worktreeChangedFiles != null || record.worktreePatchPath || record.worktreeApplyError) {
    base.worktree = {
      changedFiles: record.worktreeChangedFiles ?? undefined,
      applied: record.worktreeApplied ?? undefined,
      patchPath: record.worktreePatchPath ?? undefined,
      applyError: record.worktreeApplyError ?? undefined,
    };
  }
  if (includeOutput) {
    if (record.finalOutput) base.finalOutput = record.finalOutput;
    if (record.error) base.error = record.error;
    if (record.filesRead?.length) base.filesRead = record.filesRead; // MAS-READMANIFEST
    if (record.worktreeDiff) base.worktreeDiff = record.worktreeDiff;
    // MAS-P3-P3.2: when the role has an output contract, surface the parsed
    // fields (or the unparsed/missing signal) so `wait_agent --json` /
    // `wait_agents --json` callers get structured output, not just prose.
    const parsed = parseChildOutput(record.role, record.finalOutput);
    if (parsed) base.contract = parsed;
  }
  return base;
}
