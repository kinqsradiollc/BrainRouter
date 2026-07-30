/**
 * Repair and record one model response before tool dispatch.
 *
 * This phase preserves the assistant tool-call/result pairing invariant:
 * duplicate ids are removed, recoverable calls are normalized, storm-dropped
 * calls receive synthetic error results, and the exact assistant/result order
 * is recorded before any tool is dispatched.
 */
import type { Agent, RunTurnCallbacks } from '../agent.js';
import {
  dedupeToolCalls,
  looksLikeDeferredToolPromise,
  mentionsImminentToolWork,
} from '../guards/toolCallRecovery.js';
import { ToolCallRepair } from '../repair/index.js';
import { sanitizeToolCallsForHistory } from '../agent.js';
import { traceEvent } from '../../telemetry/tracing/tracing.js';

export interface RepairToolCallResponse {
  content?: string | null;
  toolCalls?: any[];
}

export function repairAndRecordToolCalls(input: {
  agent: Agent;
  callbacks: RunTurnCallbacks;
  response: RepairToolCallResponse;
  allTools: any[];
  promisedToolsAtCount: number;
}): number {
  const { agent, callbacks, response } = input;

  if (response.toolCalls && response.toolCalls.length > 0) {
    response.toolCalls = dedupeToolCalls(response.toolCalls, (id) => {
      callbacks.onStatusUpdate(
        `Recovery: dropped duplicate tool_call id "${id}" (last occurrence wins).`,
      );
    });
  }

  const allowedToolNames = new Set<string>(
    input.allTools.map((tool) => tool.name).filter(Boolean),
  );
  if (!agent.toolCallRepair) {
    agent.toolCallRepair = new ToolCallRepair({
      allowedToolNames,
      isMutating: (call) => {
        const name = call.function?.name ?? '';
        return name === 'write_file' ||
          name === 'edit_file' ||
          name === 'apply_patch' ||
          name === 'run_command';
      },
      isStormExempt: (call) => {
        const name = call.function?.name ?? '';
        return name === 'list_jobs' ||
          name === 'get_status' ||
          name === 'list_agents' ||
          name === 'wait_agent' ||
          name === 'wait_agents';
      },
    });
  }

  const repairInput = response.toolCalls ?? [];
  const repaired = agent.toolCallRepair.process(
    repairInput.map((call) => ({
      id: call.id,
      type: call.type,
      function: call.function,
    })),
    null,
    typeof response.content === 'string' ? response.content : null,
  );
  agent.lastRepairReport = repaired.report;
  recordRepairTotals(agent, repaired.report);
  reportRepairs(callbacks, repaired.report);

  const survivingIds = new Set<string>();
  for (const call of repaired.calls) {
    if (call.id) survivingIds.add(call.id);
  }
  const syntheticResults = suppressedToolResults(
    repairInput,
    survivingIds,
    callbacks,
  );
  response.toolCalls =
    repaired.calls.length > 0 ? repaired.calls as any[] : undefined;

  const assistantMessage: any = {
    role: 'assistant',
    content: response.content,
  };
  if (response.toolCalls) {
    assistantMessage.tool_calls =
      sanitizeToolCallsForHistory(response.toolCalls);
  }
  agent.chatHistory.push(assistantMessage);
  agent.recordTranscript(assistantMessage);

  for (const result of syntheticResults) {
    agent.chatHistory.push(result);
    agent.recordTranscript(result);
  }

  if (
    (!response.toolCalls || response.toolCalls.length === 0) &&
    (
      looksLikeDeferredToolPromise(response.content) ||
      mentionsImminentToolWork(response.content)
    )
  ) {
    return agent.lastTurnToolCalls;
  }
  if (response.toolCalls && response.toolCalls.length > 0) return -1;
  return input.promisedToolsAtCount;
}

function recordRepairTotals(
  agent: Agent,
  report: {
    scavenged: number;
    truncationsFixed: number;
    truncationsUnrecoverable: number;
    stormsBroken: number;
    notes: string[];
  },
): void {
  const touched =
    report.scavenged > 0 ||
    report.truncationsFixed > 0 ||
    report.truncationsUnrecoverable > 0 ||
    report.stormsBroken > 0;
  if (!touched) return;
  agent.repairTotals.scavenged += report.scavenged;
  agent.repairTotals.truncationsFixed += report.truncationsFixed;
  agent.repairTotals.truncationsUnrecoverable +=
    report.truncationsUnrecoverable;
  agent.repairTotals.stormsBroken += report.stormsBroken;
  agent.repairTotals.turnsWithRepair += 1;
}

function reportRepairs(
  callbacks: RunTurnCallbacks,
  report: {
    scavenged: number;
    truncationsFixed: number;
    truncationsUnrecoverable: number;
    stormsBroken: number;
    notes: string[];
  },
): void {
  if (
    report.scavenged === 0 &&
    report.truncationsFixed === 0 &&
    report.stormsBroken === 0
  ) {
    return;
  }
  traceEvent('tool_call.repair', {
    scavenged: report.scavenged,
    truncationsFixed: report.truncationsFixed,
    truncationsUnrecoverable: report.truncationsUnrecoverable,
    stormsBroken: report.stormsBroken,
    notes: report.notes,
  });
  if (report.scavenged > 0) {
    callbacks.onStatusUpdate(
      `Repair: scavenged ${report.scavenged} tool call${
        report.scavenged === 1 ? '' : 's'
      } from response content.`,
    );
  }
}

function suppressedToolResults(
  originalCalls: any[],
  survivingIds: ReadonlySet<string>,
  callbacks: RunTurnCallbacks,
): any[] {
  const results: any[] = [];
  for (const original of originalCalls) {
    if (original.id && survivingIds.has(original.id)) continue;
    const name = original.function?.name ?? 'unknown';
    const summary = `repeat guard tripped (storm pipeline ${name})`;
    callbacks.onToolStart?.(name, {});
    callbacks.onToolEnd?.(name, { success: false, summary });
    results.push({
      role: 'tool',
      tool_call_id: original.id,
      name,
      content:
        `ERROR: ${summary}. The same (name, args) pair fired more times than ` +
        'the pipeline-level storm guard allows. Pick a different action or ' +
        'call goal_blocked if no further path remains.',
      isError: true,
    });
  }
  return results;
}
