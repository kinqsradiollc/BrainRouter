/**
 * MAS-P2-M2 + M4 — `route_task`: the direct-first delegation router.
 *
 * Returns a typed recommendation the LLM can act on:
 *
 *   { tier, reason, recommendedTool, agentId?, confidence, memoryEvidence }
 *
 * Four tiers, in escalation order:
 *
 *   - `answer-direct`   — no tool needed; reply in prose.
 *   - `direct-tool`     — one concrete tool (`read_file`, `grep_search`,
 *                          `web_search`, …) answers cleanly.
 *   - `spawn-inline`    — bounded specialized work; pick an agent and
 *                          synthesize the result.
 *   - `spawn-worker`    — long-running / tracked / multi-turn work.
 *                          Worker threads themselves land in 0.4.2;
 *                          the tier is reserved so the policy is
 *                          stable across the cycle.
 *
 * M4 — memory-aware routing: when MCP is online, the router queries
 * `memory_recall` for past `agent_route_feedback` records and boosts
 * confidence + supplies `memoryEvidence: [recordId]` when a recent
 * successful match for a similar prompt is found. When MCP is offline
 * or the record kind doesn't exist yet (the producer ships in M6),
 * the router falls back to the regex baseline with confidence capped
 * at 0.6.
 */

import type { McpClientPool } from '../runtime/mcpPool.js';
import { callMcpTool, hasMcpTool } from '../runtime/mcpUtils.js';
import { inferRoleFromTask } from './tools.js';

export type RouteTier = 'answer-direct' | 'direct-tool' | 'spawn-inline' | 'spawn-worker';

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
}

export async function routeTask(options: RouteTaskOptions): Promise<RouteTaskResult> {
  const task = (options.task ?? '').trim();
  if (!task) {
    throw new Error('route_task requires a non-empty `task` argument.');
  }

  const baseline = baselineRoute(task);
  const mcpOnline = Boolean(
    options.mcpClient && options.mcpToolNames && hasMcpTool(options.mcpToolNames, 'memory_recall'),
  );

  // No memory hop — return baseline with the offline cap on confidence.
  if (!mcpOnline || options.skipMemory) {
    return {
      task: clipTask(task),
      tier: baseline.tier,
      reason: mcpOnline ? baseline.reason : `${baseline.reason} (no memory hop)`,
      recommendedTool: baseline.recommendedTool,
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
      tier: baseline.tier,
      reason: baseline.reason,
      recommendedTool: baseline.recommendedTool,
      agentId: baseline.agentId,
      confidence: baseline.confidence,
      memoryEvidence: [],
    };
  }

  return {
    task: clipTask(task),
    tier: baseline.tier,
    reason: `${baseline.reason} (memory: ${evidence.length} prior route(s) reinforce this choice)`,
    recommendedTool: baseline.recommendedTool,
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

function baselineRoute(task: string): BaselineRoute {
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
  if (LONG_RUNNING.test(task)) {
    return {
      tier: 'spawn-worker',
      reason: 'Prompt mentions long-running / background work — worker thread suits this once 0.4.2 ships them.',
      recommendedTool: 'delegate_agent',
      agentId: null,
      confidence: 0.75,
    };
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
  // agent. Reuses `inferRoleFromTask` for the role mapping so the
  // legacy `route_agent` decisions stay consistent.
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
