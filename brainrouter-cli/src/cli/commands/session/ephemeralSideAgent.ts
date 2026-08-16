import { Agent } from '@kinqs/brainrouter-core/agent';

/**
 * Create an isolated runtime for `/side` and `/btw`.
 *
 * The side turn receives a copy of the visible conversation, but owns its own
 * history and provenance. It is silent, cannot run ADR-032 learning, does not
 * recall memory, and never writes a transcript. Workspace/tool side effects
 * still follow the same access mode and approval ports as the parent.
 */
export function createEphemeralSideAgent(parent: Agent, sessionKey: string): Agent {
  const side = new Agent(parent.mcpClient, { ...parent.llmConfig }, {
    workspaceRoot: parent.workspaceRoot,
    launchCwd: parent.launchCwd,
    sessionKey,
    learnedTenant: parent.learnedTenant ? { ...parent.learnedTenant } : undefined,
    learningEnabled: false,
    roleOverlay: parent.roleOverlay,
    workspaceAgentId: parent.workspaceAgentId,
    accessMode: parent.getAccessMode(),
    silent: true,
    enableRecall: false,
    systemPromptOverride: parent.systemPromptOverride,
    taskBudgetCaps: parent.taskBudgetCaps,
    toolScope: parent.toolScope
      ? { local: [...parent.toolScope.local], mcp: [...parent.toolScope.mcp] }
      : undefined,
    authorityToolCeiling: parent.authorityToolCeiling
      ? {
          local: [...parent.authorityToolCeiling.local],
          mcp: [...parent.authorityToolCeiling.mcp],
        }
      : undefined,
    disallowedTools: [...parent.disallowedTools],
    prompter: parent.prompter,
    confirmToolApproval: parent.confirmToolApproval,
    interactionPort: parent.interactionPort,
    computerUsePort: parent.computerUsePort,
    browserControlPort: parent.browserControlPort,
    terminalUsePort: parent.terminalUsePort,
  });

  side.loadHistory(structuredClone(parent.chatHistory));
  side.recordTranscript = () => {};
  return side;
}
