import { Agent } from '../../agent/agent.js';
import fs from 'node:fs';
import { getCliKnobs, loadOrInitConfig } from '../../config/config.js';
import { resolveAgentLlm } from '../../provider/agentModels.js';
import { getSession, updateSession, type ChildSessionRecord } from '../orchestrator.js';
import { buildRolePrompt, resolveRole } from '../roles.js';
import { findById, type Tier } from '../agentRegistry.js';
import { buildSystemPrompt, loadWorkspaceInstructionSummary } from '../../prompt/systemPrompt.js';
import { loadTranscript } from '../../session/transcript/sessionStore.js';
import { childSessionKey } from '../../mcp/mcpUtils.js';
import type { OrchestrationContext } from './context.js';
import { runningChildAgents, runningPromises } from './registry.js';
import { summarize } from './summarize.js';
import { extractChildPreview } from './helpers.js';

export async function handleSendInput(args: any, ctx: OrchestrationContext): Promise<string> {
  const id = String(args.id ?? '').trim();
  const message = String(args.message ?? '').trim();
  if (!id) throw new Error('send_input requires an id.');
  if (!message) throw new Error('send_input requires a non-empty message.');
  return await continueChildAgent({ id, message, interrupt: args.interrupt === true }, ctx);
}

export async function handleResumeAgent(args: any, ctx: OrchestrationContext): Promise<string> {
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
