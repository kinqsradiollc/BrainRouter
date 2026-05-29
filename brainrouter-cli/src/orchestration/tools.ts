import { Agent } from '../agent/agent.js';
import fs from 'node:fs';
import path from 'node:path';
// 0.3.7 — Multi-MCP support. The orchestrator forwards the parent's
// pool to spawned children so a child can call tools across every
// configured MCP server, not just the one the parent happened to be
// connected to. The Pool's facade matches the single-Wrapper API so
// this is a near-no-op type swap.
import type { McpClientPool as McpClientWrapper } from '../runtime/mcpPool.js';
import type { LLMConfig } from '../config/config.js';
import { getCliKnobs } from '../config/config.js';
import {
  createSession,
  formatSessionSummary,
  getSession,
  listSessions,
  updateSession,
  type ChildSessionRecord,
} from './orchestrator.js';
import { buildRolePrompt, resolveRole, type AccessMode } from './roles.js';
import { ownershipRequirementError } from './ownership.js';
import { findById, listAll, type Tier } from './agentRegistry.js';
import { buildSystemPrompt, loadWorkspaceInstructionSummary } from '../prompt/systemPrompt.js';
import { appendTranscriptEntry, readTranscriptEntries } from '../state/sessionStore.js';
import { callMcpTool, childSessionKey } from '../runtime/mcpUtils.js';
import { readPreferences } from '../state/preferencesStore.js';
import { resolveAutoChainMode, autoChainRoles } from './autoChain.js';
import { buildParentExecutionContextSnapshot } from './parentContext.js';
import { getOutputContract } from './outputContracts.js';
import { routeTask } from './router.js';
import { emitAgentRouteFeedback, type RouteOutcome } from './memoryEvents.js';

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
  /** Parent agent tier — used for hierarchy checks (worker cannot spawn; reasoning can only spawn workers). */
  parentTier?: Tier;
  /** Current spawn-chain depth (0 = direct child of chat root). */
  depth?: number;
  mcpClient: McpClientWrapper;
  llmConfig: LLMConfig;
  launchCwd: string;
  /** Called when a child output got offloaded — chars beyond preview that didn't land in parent context. */
  recordOffload?: (charsAvoided: number) => void;
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
  onChildComplete?: (event: { childId: string; role: string; status: 'completed' | 'failed'; preview?: string; error?: string }) => void;
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

// Default wait/timeout for foreground delegation. Mirrors wait_agent's
// historical 120 s default so task_agent and spawn_agent({ wait: true })
// behave identically when no explicit timeoutMs is passed. Only used inside
// handleTaskAgent (call-time); kept out of the schema-creator bodies to
// avoid the ESM circular-import TDZ between tools.ts and agent.ts (agent.ts
// constructs the LOCAL_TOOLS array eagerly at module load).
const DEFAULT_TASK_AGENT_TIMEOUT_MS = 120_000;
const DEFAULT_CHILD_AGENT_TIMEOUT_MS = 10 * 60_000;

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
  'route_agent',
  'route_task',
]);

/**
 * Heuristic auto-router. Maps a free-text task to the best role based on
 * leading verbs and intent keywords. Pure text-classification — callers can
 * opt in via `route_agent` without first spending an LLM turn.
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

function childTimeoutMsFromArgs(args: any): number {
  const knobValue = getCliKnobs().childAgentTimeoutMs;
  const raw = Number(args?.timeoutMs ?? knobValue ?? DEFAULT_CHILD_AGENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHILD_AGENT_TIMEOUT_MS;
}

async function withChildDeadline<T>(promise: Promise<T>, timeoutMs: number, childId: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Child agent ${childId} exceeded wall-clock timeout (${timeoutMs}ms).`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createSpawnAgentTool() {
  return {
    name: 'spawn_agent',
    description: 'Spawn a child agent and a bounded prompt. Returns the child agent id immediately; the child runs in the background. Specify the agent via `role` (legacy: explorer/architect/reviewer/worker/verifier) or `agentId` (registry id, e.g. a custom workspace definition).',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'One of: explorer, architect, reviewer, worker, verifier. Prefer agentId for custom definitions.' },
        agentId: { type: 'string', description: 'Registry id of the agent definition. Takes precedence over role when both are provided.' },
        prompt: { type: 'string', description: 'The bounded task prompt for the child agent.' },
        label: { type: 'string', description: 'Optional short label for the child run.' },
        access: { type: 'string', enum: ['read', 'write', 'shell'], description: 'Override the role default access mode. Default: role default.' },
        wait: { type: 'boolean', description: 'If true, block until the child completes and return its final output. Default: false.' },
        timeoutMs: { type: 'integer', description: 'Optional child wall-clock timeout in milliseconds. Also bounds wait=true. Default 120000 when wait=true; otherwise 600000.' },
        workdir: { type: 'string', description: 'Optional workspace-relative child launch directory. Must exist; invalid values fall back to the parent CWD.' },
        seedRecordIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional BrainRouter memory record IDs that the parent already recalled. The child agent is told to build on these instead of re-discovering them.',
        },
      },
      required: ['prompt'],
    },
  };
}

export function createTaskAgentTool() {
  return {
    name: 'task_agent',
    description:
      'Launch a new agent to handle complex, multi-step tasks autonomously. Returns the completed child output (foreground, blocks).\n\n' +
      'When using task_agent, specify a `role` to select which specialized agent type to use. Roles: explorer (read-only investigation), architect (design alternatives), reviewer (code review), worker (write access), verifier (tests/checks). Use `agentId` for custom workspace definitions.\n\n' +
      'When NOT to use task_agent:\n' +
      '- Specific file path → use read_file directly.\n' +
      '- Named class/function ("class Foo") → use grep_search directly.\n' +
      '- Code within 2-3 known files → use read_file.\n' +
      '- Trivial one-shot questions answerable from one tool call.\n\n' +
      'Usage notes:\n' +
      '- Always include a short `label` (3-5 words) summarizing the task.\n' +
      '- Launch multiple agents concurrently when possible — single assistant message with multiple task_agent tool_calls.\n' +
      '- The agent\'s result is NOT visible to the user; after it returns, write a text summary so the user sees the findings.\n' +
      '- Each invocation starts with fresh context — provide a complete task description (file paths, scope, what to return).\n' +
      '- Tell the agent whether you expect code-writing or research-only — it is not aware of the user\'s intent.\n' +
      '- If the user says run agents "in parallel", you MUST send one message with multiple task_agent tool_calls.\n' +
      '- For background fire-and-forget when you have parent-side work to do, use delegate_agent instead and call wait_agent when the result is needed.\n\n' +
      'Writing the prompt: brief the child like a smart colleague who just walked in. Explain what you\'re accomplishing and why, what you\'ve already learned or ruled out, enough context for judgment calls. Include file paths and line numbers. **Never delegate understanding** — don\'t write "based on your findings, fix the bug"; that pushes synthesis onto the child. Terse command-style prompts produce shallow generic work.\n\n' +
      '**Trust but verify:** a child\'s returned summary describes what it INTENDED to do, not necessarily what it actually did. When a child writes or edits code, read the actual changes (git diff, read_file) before reporting work as done. Adapted from Claude Code\'s Agent-tool guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'One of: explorer, architect, reviewer, worker, verifier. Prefer agentId for custom definitions.' },
        agentId: { type: 'string', description: 'Registry id of the agent definition. Takes precedence over role when both are provided.' },
        prompt: { type: 'string', description: 'The bounded task prompt for the child agent.' },
        label: { type: 'string', description: 'Optional short label for the child run.' },
        access: { type: 'string', enum: ['read', 'write', 'shell'], description: 'Override the role default access mode. Default: role default.' },
        timeoutMs: { type: 'integer', description: 'Optional timeout in milliseconds. Default 120000.' },
        workdir: { type: 'string', description: 'Optional workspace-relative child launch directory. Must exist; invalid values fall back to the parent CWD.' },
        seedRecordIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional BrainRouter memory record IDs that the parent already recalled.',
        },
      },
      required: ['prompt'],
    },
  };
}

export function createDelegateAgentTool() {
  return {
    name: 'delegate_agent',
    description:
      'Start one background child agent and keep working in the parent turn. ' +
      'Non-blocking — there is no `timeoutMs`; the child runs until it finishes or is cancelled. ' +
      'Returns a running child id plus a reminder to continue useful work; call wait_agent later when the result is needed.\n\n' +
      'When to choose delegate_agent over task_agent: when you have genuinely independent parent-side work to fill the time (read other files, write a different section, run a benchmark) while the child runs. If you would just sit idle waiting, use task_agent instead — it returns the result directly.\n\n' +
      'Writing the prompt: same standard as task_agent — brief the child like a smart colleague who just walked in. Explain what you\'re accomplishing and why, what you\'ve already learned, enough context for judgment calls. Include file paths and line numbers. Never write "based on your findings, X" — write what to change, where. Terse prompts produce shallow work.\n\n' +
      '**Trust but verify after wait_agent:** the child\'s returned summary describes intent, not necessarily what landed on disk. If the child wrote or edited code, read the actual changes (git diff / read_file) before reporting the work as done to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'One of: explorer, architect, reviewer, worker, verifier. Prefer agentId for custom definitions.' },
        agentId: { type: 'string', description: 'Registry id of the agent definition. Takes precedence over role when both are provided.' },
        prompt: { type: 'string', description: 'The bounded task prompt for the child agent.' },
        label: { type: 'string', description: 'Optional short label for the child run.' },
        access: { type: 'string', enum: ['read', 'write', 'shell'], description: 'Override the role default access mode. Default: role default.' },
        workdir: { type: 'string', description: 'Optional workspace-relative child launch directory. Must exist; invalid values fall back to the parent CWD.' },
        seedRecordIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional BrainRouter memory record IDs that the parent already recalled.',
        },
      },
      required: ['prompt'],
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
      'Use this for batched fan-out (e.g. 3 explorers covering different parts of the codebase) instead of N back-to-back spawn_agent calls. ' +
      'Write/shell children MUST declare an `ownership` glob so parallel writers cannot collide — or pass `allowOverlap: true` on the entry to opt out.',
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
              workdir: { type: 'string' },
              seedRecordIds: { type: 'array', items: { type: 'string' } },
              ownership: { type: 'string', description: 'File glob this child may write within (e.g. "src/payments/**"). Required for write/shell access unless allowOverlap is set. Enforced on write_file / edit_file / apply_patch.' },
              allowOverlap: { type: 'boolean', description: 'Opt out of the ownership requirement for this entry (writes are then unbounded). Default false.' },
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
      'DEPRECATED — use `route_task` (MAS-P2-M2). Recommend a role (explorer/architect/reviewer/worker/verifier) for a task without spawning. The new tool returns a richer 4-tier policy decision (answer-direct / direct-tool / spawn-inline / spawn-worker) plus confidence + memory evidence.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
    },
  };
}

/**
 * MAS-P2-M2 — `route_task` tool. Returns a typed 4-tier policy
 * decision (answer-direct / direct-tool / spawn-inline / spawn-worker)
 * with the recommended tool, agent id (when inline), confidence, and
 * memory evidence (MAS-P2-M4).
 */
export function createRouteTaskTool() {
  return {
    name: 'route_task',
    description:
      'Direct-first delegation dry-run. Returns `{ tier, reason, recommendedTool, agentId, confidence, memoryEvidence }`. Tiers: `answer-direct` (no tool — reply in prose), `direct-tool` (one concrete tool answers — e.g. `read_file`, `grep_search`, `run_command`), `spawn-inline` (specialized child via `delegate_<id>`), `spawn-worker` (long-running tracked work; worker threads ship in 0.4.2). Call this BEFORE spawning to pick the right tier — fan-out without it routinely over-delegates.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task prompt the parent is considering routing.' },
      },
      required: ['task'],
    },
  };
}

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
          timeoutMs: { type: 'integer', description: 'Optional wall-clock timeout in ms.' },
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
    case 'route_agent':
      return handleRoute(args);
    case 'route_task':
      return await handleRouteTask(args, ctx);
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
  await emitAgentRouteFeedback(
    { mcpClient: ctx.mcpClient, sessionKey: ctx.parentSessionKey },
    {
      task: args.task,
      chosenAgentId: args.chosenAgentId,
      parentAgentId: args.parentAgentId,
      ownership: args.ownership,
      outcome: args.outcome,
      durationMs,
      tokenCost: args.tokenCost,
    },
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
  // Resolve agent definition via agentId (registry) or role (legacy).
  let role: ReturnType<typeof resolveRole>;
  let childTier: Tier | undefined;

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

  const requested = (args.access as AccessMode | undefined) ?? role.defaultAccess;
  const access = clampAccess(ctx.parentAccessMode ?? 'shell', requested);
  const childLaunchCwd = resolveChildLaunchCwd(ctx, args.workdir);
  const childTimeoutMs = childTimeoutMsFromArgs(args);
  const record = createSession(ctx.workspaceRoot, {
    role: role.name,
    prompt,
    parentSessionKey: ctx.parentSessionKey,
    access,
    label: typeof args.label === 'string' ? args.label : undefined,
    tier: childTier,
    depth: currentDepth + 1,
  });

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
  const ownership = typeof args.ownership === 'string' ? args.ownership : null;
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
  appendTranscriptEntry(ctx.workspaceRoot, childKey, {
    role: 'system',
    name: 'parent_context',
    content: JSON.stringify(snapshot),
  });

  const basePrompt = buildSystemPrompt({
    workspaceRoot: ctx.workspaceRoot,
    launchCwd: childLaunchCwd,
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
    launchCwd: childLaunchCwd,
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
    // Propagate tier and depth so grandchildren can enforce hierarchy caps.
    tier: childTier,
    agentDepth: currentDepth + 1,
    // MAS-P3: the ownership glob gates this child's file writes.
    ownership,
  });
  if (ctx.parentAgentId) childAgent.setParentAgentId(ctx.parentAgentId);

  updateSession(ctx.workspaceRoot, record.id, { status: 'running' });

  const promise = (async () => {
    try {
      // Track per-tool start times so the paired onChildToolEnd carries a
      // real duration — the REPL renders this on the child's end row.
      const childToolStarts = new Map<string, number>();
      // Inspired by deer-flow's synthetic dangling-tool-call recovery:
      // every child must resolve to an explicit result instead of leaving
      // the session running forever when an LLM/MCP call hangs.
      const output = await withChildDeadline(childAgent.runTurn(prompt, {
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
      }), childTimeoutMs, record.id);

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
      updateSession(ctx.workspaceRoot, record.id, {
        status: 'completed',
        completedAt,
        finalOutput: storedOutput,
        usage: { ...childAgent.sessionUsage },
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
      const AGENT_PREVIEW_MAX = Math.max(400, getCliKnobs().agentPreviewChars);
      const previewBody = output
        ? (output.length <= AGENT_PREVIEW_MAX
            ? output
            : extractChildPreview(output, AGENT_PREVIEW_MAX))
        : (storedOutput ?? '').slice(0, AGENT_PREVIEW_MAX);
      ctx.onChildComplete?.({
        childId: record.id,
        role: role.name,
        status: 'completed',
        preview: previewBody,
      });

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
    } finally {
      runningPromises.delete(record.id);
    }
  })();
  runningPromises.set(record.id, promise);

  if (args.wait) {
    return await handleWait({ id: record.id, timeoutMs: args.timeoutMs ?? childTimeoutMs }, ctx);
  }
  return JSON.stringify({ id: record.id, role: role.name, access, status: 'running', workdir: childLaunchCwd, timeoutMs: childTimeoutMs }, null, 2);
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
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
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
    // MAS-P3: surface the child's ownership boundary so the parent can see
    // which files each child was allowed to touch when synthesizing.
    ownership: record.parentContext?.ownership ?? null,
    // MAS-P4-T4: follow-up agents auto-chained after this worker, if any.
    followUps: record.autoChainFollowups ?? undefined,
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
