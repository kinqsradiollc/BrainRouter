/**
 * MAS-P2-M6 + MAS-P6-T1 — delegation-aware memory capture.
 *
 * Every notable orchestration event (a routing decision, a child's
 * output, a verification verdict, a review finding, a cross-vendor
 * delegation) is emitted to the brain as a structured record so future
 * routing / recall can learn from it.
 *
 * Hard rule (MAS-P6-T1): **the CLI never writes cognitive records
 * directly.** Every event rides the public `memory_capture_turn` write
 * path — a synthetic user/assistant pair whose assistant content is the
 * structured JSON and whose `activeSkill` tags the kind. The brain owns
 * extraction; the CLI only emits.
 *
 * The emit path is **best-effort**: errors are swallowed, a missing tool
 * or offline brain is a silent no-op, and a miss never fails the parent
 * turn.
 */

import type { McpClientPool } from '../runtime/mcpPool.js';
import { hasMcpTool } from '../runtime/mcpUtils.js';

export type RouteOutcome = 'success' | 'failure' | 'escalated';

export type AgentEventKind =
  | 'delegation_decision'
  | 'agent_output'
  | 'verification_result'
  | 'review_finding'
  | 'agent_route_feedback';

export interface AgentRouteFeedback {
  task: string;
  chosenAgentId: string;
  parentAgentId?: string;
  ownership?: string | null;
  outcome: RouteOutcome;
  /** Wall-clock duration of the child's run, in ms. */
  durationMs?: number;
  /** Total tokens consumed by the child (prompt + completion). */
  tokenCost?: number;
}

/** A generic, kind-tagged orchestration event. */
export interface AgentEvent {
  kind: AgentEventKind;
  /** Human-readable one-liner (the synthetic user message). */
  summary: string;
  /** Structured fields (the synthetic assistant message, as JSON). */
  payload: Record<string, unknown>;
}

interface EmitContext {
  mcpClient?: McpClientPool;
  sessionKey: string;
  /** Test hook — defaults to dynamic listTools via the mcp client. */
  toolNames?: Set<string>;
}

const TASK_EXCERPT_CHARS = 240;
const PREVIEW_CHARS = 400;

/**
 * Shared best-effort write path. Sends one synthetic turn to
 * `memory_capture_turn`. Returns the record id, or null on any
 * miss/error — never throws.
 */
async function emitViaCapture(
  ctx: EmitContext,
  parts: { userText: string; assistantText: string; activeSkill: string },
): Promise<string | null> {
  if (!ctx.mcpClient) return null;
  try {
    const toolNames = ctx.toolNames ?? (await safeListToolNames(ctx.mcpClient));
    if (!hasMcpTool(toolNames, 'memory_capture_turn')) return null;
    const now = Date.now();
    const res = await ctx.mcpClient.callTool('memory_capture_turn', {
      sessionKey: ctx.sessionKey,
      messages: [
        { role: 'user', content: parts.userText, timestamp: now },
        { role: 'assistant', content: parts.assistantText, timestamp: now },
      ],
      activeSkill: parts.activeSkill,
    });
    if (!res || (res as any).isError) return null;
    return readRecordId(res);
  } catch {
    return null;
  }
}

/**
 * MAS-P2-M6 route-feedback record. Preserved as a dedicated entry point
 * (its payload shape is what `router.ts` queries); delegates to the
 * shared capture path.
 */
export async function emitAgentRouteFeedback(
  ctx: EmitContext,
  payload: AgentRouteFeedback,
): Promise<string | null> {
  const userText =
    `agent_route_feedback | task: "${truncate(payload.task, TASK_EXCERPT_CHARS)}" | ` +
    `chosenAgentId: ${payload.chosenAgentId}` +
    (payload.parentAgentId ? ` | parentAgentId: ${payload.parentAgentId}` : '') +
    (payload.ownership ? ` | ownership: ${payload.ownership}` : '');
  const structured = {
    task: truncate(payload.task, TASK_EXCERPT_CHARS),
    chosenAgentId: payload.chosenAgentId,
    parentAgentId: payload.parentAgentId,
    ownership: payload.ownership ?? null,
    outcome: payload.outcome,
    durationMs: payload.durationMs ?? null,
    tokenCost: payload.tokenCost ?? null,
  };
  return emitViaCapture(ctx, {
    userText,
    assistantText: JSON.stringify(structured),
    activeSkill: 'agent_route_feedback',
  });
}

/**
 * Build the synthetic user/assistant pair for a generic agent event.
 * Pure — unit-tested without a brain.
 */
export function buildAgentEventMessages(
  event: AgentEvent,
): { userText: string; assistantText: string; activeSkill: string } {
  return {
    userText: `${event.kind} | ${event.summary}`,
    assistantText: JSON.stringify({ kind: event.kind, ...event.payload }),
    activeSkill: event.kind,
  };
}

/** Emit a generic kind-tagged event through the shared capture path. */
export async function emitAgentEvent(ctx: EmitContext, event: AgentEvent): Promise<string | null> {
  return emitViaCapture(ctx, buildAgentEventMessages(event));
}

// ── Typed event constructors ──────────────────────────────────────────────

export function delegationDecisionEvent(input: {
  task: string;
  agentKind: string;
  routed: boolean;
  target?: string | null;
}): AgentEvent {
  const task = truncate(input.task, TASK_EXCERPT_CHARS);
  return {
    kind: 'delegation_decision',
    summary: `task: "${task}" → ${input.agentKind} (${input.routed ? `routed to ${input.target ?? '?'}` : 'queued (no idle peer)'})`,
    payload: { task, agentKind: input.agentKind, routed: input.routed, target: input.target ?? null },
  };
}

export function agentOutputEvent(input: {
  agentId: string;
  task: string;
  outcome: RouteOutcome;
  durationMs?: number;
  tokenCost?: number;
  preview?: string;
}): AgentEvent {
  const task = truncate(input.task, TASK_EXCERPT_CHARS);
  return {
    kind: 'agent_output',
    summary: `${input.agentId}: ${input.outcome} on "${task}"`,
    payload: {
      agentId: input.agentId,
      task,
      outcome: input.outcome,
      durationMs: input.durationMs ?? null,
      tokenCost: input.tokenCost ?? null,
      preview: input.preview ? truncate(input.preview, PREVIEW_CHARS) : null,
    },
  };
}

export function verificationResultEvent(input: {
  agentId: string;
  task: string;
  passed: boolean;
  details?: string;
}): AgentEvent {
  const task = truncate(input.task, TASK_EXCERPT_CHARS);
  return {
    kind: 'verification_result',
    summary: `${input.agentId}: ${input.passed ? 'PASS' : 'FAIL'} on "${task}"`,
    payload: {
      agentId: input.agentId,
      task,
      passed: input.passed,
      details: input.details ? truncate(input.details, PREVIEW_CHARS) : null,
    },
  };
}

export function reviewFindingEvent(input: {
  file: string;
  line?: number | null;
  severity: string;
  confidence: number;
  summary: string;
}): AgentEvent {
  return {
    kind: 'review_finding',
    summary: `${input.severity} @ ${input.file}${input.line ? `:${input.line}` : ''} (confidence ${input.confidence})`,
    payload: {
      file: input.file,
      line: input.line ?? null,
      severity: input.severity,
      confidence: input.confidence,
      summary: truncate(input.summary, PREVIEW_CHARS),
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────────────

async function safeListToolNames(mcp: McpClientPool): Promise<Set<string>> {
  try {
    const res = await mcp.listTools();
    const tools = (res as { tools?: Array<{ name: string }> }).tools ?? [];
    return new Set(tools.map((t) => t.name));
  } catch {
    return new Set();
  }
}

function readRecordId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content) || !content[0]?.text) return null;
  try {
    const parsed = JSON.parse(content[0].text);
    const id = parsed?.recordId ?? parsed?.sensoryRecordId ?? parsed?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}
