/**
 * MAS-P2-M2 + M4 — `route_task`: the direct-first delegation router.
 *
 * Returns a typed recommendation the LLM can act on:
 *
 *   { tier, reason, recommendedTool, agentId?, confidence, memoryEvidence }
 *
 * Six tiers, in escalation order:
 *
 *   - `answer-direct`   — no tool needed; reply in prose.
 *   - `direct-tool`     — one concrete tool (`read_file`, `grep_search`,
 *                          `web_search`, …) answers cleanly.
 *   - `spawn-inline`    — bounded specialized work; pick an agent and
 *                          synthesize the result.
 *   - `fan-out`         — separable breadth; several children on DISTINCT
 *                          lenses in one message → `spawn_agents`.
 *   - `workflow`        — a dependency chain (phases feeding forward) worth
 *                          recommending for an explicit host launch.
 *   - `spawn-worker`    — long-running / tracked / multi-turn work.
 *                          Worker threads themselves land in 0.4.2;
 *                          the tier is reserved so the policy is
 *                          stable across the cycle.
 *
 * The top two tiers exist because the escalation ladder used to stop at ONE
 * child: a prompt the product's own breadth heuristic classified as fan-out
 * still routed to a single `delegate_<role>`, so a model that dutifully called
 * `route_task` first was told to under-delegate. `fan-out` and `workflow` reuse
 * `breadthHint`'s scorer and veto rather than introducing a third keyword table
 * that could disagree with the hint the agent loop injects.
 *
 * M4 — memory-aware routing: when MCP is online, the router queries
 * `memory_recall` for past `agent_route_feedback` records and boosts
 * confidence + supplies `memoryEvidence: [recordId]` when a recent
 * successful match for a similar prompt is found. When MCP is offline
 * or the record kind doesn't exist yet (the producer ships in M6),
 * the router falls back to the regex baseline with confidence capped
 * at 0.6.
 */

import type { McpClientPool } from '../../mcp/mcpPool.js';
import { callMcpTool, hasMcpTool } from '../../mcp/mcpUtils.js';
import {
  BREADTH_FAN_OUT_THRESHOLD,
  detectBreadthIntent,
  detectFanOutVeto,
} from '../../prompt/planning/breadthHint.js';
import { inferRoleFromTask } from '../tools.js';

export type RouteTier =
  | 'answer-direct'
  | 'direct-tool'
  | 'spawn-inline'
  | 'fan-out'
  | 'workflow'
  | 'spawn-worker';

export interface RouteTaskResult {
  task: string;
  tier: RouteTier;
  reason: string;
  recommendedTool: string | null;
  agentId: string | null;
  confidence: number;
  memoryEvidence: string[];
}

const OFFLINE_CONFIDENCE_CAP = 0.6;
const MEMORY_BOOST = 0.15;

interface RouteTaskOptions {
  task: string;
  mcpClient?: McpClientPool;
  mcpToolNames?: Set<string>;
  sessionKey?: string;
  /** When true, skip the memory_recall hop entirely (mostly for tests). */
  skipMemory?: boolean;
  /** HONK-L6 — bias the tier toward bounded single tasks for local/weak models. */
  localModel?: boolean;
  /**
   * The local tools this turn can actually emit, after the workspace tool
   * policy, user overrides and skill allowlists have run.
   *
   * Omit it and every tool-backed tier is considered reachable — correct for
   * tests and for callers with no turn context. When it IS supplied, a tier
   * whose model-callable tool is not in it is skipped and the next-cheapest tier
   * answers instead. The workflow tier is a host-launch recommendation rather
   * than a model-callable tool, so it is intentionally independent of this set.
   */
  availableTools?: ReadonlySet<string>;
}

/**
 * HONK-L6 — steer local/weak models toward bounded single tasks. A detached
 * `spawn-worker` (outlives the turn, manages its own lifecycle) is exactly what
 * weak models botch; unless the long-running cue was STRONG (high confidence),
 * demote it to a bounded `spawn-inline` task they can actually finish. All other
 * tiers (answer-direct, direct-tool, spawn-inline) are already bounded — pass
 * through. Pure + exported for tests.
 *
 * `fan-out` and `workflow` demote unconditionally: coordinating several children
 * and synthesizing them is harder than running one, and a weak model that botches
 * the synthesis wastes N children instead of one.
 */
export function biasTierForLocalModel(tier: RouteTier, confidence: number): RouteTier {
  if (tier === 'spawn-worker' && confidence < 0.8) return 'spawn-inline';
  if (tier === 'fan-out' || tier === 'workflow') return 'spawn-inline';
  return tier;
}

export async function routeTask(options: RouteTaskOptions): Promise<RouteTaskResult> {
  const task = (options.task ?? '').trim();
  if (!task) {
    throw new Error('route_task requires a non-empty `task` argument.');
  }

  const baseline = baselineRoute(task, options.availableTools);
  // HONK-L6 — apply the local-model tier bias once; a demotion also drops the
  // worker-specific recommended tool and annotates the reason.
  const biasedTier = options.localModel ? biasTierForLocalModel(baseline.tier, baseline.confidence) : baseline.tier;
  const demoted = biasedTier !== baseline.tier;
  // A demoted multi-child tier still has a role to run inline, so hand back the
  // typed delegate rather than dropping the recommendation to nothing; only the
  // detached-worker demotion (no role) leaves the model without a tool.
  const recommendedTool = demoted
    ? (baseline.agentId ? `delegate_${baseline.agentId}` : null)
    : baseline.recommendedTool;
  const localNote = demoted
    ? ` (local-model: bounded inline task instead of ${baseline.tier === 'spawn-worker' ? 'a detached worker' : `a ${baseline.tier}`})`
    : '';
  const mcpOnline = Boolean(
    options.mcpClient && options.mcpToolNames && hasMcpTool(options.mcpToolNames, 'memory_recall'),
  );

  // No memory hop — return baseline with the offline cap on confidence.
  if (!mcpOnline || options.skipMemory) {
    return {
      task: clipTask(task),
      tier: biasedTier,
      reason: (mcpOnline ? baseline.reason : `${baseline.reason} (no memory hop)`) + localNote,
      recommendedTool,
      agentId: baseline.agentId,
      confidence: Math.min(baseline.confidence, OFFLINE_CONFIDENCE_CAP),
      memoryEvidence: [],
    };
  }

  // M4 memory hop: ask the brain whether past route-feedback records
  // would point at a different (or same, with more conviction) agent.
  const evidence = await fetchRouteFeedbackEvidence(options, task);
  if (evidence.length === 0) {
    // No prior signal — keep baseline at the regular confidence. The
    // memory hop fired but produced nothing actionable.
    return {
      task: clipTask(task),
      tier: biasedTier,
      reason: baseline.reason + localNote,
      recommendedTool,
      agentId: baseline.agentId,
      confidence: baseline.confidence,
      memoryEvidence: [],
    };
  }

  return {
    task: clipTask(task),
    tier: biasedTier,
    reason: `${baseline.reason} (memory: ${evidence.length} prior route(s) reinforce this choice)` + localNote,
    recommendedTool,
    agentId: baseline.agentId,
    confidence: clamp01(baseline.confidence + MEMORY_BOOST),
    memoryEvidence: evidence,
  };
}

interface BaselineRoute {
  tier: RouteTier;
  reason: string;
  recommendedTool: string | null;
  agentId: string | null;
  confidence: number;
}

const SHELL_VERBS = /^(run|test|build|deploy|publish|tag|release|merge|push)\b/;
const LONG_RUNNING = /\b(while i|in the background|long.?running|until|every \d|cron|schedule)\b/i;
const NEEDS_INVESTIGATION = /\b(investigate|explore|map|survey|audit|scan|why does|why is|where does|where is|how does|how is|trace)\b/i;
const NEEDS_DESIGN = /\b(design|architect|propose|alternatives?|tradeoff)\b/i;
const NEEDS_REVIEW = /\b(review|critique|evaluate|assess|nitpick)\b/i;
const NEEDS_VERIFY = /\b(verify|typecheck|lint|tests? pass|run tests)\b/i;
const ANSWER_DIRECT_GREETING = /^(hi|hey|hello|thanks|thank you|cool|ok|okay|nice|sounds good)[.!\s]*$/i;
const FILE_PATH = /[\w./-]+\.[a-z]{1,5}\b/i;
const SPECIFIC_LINE = /:\d+\b/;

/**
 * Only the multi-child tiers are gated. `delegate_<role>` is synthesized per
 * turn rather than registered, and the `direct-tool` names are the floor every
 * turn already has — gating either on a registered-tool snapshot would demote
 * on absence rather than on denial.
 */
function reachable(available: ReadonlySet<string> | undefined, tool: string): boolean {
  return !available || available.has(tool);
}

function baselineRoute(task: string, available?: ReadonlySet<string>): BaselineRoute {
  // Order matters: tier-specific patterns (direct-tool, spawn-worker,
  // spawn-inline) run BEFORE the short-prompt answer-direct fallback
  // so a 3-word "find class Agent" doesn't get demoted to "answer in
  // prose" because it happens to be short.

  // Greeting / social — high-confidence answer-direct.
  if (ANSWER_DIRECT_GREETING.test(task)) {
    return {
      tier: 'answer-direct',
      reason: 'Greeting / social — no tool needed.',
      recommendedTool: null,
      agentId: null,
      confidence: 0.95,
    };
  }

  const words = task.split(/\s+/).filter(Boolean).length;
  const hasAgentVerb =
    NEEDS_INVESTIGATION.test(task) ||
    NEEDS_DESIGN.test(task) ||
    NEEDS_REVIEW.test(task) ||
    NEEDS_VERIFY.test(task);
  const hasImplementVerb = /\b(implement|build|write|edit|fix|refactor|add|update|create|rewrite|migrate)\b/i.test(task);

  // Tier 4 — long-running / spawn-worker. Strong explicit cue, wins
  // over inline when set.
  if (LONG_RUNNING.test(task) && reachable(available, 'spawn_worker_thread')) {
    return {
      tier: 'spawn-worker',
      reason: 'Prompt mentions long-running / background work — a detached worker thread that outlives this turn fits best.',
      recommendedTool: 'spawn_worker_thread',
      agentId: null,
      confidence: 0.75,
    };
  }

  // Tiers 5/6 — workflow and fan-out. Both are vetoed by an explicit "do it
  // yourself / in one turn", which must still demote to a single child or a
  // direct tool. They sit above direct-tool because a prompt carrying real
  // breadth signals is not answered by one `read_file`, and below spawn-worker
  // because detached work is a lifecycle decision, not a breadth one.
  const veto = detectFanOutVeto(task);
  if (!veto.vetoed) {
    const shape = detectWorkflowShape(task);
    if (shape) {
      return {
        tier: 'workflow',
        reason: workflowLaunchRecommendation(shape),
        recommendedTool: null,
        agentId: null,
        confidence: 0.75,
      };
    }
    const intent = detectBreadthIntent(task);
    if (intent.score >= BREADTH_FAN_OUT_THRESHOLD && reachable(available, 'spawn_agents')) {
      return {
        tier: 'fan-out',
        reason:
          `Breadth signals (${intent.signals.join(', ')}; score ${intent.score.toFixed(1)}) — separable targets. ` +
          'Spawn one child per DISTINCT lens in a single `spawn_agents` call plus one adversarial child, then `wait_agents` and synthesize.',
        recommendedTool: 'spawn_agents',
        agentId: inferRoleFromTask(task),
        confidence: 0.8,
      };
    }
  }

  // Tier 2 — direct-tool. A specific file path + read cue, named
  // class/function + grep cue, or a tight shell verb.
  if (FILE_PATH.test(task) && words <= 12) {
    if (SPECIFIC_LINE.test(task) || /\b(read|show me|open|cat)\b/i.test(task)) {
      return {
        tier: 'direct-tool',
        reason: 'Specific file path + line reference — `read_file` is the right call.',
        recommendedTool: 'read_file',
        agentId: null,
        confidence: 0.9,
      };
    }
  }
  if (/^(grep|search for|find)\b/i.test(task) && /\b(class|function|symbol|method)\s+\w+/i.test(task)) {
    return {
      tier: 'direct-tool',
      reason: 'Named class/function or grep verb — `grep_search` answers cleanly.',
      recommendedTool: 'grep_search',
      agentId: null,
      confidence: 0.85,
    };
  }
  if (SHELL_VERBS.test(task) && words <= 6) {
    return {
      tier: 'direct-tool',
      reason: 'Concrete shell verb — `run_command` answers cleanly.',
      recommendedTool: 'run_command',
      agentId: null,
      confidence: 0.8,
    };
  }

  // Tier 3 — spawn-inline. Any agent verb (investigation / design /
  // review / verify) or implementation verb routes to a specialized
  // agent. Reuses `inferRoleFromTask` for the role mapping so role
  // selection stays consistent across route_task + batch spawns.
  if (hasAgentVerb || hasImplementVerb) {
    const role = inferRoleFromTask(task);
    return {
      tier: 'spawn-inline',
      reason: tierInlineRationale(role, task),
      recommendedTool: `delegate_${role}`,
      agentId: role,
      confidence: roleConfidence(role, task),
    };
  }

  // Tier 1 fallback — answer-direct. Reached only when nothing
  // matched: short factual prompts, conversational chitchat, "what
  // is X" with no code referent.
  if (words <= 12 && !FILE_PATH.test(task)) {
    return {
      tier: 'answer-direct',
      reason: 'Short factual prompt with no code referent — answer directly.',
      recommendedTool: null,
      agentId: null,
      confidence: 0.75,
    };
  }

  // Last-resort default — worker delegate. Longer prompts without
  // any clear verb cue land here.
  const role = inferRoleFromTask(task);
  return {
    tier: 'spawn-inline',
    reason: 'No distinctive verb — defaulting to worker for implementation work.',
    recommendedTool: `delegate_${role}`,
    agentId: role,
    confidence: 0.55,
  };
}

/** Phases feeding forward: "X then Y", "X, after that Y", "plan → build → verify". */
const PHASE_CHAIN = /\b(then|after that|after which|afterwards?|followed by|and finally)\b/i;
const ARROW_CHAIN = /\s(→|->|=>)\s/;
const COMPARISON_MARKER = /(\bcompar|\bcompair|\bcontrast\b|\bbenchmark|\bversus\b|\bvs\.?\b)/i;
/** ≥2 comparison targets: "A vs B", "A, B and C". Guards the `compare` template,
 *  which rejects a single target — recommending it there would just error. */
const MULTIPLE_TARGETS = /\b(vs\.?|versus)\b|\b[\w./-]+,\s*[\w./-]+(?:,|\s+and)\s/i;
const IMPLEMENT_VERB = /\b(implement|build|write|edit|fix|refactor|add|update|create|rewrite|migrate|ship)\b/i;

interface WorkflowShape {
  template: 'build' | 'compare' | 'review-wide' | 'research';
  reason: string;
}

function workflowLaunchRecommendation(shape: WorkflowShape): string {
  if (shape.template === 'build') {
    return `${shape.reason} — recommend the explicit CLI \`/build <task>\` launch. This routing result cannot authorize or start a workflow.`;
  }
  return `${shape.reason} — recommend the explicit CLI \`/workflow run ${shape.template} [jsonArgs]\` launch. This routing result cannot authorize or start a workflow.`;
}

/**
 * A dependency chain the runtime can execute deterministically, rather than
 * something the model should hand-orchestrate with spawn/wait/synthesize. The
 * template name goes in the reason so the model knows which `templateArgs` shape
 * to build — naming the tier alone would leave it guessing.
 */
function detectWorkflowShape(task: string): WorkflowShape | null {
  if (COMPARISON_MARKER.test(task) && MULTIPLE_TARGETS.test(task)) {
    return { template: 'compare', reason: 'Multi-target comparison — one analyst per option, then a recommendation' };
  }
  const chained = PHASE_CHAIN.test(task) || ARROW_CHAIN.test(task);
  if (!chained) return null;
  if (IMPLEMENT_VERB.test(task)) {
    return { template: 'build', reason: 'Phase-chained change request — plan → implement → verify → multi-lens review' };
  }
  if (NEEDS_REVIEW.test(task)) {
    return { template: 'review-wide', reason: 'Phase-chained review — review each target in parallel, then merge findings' };
  }
  return { template: 'research', reason: 'Phase-chained question — research each angle in parallel, then synthesize' };
}

function tierInlineRationale(role: string, task: string): string {
  if (role === 'explorer' && NEEDS_INVESTIGATION.test(task)) {
    return 'Investigation verbs ("explore / map / trace / where does") → explorer delegate.';
  }
  if (role === 'architect' && NEEDS_DESIGN.test(task)) {
    return 'Design verbs ("propose / architect / alternatives") → architect delegate.';
  }
  if (role === 'reviewer' && NEEDS_REVIEW.test(task)) {
    return 'Review verbs ("review / critique / evaluate") → reviewer delegate.';
  }
  if (role === 'verifier' && NEEDS_VERIFY.test(task)) {
    return 'Verification verbs ("verify / typecheck / run tests") → verifier delegate.';
  }
  return 'Implementation verbs → worker delegate (default for non-investigative tasks).';
}

function roleConfidence(role: string, task: string): number {
  // Highest when the verb match was distinctive; lower for the
  // "default" worker bucket.
  if (role === 'explorer' && NEEDS_INVESTIGATION.test(task)) return 0.85;
  if (role === 'architect' && NEEDS_DESIGN.test(task)) return 0.85;
  if (role === 'reviewer' && NEEDS_REVIEW.test(task)) return 0.85;
  if (role === 'verifier' && NEEDS_VERIFY.test(task)) return 0.85;
  return 0.65;
}

async function fetchRouteFeedbackEvidence(
  options: RouteTaskOptions,
  task: string,
): Promise<string[]> {
  if (!options.mcpClient) return [];
  try {
    const res = await callMcpTool<{
      recalledCognitiveMemories?: Array<{ recordId?: string; record_id?: string; id?: string; type?: string; content?: string }>;
    }>(options.mcpClient, 'memory_recall', {
      sessionKey: options.sessionKey ?? 'route_task',
      query: `agent_route_feedback ${clipTask(task)}`,
      filters: { types: ['agent_route_feedback'], minPriority: 30 },
    });
    if (res.isError) return [];
    const memories = res.parsed?.recalledCognitiveMemories ?? [];
    return memories
      .map((m) => String(m.recordId ?? m.record_id ?? m.id ?? ''))
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    return [];
  }
}

function clipTask(task: string): string {
  return task.length > 200 ? `${task.slice(0, 197)}…` : task;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
