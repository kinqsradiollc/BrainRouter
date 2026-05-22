import { Agent } from '../agent/agent.js';
import type { McpClientWrapper } from '../runtime/mcpClient.js';
import type { LLMConfig } from '../config/config.js';
import {
  createSession,
  formatSessionSummary,
  getSession,
  listSessions,
  updateSession,
  type ChildSessionRecord,
} from './orchestrator.js';
import { buildRolePrompt, resolveRole, type AccessMode } from './roles.js';
import { buildSystemPrompt, loadWorkspaceInstructionSummary } from '../prompt/systemPrompt.js';
import { readTranscriptEntries } from '../state/sessionStore.js';
import { callMcpTool, childSessionKey } from '../runtime/mcpUtils.js';
import { readPreferences } from '../state/preferencesStore.js';

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
   * Parent OTEL trace context. When set, child agents nest their per-turn
   * spans under the dispatching `spawn_agent` tool span instead of starting
   * a fresh trace. Lets observability viewers reconstruct fan-out trees.
   */
  parentTraceId?: string;
  parentSpanId?: string;
  /** Parent agent_id so children can be grouped via attribute even without trace links. */
  parentAgentId?: string;
  mcpClient: McpClientWrapper;
  llmConfig: LLMConfig;
  launchCwd: string;
  /** Called when a child output got offloaded — chars beyond preview that didn't land in parent context. */
  recordOffload?: (charsAvoided: number) => void;
  /** Called when the child agent emits a tool call, for live observability. */
  onChildToolEvent?: (event: { childId: string; role: string; tool: string; ok: boolean; summary: string }) => void;
  /**
   * Called when a child agent's runTurn ends — success, fail, or empty answer.
   * Lets the REPL surface "✓ agent X completed" so the user knows when to act,
   * instead of seeing tool events and then silence.
   */
  onChildComplete?: (event: { childId: string; role: string; status: 'completed' | 'failed'; preview?: string; error?: string }) => void;
}

// Threshold above which a child agent's final output is offloaded to the
// BrainRouter working-memory canvas rather than embedded directly in the
// parent's context. ~6k chars ≈ 1.5k tokens — enough room for short reports
// in-line, big enough that a 20k-char architecture analysis goes out-of-band.
const OFFLOAD_THRESHOLD_CHARS = 6000;
const OFFLOAD_PREVIEW_CHARS = 800;

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

const ORCHESTRATION_TOOL_NAMES = new Set([
  'spawn_agent',
  'spawn_agents',
  'list_agents',
  'wait_agent',
  'wait_agents',
  'read_agent_transcript',
  'close_agent',
  'route_agent',
]);

/**
 * Heuristic auto-router. Maps a free-text task to the best role based on
 * leading verbs and intent keywords. Mirrors codex's role inference but keeps
 * it pure-text so callers can opt in via `route_agent` without first spending
 * an LLM turn.
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
  return ORCHESTRATION_TOOL_NAMES.has(name);
}

const runningPromises = new Map<string, Promise<void>>();

export function trackedPromiseFor(id: string): Promise<void> | undefined {
  return runningPromises.get(id);
}

export function createSpawnAgentTool() {
  return {
    name: 'spawn_agent',
    description: 'Spawn a child agent with a specific role (explorer, architect, reviewer, worker, verifier) and a bounded prompt. Returns the child agent id immediately; the child runs in the background.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'One of: explorer, architect, reviewer, worker, verifier.' },
        prompt: { type: 'string', description: 'The bounded task prompt for the child agent.' },
        label: { type: 'string', description: 'Optional short label for the child run.' },
        access: { type: 'string', enum: ['read', 'write', 'shell'], description: 'Override the role default access mode. Default: role default.' },
        wait: { type: 'boolean', description: 'If true, block until the child completes and return its final output. Default: false.' },
        timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds when wait=true. Default 120000.' },
        seedRecordIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional BrainRouter memory record IDs that the parent already recalled. The child agent is told to build on these instead of re-discovering them.',
        },
      },
      required: ['role', 'prompt'],
    },
  };
}

export function createListAgentsTool() {
  return {
    name: 'list_agents',
    description: 'List all child agent sessions for the current workspace with status, role, and elapsed time.',
    inputSchema: { type: 'object', properties: {} },
  };
}

export function createWaitAgentTool() {
  return {
    name: 'wait_agent',
    description: 'Wait for a child agent to complete. Returns final output, error, or timeout state.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Child agent id returned by spawn_agent.' },
        timeoutMs: { type: 'integer', description: 'Maximum wait time in ms. Default 120000.' },
      },
      required: ['id'],
    },
  };
}

export function createReadAgentTranscriptTool() {
  return {
    name: 'read_agent_transcript',
    description: 'Read recent transcript entries (default 40) of a child agent session.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Child agent id.' },
        limit: { type: 'integer', description: 'Max entries to return. Default 40.' },
      },
      required: ['id'],
    },
  };
}

export function createCloseAgentTool() {
  return {
    name: 'close_agent',
    description: 'Mark a child agent session closed without deleting its transcript. Use this for cleanup.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Child agent id.' } },
      required: ['id'],
    },
  };
}

export function createSpawnAgentsTool() {
  return {
    name: 'spawn_agents',
    description:
      'Spawn multiple child agents in parallel with one tool call. Returns all child ids immediately. ' +
      'Use this for batched fan-out (e.g. 3 explorers covering different parts of the codebase) instead of N back-to-back spawn_agent calls.',
    inputSchema: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'explorer | architect | reviewer | worker | verifier (omit to auto-route from the prompt).' },
              prompt: { type: 'string', description: 'Bounded task prompt for this child.' },
              label: { type: 'string' },
              access: { type: 'string', enum: ['read', 'write', 'shell'] },
              seedRecordIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['prompt'],
          },
        },
      },
      required: ['agents'],
    },
  };
}

export function createWaitAgentsTool() {
  return {
    name: 'wait_agents',
    description:
      'Wait for multiple child agents in parallel. Returns each child\'s final status / output / error. ' +
      'Use after spawn_agents to drain the whole batch before synthesizing.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        timeoutMs: { type: 'integer', description: 'Maximum total wait. Default 240000.' },
      },
      required: ['ids'],
    },
  };
}

export function createRouteAgentTool() {
  return {
    name: 'route_agent',
    description:
      'Recommend a role (explorer/architect/reviewer/worker/verifier) for a task without spawning. ' +
      'Useful when you want a sanity check on which role a free-text task should go to before calling spawn_agent.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
    },
  };
}

export async function executeOrchestrationTool(
  name: string,
  args: any,
  ctx: OrchestrationContext,
): Promise<string> {
  switch (name) {
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
    case 'route_agent':
      return handleRoute(args);
    default:
      throw new Error(`Unknown orchestration tool: ${name}`);
  }
}

async function handleSpawnBatch(args: any, ctx: OrchestrationContext): Promise<string> {
  const list = Array.isArray(args?.agents) ? args.agents : [];
  if (list.length === 0) throw new Error('spawn_agents requires at least one entry in `agents`.');
  const results: Array<Record<string, unknown>> = [];
  // Spawn sequentially so each gets a unique session id and createSession's
  // write isn't racy. The CHILDREN themselves still run in parallel — handleSpawn
  // kicks off the runTurn detached via runningPromises.set, then returns.
  for (const entry of list) {
    const role = entry.role ?? inferRoleFromTask(String(entry.prompt ?? ''));
    const out = await handleSpawn({ ...entry, role }, ctx);
    try {
      results.push(JSON.parse(out));
    } catch {
      results.push({ raw: out });
    }
  }
  return JSON.stringify({ spawned: results.length, agents: results }, null, 2);
}

async function handleWaitBatch(args: any, ctx: OrchestrationContext): Promise<string> {
  const ids = Array.isArray(args?.ids) ? args.ids.map(String) : [];
  if (ids.length === 0) throw new Error('wait_agents requires a non-empty `ids` array.');
  const timeoutMs = Number(args?.timeoutMs ?? 240_000);
  const settled = await Promise.all(ids.map(async (id: string) => {
    const single = await handleWait({ id, timeoutMs }, ctx);
    try {
      return JSON.parse(single);
    } catch {
      return { id, raw: single };
    }
  }));
  return JSON.stringify({ waited: settled.length, agents: settled }, null, 2);
}

function handleRoute(args: any): string {
  const task = String(args?.task ?? '');
  if (!task.trim()) throw new Error('route_agent requires `task`.');
  const role = inferRoleFromTask(task);
  const rationale = explainRoute(task, role);
  return JSON.stringify({ task: task.slice(0, 200), role, rationale }, null, 2);
}

function explainRoute(task: string, role: string): string {
  switch (role) {
    case 'explorer': return 'Verbs like "investigate / explore / map / find" → read-only investigation child.';
    case 'architect': return 'Verbs like "design / propose / plan / outline" → architect proposes ≥2 design alternatives.';
    case 'reviewer': return 'Verbs like "review / critique / evaluate" → reviewer reads diff, returns severity-ordered findings.';
    case 'verifier': return 'Verbs like "test / verify / typecheck" → verifier runs the suite and reports PASS/FAIL.';
    default: return 'Default → worker (write access for implementation).';
  }
}

async function handleSpawn(args: any, ctx: OrchestrationContext): Promise<string> {
  const role = resolveRole(String(args.role));
  const prompt = String(args.prompt ?? '');
  if (!prompt.trim()) throw new Error('spawn_agent requires a non-empty prompt.');

  const requested = (args.access as AccessMode | undefined) ?? role.defaultAccess;
  const access = clampAccess(ctx.parentAccessMode ?? 'shell', requested);
  const record = createSession(ctx.workspaceRoot, {
    role: role.name,
    prompt,
    parentSessionKey: ctx.parentSessionKey,
    access,
    label: typeof args.label === 'string' ? args.label : undefined,
  });

  const childKey = childSessionKey(ctx.parentSessionKey, record.id);
  const seededIds: string[] = Array.isArray(args.seedRecordIds)
    ? args.seedRecordIds.filter((id: unknown): id is string => typeof id === 'string').slice(0, 20)
    : [];
  const basePrompt = buildSystemPrompt({
    workspaceRoot: ctx.workspaceRoot,
    launchCwd: ctx.launchCwd,
    sessionKey: childKey,
    instructionSummary: loadWorkspaceInstructionSummary(ctx.workspaceRoot),
  });
  let systemPromptOverride = buildRolePrompt(role, basePrompt, '');
  if (seededIds.length > 0) {
    systemPromptOverride +=
      `\n\n## Parent-recalled BrainRouter records\n` +
      `The parent agent already recalled these memory record IDs: ${seededIds.join(', ')}. ` +
      `Call memory_recall (or memory_search) with the same intent before doing duplicate exploration, and prefer building on these records over re-deriving them.`;
  }

  const childAgent = new Agent(ctx.mcpClient, ctx.llmConfig, {
    workspaceRoot: ctx.workspaceRoot,
    launchCwd: ctx.launchCwd,
    sessionKey: childKey,
    // The role overlay is already embedded inside `systemPromptOverride` via
    // buildRolePrompt() above — passing it again as a separate field would
    // append a second copy and waste 1.5–3k tokens per child turn.
    roleOverlay: undefined,
    accessMode: access,
    silent: true,
    // Children NEED memory: skipping the briefing makes them amnesiac and the
    // parent LLM eventually learns inline work outperforms fan-out. With recall
    // enabled, children join the same cognitive context as the parent.
    enableRecall: true,
    systemPromptOverride,
    // Inherit the parent's OTEL trace context so spans nest under the
    // dispatching spawn_agent tool span instead of starting a fresh tree.
    parentTraceId: ctx.parentTraceId,
    parentSpanId: ctx.parentSpanId,
  });
  if (ctx.parentAgentId) childAgent.setParentAgentId(ctx.parentAgentId);

  updateSession(ctx.workspaceRoot, record.id, { status: 'running' });

  const promise = (async () => {
    try {
      const output = await childAgent.runTurn(prompt, {
        onStatusUpdate: () => {},
        onToolStart: () => {},
        onToolEnd: (tool, result) => {
          ctx.onChildToolEvent?.({
            childId: record.id,
            role: role.name,
            tool,
            ok: result.success,
            summary: result.summary,
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

      updateSession(ctx.workspaceRoot, record.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        finalOutput: storedOutput,
        usage: { ...childAgent.sessionUsage },
      });
      // Roll the offload savings into the parent's metrics so /tokens can
      // report what didn't have to land back in the parent's context window.
      if (workingRef && output.length > OFFLOAD_PREVIEW_CHARS) {
        ctx.recordOffload?.(output.length - OFFLOAD_PREVIEW_CHARS);
      }
      // Tell the REPL the child finished — otherwise the user sees the child's
      // tool calls scroll by and then silence, with no signal that it's safe
      // to ask the parent agent to continue.
      ctx.onChildComplete?.({
        childId: record.id,
        role: role.name,
        status: 'completed',
        preview: (storedOutput ?? '').replace(/\s+/g, ' ').slice(0, 160),
      });

      // Auto-review: when the user has /auto-review on and a worker just
      // finished, queue a reviewer agent on the worker's output. This closes
      // the "agent shipped, did it actually work" loop without the user
      // having to remember to ask.
      if (role.name === 'worker') {
        const prefs = readPreferences(ctx.workspaceRoot);
        if (prefs.autoReview) {
          await handleSpawn(
            {
              role: 'reviewer',
              prompt: `Auto-review the changes made by worker agent ${record.id}.\n\nOriginal task:\n${prompt}\n\nWorker output (or ref):\n${storedOutput}`,
              label: `auto-review-${record.id}`,
              access: 'read',
              seedRecordIds: seededIds,
            },
            ctx,
          );
        }
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      updateSession(ctx.workspaceRoot, record.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: message,
      });
      ctx.onChildComplete?.({
        childId: record.id,
        role: role.name,
        status: 'failed',
        error: message,
      });
    } finally {
      runningPromises.delete(record.id);
    }
  })();
  runningPromises.set(record.id, promise);

  if (args.wait) {
    return await handleWait({ id: record.id, timeoutMs: args.timeoutMs ?? 120000 }, ctx);
  }
  return JSON.stringify({ id: record.id, role: role.name, access, status: 'running' }, null, 2);
}

function handleList(ctx: OrchestrationContext): string {
  const sessions = listSessions(ctx.workspaceRoot);
  return JSON.stringify(sessions.map(s => summarize(s)), null, 2);
}

async function handleWait(args: any, ctx: OrchestrationContext): Promise<string> {
  const id = String(args.id ?? '');
  if (!id) throw new Error('wait_agent requires an id.');
  const timeoutMs = Number(args.timeoutMs ?? 120000);

  const promise = runningPromises.get(id);
  if (promise) {
    let timedOut = false;
    await Promise.race([
      promise,
      new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs)),
    ]);
    if (timedOut) {
      return JSON.stringify({ id, status: 'timeout' }, null, 2);
    }
  }

  const record = getSession(ctx.workspaceRoot, id);
  if (!record) throw new Error(`No child session with id ${id}.`);
  return JSON.stringify(summarize(record, true), null, 2);
}

function handleReadTranscript(args: any, ctx: OrchestrationContext): string {
  const id = String(args.id ?? '');
  const limit = Number(args.limit ?? 40);
  const record = getSession(ctx.workspaceRoot, id);
  if (!record) throw new Error(`No child session with id ${id}.`);
  const childKey = childSessionKey(record.parentSessionKey, record.id);
  const entries = readTranscriptEntries(ctx.workspaceRoot, childKey, limit);
  return JSON.stringify({ id, entries }, null, 2);
}

function handleClose(args: any, ctx: OrchestrationContext): string {
  const id = String(args.id ?? '');
  const record = getSession(ctx.workspaceRoot, id);
  if (!record) throw new Error(`No child session with id ${id}.`);
  const next = updateSession(ctx.workspaceRoot, id, { status: 'closed', completedAt: new Date().toISOString() });
  return JSON.stringify(summarize(next, true), null, 2);
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

function summarize(record: ChildSessionRecord, includeOutput = false): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: record.id,
    role: record.role,
    status: record.status,
    access: record.access,
    label: record.label,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    summary: formatSessionSummary(record),
  };
  if (includeOutput) {
    if (record.finalOutput) base.finalOutput = record.finalOutput;
    if (record.error) base.error = record.error;
  }
  return base;
}
