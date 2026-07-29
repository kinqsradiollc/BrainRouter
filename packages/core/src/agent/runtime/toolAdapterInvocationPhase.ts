/**
 * Invoke one already-authorized tool through its owning adapter.
 *
 * The caller owns pre-tool hooks and result publication. This phase owns the
 * active-turn orchestration lease, local lifecycle callbacks, MCP identity and
 * skill adaptation, and stable error/denial projection.
 */
import type { Agent, RunTurnCallbacks } from '../agent.js';
import { classifyDenial, formatDenialResult } from '../guards/denialMessage.js';
import { extractToolText } from '../../mcp/mcpUtils.js';
import type { OrchestrationContext } from '../../orchestration/tools.js';
import { executeOrchestrationTool } from '../../orchestration/tools.js';
import {
  createActiveTurnOrchestrationRuntime,
  isOrchestrationRuntimeUnavailableError,
} from '../../orchestration/runtime/activeTurnRuntime.js';
import { readWorkContract } from '../../task/workContractStore.js';
import { applyFederationIdentity } from '../../util/agentloop/federationIdentity.js';
import {
  isChildSynthesisTool,
  resultHasChildOutput,
} from '../../util/agentloop/synthesisGuard.js';
import {
  adaptWorkspaceSkillCatalogText,
  resolveWorkspaceManagedSkill,
} from '../../workspace/skillToolAdapter.js';
import { normalizeToolName } from '../../tool/specs/names.js';
import { suggestSimilarToolName } from '../guards/toolCallRecovery.js';
import {
  getToolSummary,
} from '../support/toolSummary.js';
import { trackChildObservation } from '../support/childObservation.js';
import { explainUnknownToolName } from '../agent.js';

export interface ToolAdapterInvocationResult {
  resultText: string;
  isError: boolean;
  summary: string;
  runtimeUnavailable: boolean;
}

export async function invokeAuthorizedToolAdapter(input: {
  agent: Agent;
  callbacks: RunTurnCallbacks;
  name: string;
  args: any;
  isLocal: boolean;
  delegationLaunch: boolean;
  turnSessionKey: string;
  mcpTool?: any;
  candidateNames: readonly string[];
  loadedRequiredSkills: Set<string>;
  spawnedChildIds: Set<string>;
  waitedChildIds: Set<string>;
  buildOrchestrationContext(): OrchestrationContext;
  refreshActiveSkillTools(): void;
  markChildOutputDelivered(): void;
}): Promise<ToolAdapterInvocationResult> {
  const { agent, callbacks, name, args, isLocal } = input;
  try {
    if (isLocal) return await invokeLocalAdapter(input);
    return await invokeMcpAdapter(input);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    const runtimeUnavailable =
      isOrchestrationRuntimeUnavailableError(error);
    if (runtimeUnavailable) {
      const subject = input.delegationLaunch
        ? 'Delegation'
        : 'Orchestration action';
      return {
        resultText: `${subject} not started: ${message}`,
        isError: true,
        summary:
          `${subject.toLowerCase()} not started — active-turn orchestration ` +
          'lifecycle ended; do not retry',
        runtimeUnavailable,
      };
    }

    if (/-32601|Unknown tool|MethodNotFound/i.test(message)) {
      const hint = explainUnknownToolName(name);
      const similar = suggestSimilarToolName(
        name,
        [...input.candidateNames],
        normalizeToolName,
      );
      return {
        resultText:
          `Tool "${name}" does not exist. ` +
          `${similar ? `did you mean: ${similar}?\n` : ''}${hint}\n` +
          `Underlying error: ${message}`,
        isError: true,
        summary: similar
          ? `unknown tool — did you mean ${similar}?`
          : `unknown tool — ${hint.slice(0, 120)}`,
        runtimeUnavailable,
      };
    }

    const denial = classifyDenial(message);
    if (denial) {
      return {
        resultText: formatDenialResult(name, denial, message),
        isError: true,
        summary: `denied (${denial}) — adjust, do not retry`,
        runtimeUnavailable,
      };
    }
    return {
      resultText: `Tool execution failed: ${message}`,
      isError: true,
      summary: message,
      runtimeUnavailable,
    };
  }
}

async function invokeLocalAdapter(
  input: Parameters<typeof invokeAuthorizedToolAdapter>[0],
): Promise<ToolAdapterInvocationResult> {
  const { agent, callbacks, name, args } = input;
  let lifecycleSummary = '';
  let assertOrchestrationActive: (toolName: string) => void = () => {};
  const runtime = createActiveTurnOrchestrationRuntime({
    ownerSessionKey: input.turnSessionKey,
    currentSessionKey: () => agent.sessionKey,
    signal: agent.turnAbort!.signal,
    invoke: async (toolName, toolArgs, metadata) => {
      if (metadata.workflowLaunch && agent.silent) {
        throw new Error(
          `${toolName}: nested workflows are blocked for spawned/child ` +
          'agents because they run unattended.',
        );
      }
      if (
        metadata.workflowLaunch &&
        !(await agent.confirmRunWorkflowLaunch(toolArgs))
      ) {
        throw new Error(
          `${toolName} declined — the high-cost workflow launch was not approved.`,
        );
      }
      assertOrchestrationActive(toolName);
      const output = await executeOrchestrationTool(
        toolName,
        toolArgs,
        input.buildOrchestrationContext(),
      );
      trackChildObservation(
        toolName,
        toolArgs,
        output,
        input.spawnedChildIds,
        input.waitedChildIds,
      );
      if (
        isChildSynthesisTool(toolName) &&
        resultHasChildOutput(output)
      ) {
        input.markChildOutputDelivered();
      }
      return output;
    },
  });
  assertOrchestrationActive = runtime.assertActive;

  try {
    const resultText = await agent.executeLocalTool(name, args, {
      orchestrationRuntime: runtime.port,
      lifecycleRuntime: {
        afterInvoke: (kind, toolArgs) => {
          if (kind === 'track-automation') {
            let count = 0;
            try {
              count = agent.applyTrackCodeSignalAutomation(
                toolArgs,
                callbacks,
              );
            } catch {
              // Track automation is best-effort.
            }
            if (count > 0) {
              lifecycleSummary =
                ` | automation advanced ${count} Track item${
                  count === 1 ? '' : 's'
                }`;
            }
          } else if (kind === 'goal-reconcile') {
            try {
              agent.autoReconcileGoalCompletion(callbacks);
            } catch {
              // Goal reconciliation is best-effort.
            }
          } else if (kind === 'plan-update') {
            if (Array.isArray(toolArgs.plan) && callbacks.onPlanUpdate) {
              callbacks.onPlanUpdate(
                toolArgs.plan,
                toolArgs.explanation,
              );
            }
            publishSteeringReceipt(agent, callbacks, toolArgs.steeringReceiptId);
          } else if (kind === 'steer-reconcile') {
            publishSteeringReceipt(agent, callbacks, toolArgs.receiptId);
          }
        },
      },
    });
    return {
      resultText,
      isError: false,
      summary: getToolSummary(name, args, resultText) + lifecycleSummary,
      runtimeUnavailable: false,
    };
  } finally {
    runtime.close();
    input.refreshActiveSkillTools();
  }
}

async function invokeMcpAdapter(
  input: Parameters<typeof invokeAuthorizedToolAdapter>[0],
): Promise<ToolAdapterInvocationResult> {
  const { agent, name, args, mcpTool } = input;
  const mcpArgs = applyFederationIdentity(
    name,
    args,
    agent.federationSessionKey,
  ) as Record<string, any>;
  await agent.approveMcpToolCall(name, mcpTool, mcpArgs);
  const rawName = String(
    mcpTool?.__rawName ?? agent.rawMcpToolName(name),
  );
  const serverId =
    typeof mcpTool?.__serverId === 'string'
      ? mcpTool.__serverId
      : agent.serverIdFromMcpToolName(name);
  const status =
    serverId && typeof (agent.mcpClient as any).getStatus === 'function'
      ? (agent.mcpClient as any).getStatus(serverId)
      : undefined;
  const isManagedSkillTool =
    ['list_skills', 'get_skill', 'search_skills'].includes(rawName) &&
    (!serverId || status?.identity === 'brainrouter');
  const localSkillResult =
    isManagedSkillTool &&
      rawName === 'get_skill' &&
      typeof mcpArgs.name === 'string' &&
      mcpArgs.file === undefined
      ? resolveWorkspaceManagedSkill(
        agent.workspaceRoot,
        mcpArgs.name,
        mcpArgs.section ?? 'workflow',
      )
      : undefined;
  const response =
    localSkillResult ??
    await agent.mcpClient.callTool(name, mcpArgs, {
      signal: agent.turnAbort?.signal,
    });
  let resultText = extractToolText(response);
  const isError = Boolean(response.isError);
  if (
    isManagedSkillTool &&
    rawName === 'get_skill' &&
    !isError &&
    typeof mcpArgs.name === 'string' &&
    resultText.trim().length > 0
  ) {
    input.loadedRequiredSkills.add(mcpArgs.name);
  }
  if (
    isManagedSkillTool &&
    (rawName === 'list_skills' || rawName === 'search_skills')
  ) {
    resultText = adaptWorkspaceSkillCatalogText({
      workspaceRoot: agent.workspaceRoot,
      activeCapabilities: agent.activeWorkspaceCapabilities.active,
      text: resultText,
      tool: rawName,
      args: mcpArgs,
    });
  }
  return {
    resultText,
    isError,
    summary: `MCP: ${resultText.length} chars returned`,
    runtimeUnavailable: false,
  };
}

function publishSteeringReceipt(
  agent: Agent,
  callbacks: RunTurnCallbacks,
  receiptValue: unknown,
): void {
  const receiptId =
    typeof receiptValue === 'string' ? receiptValue.trim() : '';
  if (!receiptId) return;
  const receipt = readWorkContract(agent.workspaceRoot, agent.sessionKey)
    ?.steering.find((candidate) => candidate.id === receiptId);
  if (receipt) callbacks.onSteerReceipt?.(receipt);
}
