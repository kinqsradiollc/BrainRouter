/**
 * MAS-P2-M6 — `agent_route_feedback` emitter.
 *
 * Closes the loop M4's memory-aware router opened: every time a
 * child finishes, we emit one structured record describing the
 * routing decision + outcome. Future routes can then bias toward
 * agents that have succeeded on similar prompts.
 *
 * The emit path is **best-effort** by design:
 *
 *   - Calls `memory_capture_turn` (the only public write path the
 *     brain exposes today) with a synthetic user/assistant pair that
 *     carries the structured payload.
 *   - Errors are swallowed; routing-feedback misses don't fail the
 *     parent turn. A flaky MCP just means M4's memory hop gets less
 *     evidence on the next call.
 *   - The legacy generic role names (`spawn_agent`/`task_agent` with
 *     `role: "explorer"`) DO emit — they're still "routing decisions",
 *     just without a custom agentId.
 *
 * The structured payload uses the field names the orchestrator
 * specifies: `task`, `chosenAgentId`, `parentAgentId`, `ownership?`,
 * `outcome`, `durationMs`, `tokenCost`. Future spec/3.x extensions
 * (e.g. `delegation_decision`) ride the same module.
 *
 * The brain-side extractor doesn't yet recognise `agent_route_feedback`
 * as a typed cognitive-record kind, so the records land on the
 * sensory log first. Once the extractor learns the kind they'll
 * surface in `memory_recall({ filters: { types: ["agent_route_feedback"] } })`
 * — exactly what `router.ts` queries. The router's graceful-no-records
 * fallback keeps the system working until then.
 */

import type { McpClientPool } from '../runtime/mcpPool.js';
import { hasMcpTool } from '../runtime/mcpUtils.js';

export type RouteOutcome = 'success' | 'failure' | 'escalated';

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

interface EmitContext {
  mcpClient?: McpClientPool;
  sessionKey: string;
  /** Test hook — defaults to dynamic listTools via the mcp client. */
  toolNames?: Set<string>;
}

const TASK_EXCERPT_CHARS = 240;

/**
 * Fire the route-feedback record. Returns the record id on success,
 * `null` when the brain isn't reachable, missing the tool, or
 * declined to write — never throws.
 */
export async function emitAgentRouteFeedback(
  ctx: EmitContext,
  payload: AgentRouteFeedback,
): Promise<string | null> {
  if (!ctx.mcpClient) return null;
  try {
    const toolNames = ctx.toolNames ?? (await safeListToolNames(ctx.mcpClient));
    if (!hasMcpTool(toolNames, 'memory_capture_turn')) return null;

    const now = Date.now();
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
    const assistantText = JSON.stringify(structured);

    const res = await ctx.mcpClient.callTool('memory_capture_turn', {
      sessionKey: ctx.sessionKey,
      messages: [
        { role: 'user', content: userText, timestamp: now },
        { role: 'assistant', content: assistantText, timestamp: now },
      ],
      // Hint for the brain-side extractor (when it gains awareness of
      // the kind) — until then the field is silently ignored, which is
      // the desired graceful-degradation shape.
      activeSkill: 'agent_route_feedback',
    });
    if (!res || (res as any).isError) return null;
    return readRecordId(res);
  } catch {
    return null;
  }
}

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
