// runTurn — the agent turn loop, split out of agent.ts (god-file breakdown).
// Byte-identical body; a free function bound to `this: Agent` and assigned onto
// Agent.prototype so all instance state + private helpers resolve exactly as
// before. Imports mirror the symbols the loop referenced inside the class.
import path from 'node:path';
import chalk from 'chalk';
import type { Agent, RunTurnCallbacks } from '../agent.js';
import { getCliKnobs, isRemoteBrainUrl, loadOrInitConfig } from '../../config/config.js';
import { linkArtifact } from '../../artifact/artifactStore.js';
import {
  buildRootContextEnvelope,
} from '../../context/contextEnvelope.js';
import { recordDenial } from '../../exec/runtime/recentDenials.js';
import { readGoal } from '../../goal/store/goalStore.js';
import { buildHookifyContext, evaluateHookify, listHookifyRules } from '../../hooks/hookifyStore.js';
import { runHooks, parseHookDecision, collectStopAdditionalContext } from '../../hooks/hooksStore.js';
import { extractToolText } from '../../mcp/mcpUtils.js';
import { listAll as listAgentDefinitions } from '../../orchestration/agents/agentRegistry.js';
import { executeOrchestrationTool, synthesizeDelegateTools, OrchestrationContext } from '../../orchestration/tools.js';
import {
  createActiveTurnOrchestrationRuntime,
  isOrchestrationRuntimeUnavailableError,
} from '../../orchestration/runtime/activeTurnRuntime.js';
import { compactToolOutput } from '../../prompt/compaction/toolCompaction.js';
import { shouldFallbackModel } from '../../provider/modelFallback.js';
import { resolveLocalModelProfile, localModelProfileActive } from '../../provider/modelFamily.js';
import { enforceTaskBudget } from '../../provider/budget.js';
import { currentTier, detectNeedsHigh, nextTier, resolveTierLadder, stripNeedsHigh } from '../../provider/tierLadder.js';
import { switchModelToolAvailable } from '../../provider/llmProfiles.js';
import { buildModelRegistry, resolveRoutes } from '../../provider/routing/index.js';
import { resolveActiveMode } from '../../session/state/sessionModeStore.js';
import {
  pendingSteeringConstraint,
} from '../../task/steeringReceiptStore.js';
import { evaluateSteeringToolGate } from '../../task/steeringReconciliationGate.js';
import { readWorkContract } from '../../task/workContractStore.js';
import { isInternalSessionKey } from '../../session/transcript/sessionStore.js';
import { readPlan } from '../../task/taskStore.js';
import { startSpan, traceEvent } from '../../telemetry/tracing/tracing.js';
import { localToolSpecsFromExecutors } from '../../tool/registry/executors.js';
import { normalizeToolName } from '../../tool/specs/names.js';
import {
  hideWorkerToolsFor,
  isRegisteredLocalTool,
  registryDelegationLaunchTool,
  registryEntry,
  registryToolAllowed,
} from '../../tool/registry/registry.js';
import { extensionToolOwner } from '../../extension/registry.js';
import { applyToolScope, rankAndCapTools, toolNameMatchesAny } from '../../tool/policy/toolBudget.js';
import { resolveToolVisible } from '../../tool/policy/toolPolicy.js';
import { extractCacheStats } from '../../util/tokens/cacheStats.js';
import { unsynthesizedChildIds, mergePendingChildIds } from '../../util/agentloop/childResume.js';
import { applyFederationIdentity } from '../../util/agentloop/federationIdentity.js';
import { sanitizeModelArtifacts } from '../../util/agentloop/outputSanitize.js';
import { makeResultHandoff, formatHandoffForModel, attachCompactedResultHandoff } from '../../util/result/resultHandoff.js';
import { isChildSynthesisTool, resultHasChildOutput, looksLikeChildSynthesisPunt } from '../../util/agentloop/synthesisGuard.js';
import { classifyDeferral, buildDeliverableCorrection } from '../guards/deliverableCheck.js';
import { classifyDenial, formatDenialResult } from '../guards/denialMessage.js';
import { applyPendingSteeringAtBoundary } from './steering.js';
import { shouldRunFanOutFollowThroughGuard } from '../guards/fanOutFollowThroughGuard.js';
import { NoTTYError } from '../support/prompter.js';
import { analyzeSchema, flattenSchema, nestArguments, type JSONSchema } from '../repair/flatten.js';
import { isSequenceGuardExempt, buildSequenceSignature } from '../guards/repeatGuard.js';
import { shouldNudgeTaskTracking, buildTaskTrackingNudge } from '../guards/taskTrackingNudge.js';
import {
  looksLikeDeferredToolPromise, looksLikeStalledPreamble,
  parseArgumentsOrError, suggestSimilarToolName, synthesizeOrphanResults,
} from '../guards/toolCallRecovery.js';
import { isParallelSafe, parallelExecutionEnabled } from '../guards/toolSafety.js';
import { resolveToolBudget, isBudgetCheckpoint, buildBudgetCheckpoint } from '../guards/turnBudget.js';
import { classifyForVerification, commandWritesFiles, decideVerification, buildVerificationNudge, buildDocsOnlyVerificationNote } from '../guards/verificationGate.js';
import { isTelemetryEnabled } from '../../telemetry/recorder/telemetry.js';
import { recordDailyUsage } from '../../usage/usageHistoryStore.js';
import { shrinkOversizedToolResults } from '../guards/turnEndShrink.js';
import { browserUseAvailableFor } from '../../browser/control.js';
import { getCurrentWorkflow } from '../../workflow/run/workflowArtifacts.js';
import { getToolSummary, getToolPreview } from '../support/toolSummary.js';
import { trackChildObservation, parseChildDrainTimeouts, formatChildDrainTimeoutAnswer, summarizeWaitedChildOutputs } from '../support/childObservation.js';
import { explainUnknownToolName } from '../agent.js';
import { refreshWorkspaceCapabilityState } from '../workspaceCapabilityState.js';
import { resolveActiveTurnOrchestration } from '../../workspace/activeTurnOrchestration.js';
import { resolveRequiredSkillActivation } from '../../workspace/requiredSkillActivation.js';
import {
  adaptWorkspaceSkillCatalogText,
  resolveWorkspaceManagedSkill,
} from '../../workspace/skillToolAdapter.js';
import { loadWorkspaceManifest } from '../../workspace/manifest.js';
import {
  resolveWorkspaceToolSelection,
  workspaceMcpToolAllowed,
  workspaceToolAllowed,
} from '../../workspace/toolProfiles.js';
import {
  buildChatCompletionPayload, buildResponsesPayload, resolveRequestFormat, resolveWireEffort,
  activeProviderDef, callOpenAI, minimalReasoningEffort,
} from '../transport/llmTransport.js';
import { invokeModelPhase } from './modelInvocationPhase.js';
import { normalizeTurnCompletionAnswer } from './completionPhase.js';
import { prepareTurnContextPhase } from './contextPreparationPhase.js';
import { repairAndRecordToolCalls } from './toolCallRepairPhase.js';
import { authorizeToolCall } from './toolAuthorizationPhase.js';
import {
  buildRequiredDelegatedStageCorrection,
  buildRequiredProfileStageCorrection,
  createProfileStageControllerForTurn,
  describeProfileStageTool,
} from './profileStageRuntime.js';

function sameLlmRoute(
  route: { llm: { model: string; endpoint?: string; apiKey?: string } },
  llm: { model: string; endpoint?: string; apiKey?: string },
): boolean {
  return route.llm.model === llm.model
    && (route.llm.endpoint ?? '') === (llm.endpoint ?? '')
    && (route.llm.apiKey ?? '') === (llm.apiKey ?? '');
}

export async function runTurn(this: Agent, prompt: string, callbacks: RunTurnCallbacks, opts?: { hiddenPrompt?: boolean; images?: Array<{ mediaType: string; dataBase64: string }> }): Promise<string> {
    if (!this.initialized) {
      await this.bootstrapSession(callbacks);
    }
    this.lastTurnUsage = { promptTokens: 0, completionTokens: 0, calls: 0, cachedTokens: 0, missedTokens: 0 };
    this.lastTurnToolCalls = 0;
    // CC-hooks parity — drain any additionalContext a prior `stop` /
    // `subagent-stop` hook (or a child's subagent-stop) asked to inject back
    // into the model on THIS turn. Read-and-clear so it fires exactly once.
    if (this.pendingStopContext && this.pendingStopContext.trim()) {
      prompt = `${prompt}\n\n[stop-hook context]\n${this.pendingStopContext.trim()}`;
      this.pendingStopContext = undefined;
    }
    // CC-P6.5 — per-turn verification tracking (mutated workspace? ran a check?).
    this.mutatedThisTurn = false;
    this.verifiedThisTurn = false;
    this.filesWrittenThisTurn = [];
    this.shellWroteThisTurn = false;
    this.computerActionsThisTurn = 0;
    this.triedRouterRoutes.clear();
    this.interruptRequested = false;
    // DESK-6 — fresh abort controller per turn (AFTER the reset), so a stale
    // pre-turn abort can never poison this turn's first LLM call.
    this.turnAbort = new AbortController();
    const turnSessionKey = this.sessionKey;
    // Persist the user's message to the transcript IMMEDIATELY — before recall,
    // the next-action planner, or the main LLM call. Previously this happened
    // only after those server round-trips, so a turn that errored mid-flight
    // (e.g. the 2013 pairing reject) or an app kill lost what the user typed.
    // The model-visible copy is still pushed into chatHistory at its ordered
    // position below (after the goal anchor); only the durable record moves up.
    this.recordTranscript(opts?.hiddenPrompt ? { role: 'user', content: prompt, name: 'goal' } : { role: 'user', content: prompt });
    // Workspace capabilities are task-scoped and additive. Resolve before tool
    // construction so later policy slices can consume the same immutable turn
    // state; this first slice publishes only the tagged prompt contribution.
    refreshWorkspaceCapabilityState(this, prompt);
    const activeTurnOrchestration = resolveActiveTurnOrchestration({
      workspaceRoot: this.workspaceRoot,
      task: prompt,
      activeCapabilitySkillIds: this.activeWorkspaceCapabilities.skills,
      parentDepth: this.agentDepth,
    });
    this.activeTurnOrchestration = activeTurnOrchestration;
    const workspaceManifestForTurn = loadWorkspaceManifest(this.workspaceRoot);
    const goalForSkillActivation = readGoal(this.workspaceRoot, this.sessionKey);
    const requiredSkillActivation = resolveRequiredSkillActivation({
      prompt,
      activeGoal: goalForSkillActivation?.status === 'active',
      manifest: workspaceManifestForTurn,
    });
    const loadedRequiredSkills = new Set([
      ...this.activeSkills,
      ...(this.activeSkill ? [this.activeSkill] : []),
    ]);
    // MAR-4 — snapshot children carried over from the previous turn BEFORE the reset,
    // so a "is it done?" question this turn can resolve those exact ids.
    const carriedPendingChildIds = [...this.lastTurnPendingChildIds];
    this.lastTurnPendingChildIds = []; // C1 — reset; set if a child drain times out this turn
    // HEADLESS-EVENTS — bridge the code-index callback to executeLocalTool.
    this.codeIndexListener = callbacks.onCodeIndex ?? null;
    // 0.4.x-3b — new turn: re-resolve the file-snapshot ordinal on first mutation.
    this.snapshotsThisTurn = null;
    this.lastGoalTransition = undefined;
    // 0.3.9 item 11 — clear the storm window for the new user intent.
    // Old repetition state from the previous turn shouldn't suppress a
    // fresh request that happens to use the same tool with the same args.
    this.toolCallRepair?.resetStorm();
    this.lastRepairReport = null;
    this.tierEscalationsThisTurn = 0;
    // OTEL-style span: one trace per turn, tool calls become child spans.
    // When this Agent was spawned as a child, inherit the parent's traceId
    // + spanId so fan-out runs stitch into one tree across processes (or
    // promises). Top-level REPL agents get a fresh trace per turn.
    const turnSpan = startSpan('brainrouter.turn', {
      session_key: this.sessionKey,
      access_mode: this.accessMode,
      model: this.llmConfig.model,
      role_overlay: this.roleOverlay ? 'set' : 'none',
      agent_id: this.agentId,
      parent_agent_id: this.parentAgentId,
    }, {
      traceId: this.parentTraceId,
      parentSpanId: this.parentSpanId,
    });

    callbacks.onStatusUpdate('Loading available tools...');
    let mcpTools: any[] = [];
    try {
      const toolsRes = await this.mcpClient.listTools();
      mcpTools = toolsRes.tools || [];
    } catch (err: any) {
      // Non-fatal: continue with local tools only
    }
    // 10b: cache the inventory so `createSystemMessage` can render a
    // brain-online vs brain-offline prompt. Refresh chatHistory[0]
    // whenever the inventory shape changed (online → offline or vice
    // versa) so the next LLM call sees the correct system message.
    const prevTools = this.lastKnownMcpTools?.map((t) => t.name).sort().join(',');
    this.lastKnownMcpTools = mcpTools.map((t: any) => ({
      name: String(t?.__rawName ?? this.rawMcpToolName(String(t?.name ?? ''))),
    }));
    const newTools = this.lastKnownMcpTools.map((t) => t.name).sort().join(',');
    if (prevTools !== newTools && this.chatHistory.length > 0 && this.chatHistory[0].role === 'system') {
      this.chatHistory[0] = this.createSystemMessage();
    }

    const profileStageController = createProfileStageControllerForTurn({
      agent: this,
      resolution: activeTurnOrchestration,
      turnSessionKey,
      ...(callbacks.onProfileStageUpdate
        ? { onStateChange: callbacks.onProfileStageUpdate }
        : {}),
    });

    try {
    const allowed = this.allowedToolsForAccess();
    const workspaceToolSelection = resolveWorkspaceToolSelection({
      manifest: workspaceManifestForTurn,
      activeToolProfiles: this.activeWorkspaceCapabilities.toolProfiles,
    });
    const workspaceAllowsLocalTool = (name: string): boolean => {
      const canonicalName = registryEntry(name)?.name ?? name;
      return workspaceToolAllowed(workspaceToolSelection, {
        toolId: canonicalName,
        extensionId: extensionToolOwner(canonicalName)?.extension,
      });
    };
    const workspaceAllowsMcpTool = (tool: any): boolean => {
      const name = String(tool?.name ?? '');
      const rawName = String(tool?.__rawName ?? this.rawMcpToolName(name));
      const serverId = typeof tool?.__serverId === 'string'
        ? tool.__serverId
        : this.serverIdFromMcpToolName(name);
      const status = serverId && typeof (this.mcpClient as any).getStatus === 'function'
        ? (this.mcpClient as any).getStatus(serverId)
        : undefined;
      return workspaceMcpToolAllowed(workspaceToolSelection, {
        toolId: rawName,
        // Pool tools always carry a server identity. Bare tools are retained
        // for single-client compatibility and follow the historical BrainRouter
        // adapter path used by embedded CLI/Desktop tests.
        brainrouterOwned: !serverId || status?.identity === 'brainrouter',
      });
    };
    // Worker-thread tools are registered so the model can call them, but only a
    // depth-0, non-worker orchestrator should SEE them (workers can't spawn
    // workers; a child owns none) — hide the surface from everyone else.
    const hideWorkerTools = hideWorkerToolsFor(this.agentDepth, this.tier);
    const cliKnobs = getCliKnobs();
    const hideComputerUse =
      !cliKnobs.computerUse.enabled ||
      !this.computerUsePort ||
      this.silent ||
      isRemoteBrainUrl(cliKnobs.brainUrl);
    // MC-D3 — switch_model is offered ONLY when the install has 2+ named LLM
    // profiles (cli.llmProfiles): with 0–1 there is nothing to switch between,
    // so the surface stays hidden and default behavior is unchanged.
    const llmProfileNames = Object.keys(cliKnobs.llmProfiles ?? {}).sort();
    const hideSwitchModel = !switchModelToolAvailable(cliKnobs.llmProfiles);
    // §5.4 — when progressive discovery is OFF (default) the discovery entry
    // points stay hidden; when ON they're exposed and the full MCP catalog is
    // collapsed below so the model searches for tools instead of carrying them all.
    const mcpDiscoveryOn = cliKnobs.mcpProgressiveDiscovery;
    // Weak-model detection is retained ONLY for the non-hiding reliability aids
    // (L3 schema flattening below; the L1 loop/storm caps). It no longer clamps
    // the tool surface — the former HONK-L2 allowlist that hid the long tail from
    // local/weak models was removed so every model, weak or strong, sees the full
    // toolset. See the tool filter below.
    const localToolScope = localModelProfileActive(this.llmConfig.model, cliKnobs.localModelProfile);
    // Per-tool user overrides (cli.toolOverrides). Force-on re-enables a tool the
    // L2 allowlist / budget hid; force-off hides a non-protected tool. Hard gates
    // (access tier, capability) are NEVER bypassed by an override.
    const toolOverrides = cliKnobs.toolOverrides;
    const overrideForceOnNames = new Set(Object.keys(toolOverrides).filter((k) => toolOverrides[k] === true));
    const overrideForceOffNames = Object.keys(toolOverrides).filter((k) => toolOverrides[k] === false);
    const activeProfileStageController = (
      profileStageController
      && allowed.has('profile_stage')
      && (!this.toolScope?.local.length || this.toolScope.local.includes('profile_stage'))
      && (!this.authorityToolCeiling || this.authorityToolCeiling.local.includes('profile_stage'))
      && !toolNameMatchesAny('profile_stage', this.disallowedTools)
      && workspaceAllowsLocalTool('profile_stage')
      && toolOverrides.profile_stage !== false
    )
      ? profileStageController
      : undefined;
    activeProfileStageController?.publishResolvedState();
    // CC-SKILLS-D3 — the active skill's `disallowed-tools` frontmatter blacklists
    // apply for THIS turn on top of the role/agent-def `disallowedTools`. Computed
    // here so it filters BOTH local tools (below) and MCP tools (further down).
    const effectiveDisallowed = (): string[] => [
      ...this.disallowedTools,
      ...this.activeSkillDisallowedTools,
    ];
    const toolDisallowed = (name: string): boolean =>
      name !== 'profile_stage' && toolNameMatchesAny(name, effectiveDisallowed());
    // A skill allowlist can only subtract from the surface that every
    // existing access/role/capability/scope gate already permits. `undefined`
    // preserves legacy behavior; a declared empty list intentionally hides all.
    const skillAllowsTool = (name: string): boolean =>
      name === 'profile_stage'
      || this.activeSkillAllowedTools === undefined
      || toolNameMatchesAny(name, this.activeSkillAllowedTools);
    let filteredLocalTools = localToolSpecsFromExecutors({
      resultExpansionAvailable: this.resultCache.size() > 0,
      workflowActive: Boolean(getCurrentWorkflow(this.workspaceRoot, this.sessionKey)),
      activeOrchestrationPlan: activeProfileStageController !== undefined,
      rootAgent: !hideWorkerTools,
      computerUseAvailable: !hideComputerUse,
      browserUseAvailable: browserUseAvailableFor({
        hasPort: !!this.browserControlPort,
        silent: this.silent,
        depth: this.agentDepth,
        tier: this.tier,
        remoteBrain: isRemoteBrainUrl(cliKnobs.brainUrl),
      }),
      sessionInputAvailable:
        !this.silent &&
        this.agentDepth === 0 &&
        this.tier !== 'worker',
      terminalUseAvailable:
        !!this.terminalUsePort &&
        !this.silent &&
        this.agentDepth === 0 &&
        this.tier !== 'worker' &&
        !isRemoteBrainUrl(cliKnobs.brainUrl),
      multiProfile: !hideSwitchModel,
      mcpDiscovery: mcpDiscoveryOn,
    }).filter((t) => {
      const mandatorySteeringControl = t.name === 'reconcile_steer';
      // HARD gates first — a user override can never escalate past these.
      const hardVisible =
        allowed.has(t.name) &&
        (!this.toolScope?.local.length || this.toolScope.local.includes(t.name)) &&
        (!this.authorityToolCeiling || this.authorityToolCeiling.local.includes(t.name)) &&
        (
          mandatorySteeringControl ||
          (
            !toolDisallowed(t.name) &&
            workspaceAllowsLocalTool(t.name) &&
            skillAllowsTool(t.name)
          )
        );
      if (!hardVisible) return false;
      // No model-strength tool clamp: EVERY model — weak or strong — sees the
      // full tool surface. The old HONK-L2 profile hid the long tail from
      // local/weak models; that is removed so a model's strength never disables
      // tools. A user can still force-off a specific tool via cli.toolOverrides,
      // and the non-hiding reliability aids stay (L1 loop/storm caps below; L3
      // schema flattening, which just helps a weak model CALL those same tools).
      return mandatorySteeringControl || resolveToolVisible(t.name, true, toolOverrides);
    });
    // MC-D3 — when switch_model is offered, append the concrete profile names to
    // its description so the model can pick a valid target without guessing.
    // New spec object (like the flatten pass below) so the shared registry
    // schema is never mutated.
    if (!hideSwitchModel) {
      filteredLocalTools = filteredLocalTools.map((t) => t.name === 'switch_model'
        ? { ...t, description: `${t.description} Configured profiles: ${llmProfileNames.join(', ')}.` }
        : t);
    }
    if (activeProfileStageController) {
      filteredLocalTools = filteredLocalTools.map((tool) => tool.name === 'profile_stage'
        ? {
            ...tool,
            description: describeProfileStageTool(
              tool.description,
              activeTurnOrchestration.plan,
            ),
          }
        : tool);
    }
    // HONK-L3 — for local models, flatten deep/wide tool schemas (the dormant,
    // tested repair pass) so they stop dropping nested args; `nestArguments` at
    // dispatch (executeLocalTool) reverses it. Returns NEW spec objects so the
    // shared registry schemas are never mutated. No-op for strong models, and
    // for tools whose schema isn't deep/wide enough to benefit.
    this.flattenedToolNames = new Set<string>();
    if (localToolScope) {
      filteredLocalTools = filteredLocalTools.map((t) => {
        const schema = t.inputSchema as JSONSchema | undefined;
        if (!analyzeSchema(schema).shouldFlatten || !schema) return t;
        this.flattenedToolNames.add(t.name);
        return { ...t, inputSchema: flattenSchema(schema) };
      });
    }
    // Multi-MCP parity: expose every connected third-party MCP tool and the
    // model-safe BrainRouter MCP tools in one turn, using the pool's
    // `mcp_<serverId>_<tool>` namespaces. BrainRouter's auto-pipeline/admin
    // tools stay hidden because the CLI owns those flows.
    let visibleMcpTools = mcpTools.filter((t: any) =>
      this.isModelVisibleMcpTool(t)
      && workspaceAllowsMcpTool(t)
      && skillAllowsTool(String(t?.name ?? '')));
    // MAS-P4-T1: tool-surface budgeting. First apply the agent def's scope
    // (whitelist `toolScope.mcp` + blacklist `disallowedTools`), then cap the
    // catalog to `cli.agentMcpToolBudget`, keeping the tools most relevant to
    // the latest user turn. Trimmed tools are remembered so a model call to
    // one returns a structured "hidden by budget" hint instead of a bare
    // unknown-tool error.
    this.lastBudgetHiddenTools = new Set();
    if (this.toolScope || effectiveDisallowed().length > 0 || overrideForceOffNames.length > 0) {
      visibleMcpTools = applyToolScope(visibleMcpTools, {
        allow: this.toolScope?.mcp,
        // cli.toolOverrides force-off applies to MCP tools by their namespaced name.
        disallow: [...effectiveDisallowed(), ...overrideForceOffNames],
      });
    }
    if (this.authorityToolCeiling) {
      visibleMcpTools = visibleMcpTools.filter((tool: any) =>
        toolNameMatchesAny(String(tool?.name ?? ''), this.authorityToolCeiling!.mcp),
      );
    }
    // Preserve the authorized MCP ceiling before progressive discovery and
    // relevance budgeting hide model-facing schemas. Those are prompt-size
    // controls, not permission changes.
    const authorizedMcpTools = [...visibleMcpTools];
    // Snapshot the user-force-on MCP tools so the discovery/budget step below can't
    // hide them — captured AFTER scope filtering (force-on never overrides force-off
    // or the agent-def allowlist).
    const forceOnMcpTools = visibleMcpTools.filter((t: any) => overrideForceOnNames.has(String(t?.name ?? '')));
    if (mcpDiscoveryOn && visibleMcpTools.length > 0) {
      // Progressive discovery: hide the full catalog; the model reaches it via
      // mcp_search / mcp_describe / mcp_call (which run the same approval gate).
      const collapsed = visibleMcpTools.length;
      visibleMcpTools = [];
      callbacks.onStatusUpdate(`MCP progressive discovery: ${collapsed} catalog tools hidden — use mcp_search / mcp_call.`);
    } else {
      const toolBudget = cliKnobs.agentMcpToolBudget;
      if (toolBudget > 0 && visibleMcpTools.length > toolBudget) {
        const taskText = this.latestUserText();
        const { kept, hidden } = rankAndCapTools(visibleMcpTools, taskText, toolBudget);
        for (const t of hidden) {
          this.lastBudgetHiddenTools.add(String(t?.name ?? ''));
        }
        visibleMcpTools = kept;
        callbacks.onStatusUpdate(`Tool budget: showing ${kept.length}/${kept.length + hidden.length} MCP tools (most task-relevant).`);
      }
    }
    // cli.toolOverrides force-on: re-add any user-enabled MCP tool the
    // progressive-discovery hide or the budget trim removed.
    if (forceOnMcpTools.length > 0) {
      const present = new Set(visibleMcpTools.map((t: any) => String(t?.name ?? '')));
      for (const t of forceOnMcpTools) {
        const n = String(t?.name ?? '');
        if (!present.has(n)) {
          visibleMcpTools.push(t);
          this.lastBudgetHiddenTools.delete(n);
        }
      }
    }
    // MAS-P2-M1: synthesize one `delegate_<agentId>` tool per active
    // agent definition. Rebuilt every turn so a workspace agent JSON
    // edit or pack swap takes effect immediately. The bare
    // `delegate_<id>` tools live next to the legacy `spawn_agent` /
    // `task_agent` / `delegate_agent` so the LLM has a discoverable
    // typed path AND the escape hatch.
    const delegateTools = synthesizeDelegateTools(listAgentDefinitions(this.workspaceRoot)).filter((tool) => {
      const ownerName = registryEntry(tool.name)?.name ?? tool.name;
      return registryToolAllowed(tool.name, this.accessMode)
        && (!this.toolScope?.local.length || this.toolScope.local.includes(tool.name) || this.toolScope.local.includes(ownerName))
        && (!this.authorityToolCeiling
          || this.authorityToolCeiling.local.includes(tool.name)
          || this.authorityToolCeiling.local.includes(ownerName))
        && !toolDisallowed(tool.name)
        && !toolDisallowed(ownerName)
        && workspaceAllowsLocalTool(tool.name)
        && skillAllowsTool(tool.name);
    });
    const baseAllTools = [...filteredLocalTools, ...delegateTools, ...visibleMcpTools];
    let allTools = [...baseAllTools];
    const refreshActiveSkillTools = (): void => {
      allTools = baseAllTools.filter((tool: any) => {
        const name = String(tool?.name ?? '');
        return name === 'profile_stage'
          || (!toolDisallowed(name) && skillAllowsTool(name));
      });
    };
    refreshActiveSkillTools();
    const mcpToolByName = new Map<string, any>();
    for (const tool of mcpTools) {
      const name = String(tool?.name ?? '');
      if (name) mcpToolByName.set(name, tool);
      const rawName = typeof tool?.__rawName === 'string' ? tool.__rawName : '';
      if (rawName) mcpToolByName.set(rawName, tool);
    }
    callbacks.onStatusUpdate(`Loaded ${filteredLocalTools.length} local tools, ${delegateTools.length} delegate tools, and ${mcpTools.length} MCP tools.`);

    const preparedContext = await prepareTurnContextPhase(this, {
      prompt,
      callbacks,
      mcpTools,
      requiredSkillActivation,
      carriedPendingChildIds,
      ...(opts?.images ? { images: opts.images } : {}),
    });
    if (preparedContext.blockedAnswer) return preparedContext.blockedAnswer;
    prompt = preparedContext.prompt;
    const fanOutHinted = preparedContext.fanOutHinted;

    let loopCount = 0;
    // ADAPTIVE TOOL BUDGET — the agent should be allowed to FINISH the task,
    // weak model or strong. `maxToolLoops` is NOT a task limiter, it's a
    // checkpoint WINDOW: when the agent has made a full window of tool calls
    // without a final answer, we inject a self-assessment prompt that forces it
    // to DECIDE whether the user's request is complete and either finish or keep
    // looping (bounded by hardCeiling). The repeat-sequence + storm guards below
    // remain the degenerate-loop safety. Window default 250 / local 150; tune
    // with `cli.maxToolLoops`.
    // HONK-L1/L7 — clamp the window for local/weak model families (a tight
    // bounded harness, not more prompt, is what makes them reliable). Passthrough
    // for strong/unknown models, so this is a no-op for the common case.
    const harnessCaps = resolveLocalModelProfile(this.llmConfig.model, getCliKnobs().localModelProfile, getCliKnobs());
    const { window: budgetWindow, hardCeiling: maxLoops } = resolveToolBudget(harnessCaps.maxToolLoops);
    let budgetCheckpointsFired = 0;
    let finalAnswer = '';
    // Stalled-preamble guardrail counter — see the `looksLikeStalledPreamble`
    // branch below. Bounded so a model that ONLY emits preambles can't keep
    // the loop alive forever. Two extra iterations is enough for the model to
    // either deliver the answer or admit it can't.
    let preambleGuardFired = 0;
    const PREAMBLE_GUARD_MAX = 2;
    // Unfulfilled-tool-promise tracker. When the model says "I'll scan X in
    // parallel" (a deferred-tool-promise) we record the tool-call count at that
    // moment; if the turn later ends with NO new tool calls since the promise —
    // even if the final message is a clarifying QUESTION (which escapes the
    // preamble heuristic) — the model promised work then stalled/over-asked.
    // -1 = no outstanding promise. Shares PREAMBLE_GUARD_MAX's budget.
    let promisedToolsAtCount = -1;
    // Fan-out follow-through guard. When the breadth detector injected a
    // "default to spawn_agents" hint but the turn ends having spawned ZERO
    // children, the model accepted a shallow single-thread answer instead of
    // the parallel fan-out the task wanted. Nudge to actually spawn (or justify
    // skipping). Bounded so it can't loop, and limited to interactive top-level
    // chat turns so internal review/task transcripts don't fill with guard text.
    let fanOutGuardFired = 0;
    const FANOUT_GUARD_MAX = 1;
    // CC-P6.2 — deliverable guardrail. A turn that did real tool work must END
    // on the deliverable, not a trailing question / offer / promise. One
    // bounded nudge, then accept whatever comes next (never loops).
    let deliverableGuardFired = 0;
    const DELIVERABLE_GUARD_MAX = 1;
    // CC-P6.5 — verification gate: once-per-turn nudge when the workspace was
    // mutated but nothing was run to verify it.
    let verificationNudged = false;
    // Plan-sync guardrail. The plan-honesty check otherwise lives ONLY in
    // goal_complete — so a turn that concludes WITHOUT goal_complete (just
    // delivers the answer) never reconciles the plan, leaving it stale (the
    // "audit delivered, plan still ⏳" bug). Snapshot how many items are already
    // completed; if this turn does real work but advances NONE of them while
    // items remain open, nudge ONCE to reconcile. Note we can't gate on "called
    // update_plan" — the model calls it to CREATE the plan (item in_progress)
    // yet never marks anything completed; the completed-count delta is the
    // honest signal. Bounded so a model that won't update can't loop.
    let planSyncGuardFired = 0;
    const PLAN_SYNC_GUARD_MAX = 1;
    let steeringReconciliationGuardFired = 0;
    const STEERING_RECONCILIATION_GUARD_MAX = 1;
    // Requirement → Plan → Track synchronization is deterministic store work,
    // not a prompt. It gets one turn-end pass after the model's plan guard.
    let requirementPlanTrackSyncGuardFired = 0;
    const REQUIREMENT_PLAN_TRACK_SYNC_GUARD_MAX = 1;
    let sprintAutomationGuardFired = 0;
    const SPRINT_AUTOMATION_GUARD_MAX = 1;
    // MAR-3 — child-synthesis guard. `childOutputDeliveredThisTurn` flips true once a
    // child/sub-agent's findings reach the parent this turn; the guard fires once if
    // the model then ends with a deferral instead of synthesizing them.
    let synthesisGuardFired = 0;
    const SYNTHESIS_GUARD_MAX = 1;
    let childOutputDeliveredThisTurn = false;
    let profileStageGuardFired = 0;
    const PROFILE_STAGE_GUARD_MAX = Math.min(
      16,
      Math.max(
        2,
        activeTurnOrchestration.plan.stages
          .reduce((count, stage) => (
            count + (
              stage.executor.kind === 'primary'
                ? stage.skillIds.length * 2
                : stage.optional
                  ? 0
                  : stage.fanOut?.min ?? 1
            )
          ), 0),
      ),
    );
    const planCompletedAtTurnStart = (() => {
      try { return readPlan(this.workspaceRoot, this.sessionKey).items.filter((i) => i.status === 'completed').length; }
      catch { return 0; }
    })();
    // Tracks whether we exited the loop because the LLM stopped requesting
    // tools (clean break) vs because we hit maxLoops. Critical: an empty
    // `finalAnswer === ''` from a clean break is NOT a loop-limit timeout.
    let exitedCleanly = false;
    // Repeat-loop guard: when the model calls the same tool with identical
    // args over and over, the result is by definition the same. Track recent
    // signatures so we can interrupt the loop with corrective feedback.
    const recentToolSignatures: string[] = [];
    const REPEAT_GUARD_LIMIT = Math.max(2, getCliKnobs().repeatLoopLimit);
    // This class of failure is a "doom loop": the same tool
    // pattern repeats even if the arguments keep changing. Keep BrainRouter's
    // threshold higher than a strict identical-input approval guard so
    // normal multi-file exploration still works, but stop 20+ Read(...) spins.
    // Mutation tools (write/edit/apply_patch) are EXEMPT — repeating them with
    // different files is real work, not a loop (the identical-args guard below
    // still catches writing the SAME file over and over).
    const recentToolSequences: string[] = [];
    const TOOL_SEQUENCE_GUARD_LIMIT = Math.max(3, harnessCaps.repeatToolSequenceLimit);
    const sequenceGuardExempt = new Set(getCliKnobs().repeatSequenceExemptTools);
    const spawnedChildIdsThisTurn = new Set<string>();
    const waitedChildIdsThisTurn = new Set<string>();
    const buildOrchestrationContext = (): OrchestrationContext => ({
      workspaceRoot: this.workspaceRoot,
      parentSessionKey: this.sessionKey,
      interruptSignal: this.turnAbort?.signal, // DESK-6 — Stop unblocks child waits
      parentAccessMode: this.accessMode,
      ancestorFleet: this.forceFleetSandbox, // HONK-H0 — cascade fleet lockdown to descendants
      // Thread the parent's trace context so child agents nest their
      // per-turn spans under THIS turn instead of starting a fresh
      // trace tree. Lets observability backends reconstruct fan-out.
      parentTraceId: turnSpan.traceId,
      parentSpanId: turnSpan.spanId,
      parentAgentId: this.agentId,
      parentTier: this.tier,
      depth: this.agentDepth,
      mcpClient: this.mcpClient,
      llmConfig: this.llmConfig,
      launchCwd: this.launchCwd,
      recordOffload: (chars) => { this.memoryMetrics.offloadCharsAvoided += chars; },
      recordChildTokens: (tokens) => { this.memoryMetrics.childTokensSpent += tokens; },
      onChildToolStart: (event) => {
        callbacks.onChildToolStart?.(event);
      },
      onChildToolEnd: (event) => {
        callbacks.onChildToolEnd?.(event);
      },
      onChildComplete: (event) => {
        callbacks.onChildComplete?.(event);
      },
      // MAS-P4-T2 — interactive delegation gate. Only the user-facing
      // (non-silent) parent prompts; silent children leave this unset, so
      // an `ask-*` policy fails closed for them (and the gate only asks at
      // depth 0 anyway). askYesNo throws NoTTYError in headless runs, which
      // we convert to a clear "no terminal" spawn error.
      confirmDelegation: this.silent
        ? undefined
        : async (info) => {
            const q =
              `Delegation policy gate — allow spawning a ${info.role} agent (${info.access})?\n` +
              `  Task: ${info.prompt.slice(0, 160)}${info.prompt.length > 160 ? '…' : ''}`;
            if (this.interactionPort) {
              return await this.interactionPort.confirm({ title: 'Allow agent delegation?', detail: q, tool: 'spawn_agent' });
            }
            try {
              return await this.prompter.askYesNo(q, false);
            } catch (err) {
              if (err instanceof NoTTYError) {
                throw new Error(
                  'Delegation policy requires approval but no interactive terminal is attached. ' +
                    'Set /delegation-policy auto to spawn non-interactively.',
                );
              }
              throw err;
            }
          },
      confirmToolApproval: this.silent
        ? undefined
        : async (info) => {
            const command = info.command ? `\n  Command: ${info.command}` : '';
            const q =
              `Child agent approval gate — allow ${info.role} (${info.childId}) to run ${info.tool}?` +
              command +
              `\n  Reason: ${info.reason}`;
            if (this.interactionPort) {
              return await this.interactionPort.confirm({ title: 'Allow child-agent tool?', detail: q, dangerous: info.dangerous ?? false, tool: info.tool });
            }
            try {
              return await this.prompter.askYesNo(q, false);
            } catch (err) {
              if (err instanceof NoTTYError) {
                throw new Error(
                  'Child tool approval requires an interactive terminal, but none is attached. ' +
                    'Run the command in the parent agent, or pre-approve it with cli.commandAllowlist.',
                );
              }
              throw err;
            }
          },
      // MAS-P2-M3 — surface parent runtime state so handleSpawn can
      // build the typed `ParentExecutionContextSnapshot`. Each accessor
      // reads live state at spawn time; missing data is fine, the
      // snapshot just omits the field.
      parentBriefingBlock: () => this.lastBriefingDetails.blockExcerpt ?? null,
      parentRecalledRecordIds: () => this.getRecalledRecords().map((r) => r.recordId).filter(Boolean),
      parentGoal: () => {
        try {
          const g = readGoal(this.workspaceRoot, this.sessionKey);
          return g ? { text: g.text, status: g.status } : null;
        } catch { return null; }
      },
      parentPlanText: () => {
        try {
          const plan = readPlan(this.workspaceRoot, this.sessionKey);
          if (!plan || plan.items.length === 0) return null;
          const explanation = plan.explanation ? `${plan.explanation}\n` : '';
          const items = plan.items.map((it) => `- [${it.status}] ${it.step}`).join('\n');
          return `${explanation}${items}`;
        } catch { return null; }
      },
      parentContextEnvelope: () => buildRootContextEnvelope(this.chatHistory, {
        executionId: this.sessionKey,
      }),
      parentSourceFiles: () => [...this.filesRead],
      parentVisibleTools: () => allTools.map((tool: any) => String(tool.name)).filter(Boolean),
      parentVisibleLocalTools: () => allTools
        .filter((tool: any) => isRegisteredLocalTool(String(tool.name)))
        .map((tool: any) => String(tool.name))
        .filter(Boolean),
      parentVisibleMcpTools: () => allTools
        .filter((tool: any) => !isRegisteredLocalTool(String(tool.name)))
        .map((tool: any) => String(tool.name))
        .filter(Boolean),
      // Snapshot the parent's ACTIVE SESSION stance at spawn time (session
      // override > workspace pref) so the child records the mode the parent
      // was actually running — not a workspace default a later, unrelated
      // session switch might change.
      parentExecutionMode: resolveActiveMode(this.workspaceRoot, this.sessionKey).executionMode,
      parentReviewPolicy: resolveActiveMode(this.workspaceRoot, this.sessionKey).reviewPolicy,
      profileStageController: activeProfileStageController,
    });

    while (loopCount < maxLoops) {
      loopCount++;
      // INTERRUPT — cooperative stop before the next LLM call. The note lands
      // in history so a resumed conversation knows the turn was cut short.
      if (this.interruptRequested) {
        this.interruptRequested = false;
        const note = '⏹ Turn interrupted by user.';
        const interruptMsg = { role: 'system', content: 'The user interrupted this turn before it finished; the work above may be incomplete.' };
        this.chatHistory.push(interruptMsg);
        this.recordTranscript(interruptMsg);
        callbacks.onStatusUpdate('Interrupted');
        return note;
      }
      // Queue/Steer — user and extension events accepted while the turn was
      // busy become real model input only between complete LLM/tool batches.
      // This preserves the assistant.tool_calls -> tool-result invariant.
      applyPendingSteeringAtBoundary(this, callbacks);
      // ADAPTIVE TOOL BUDGET checkpoint — the agent just completed a full budget
      // window without a final answer. Force it to self-assess (finish or keep
      // looping) instead of silently cutting off. Injected as a user turn so the
      // NEXT LLM call reads it and decides; bounded by MAX_BUDGET_EXTENSIONS.
      if (isBudgetCheckpoint(loopCount, budgetWindow, budgetCheckpointsFired)) {
        budgetCheckpointsFired += 1;
        const used = loopCount - 1;
        const checkpointMsg = { role: 'user', content: buildBudgetCheckpoint(used, maxLoops - used) };
        this.chatHistory.push(checkpointMsg);
        this.recordTranscript({ ...checkpointMsg, name: 'guard' });
        callbacks.onStatusUpdate(`Tool-budget checkpoint at ${used} calls — reassessing whether to continue`);
      }
      callbacks.onStatusUpdate(`Thinking (turn ${loopCount})...`);

      const invocation = await invokeModelPhase(this, callbacks, allTools);
      if (invocation.kind === 'interrupted') return invocation.note;
      const response = invocation.response;
      // 0.3.9 item 13 — model-tier self-escalation. When the response
      // starts with `<<<NEEDS_HIGH>>>` (with or without `:reason`), the
      // model is telling us this task exceeds its current tier. Step
      // the ladder one up, retry the same turn, and surface a yellow
      // warning row. Pro-tier marker is a no-op. Bounded by a per-turn
      // counter so a marker-emitting model can't loop forever.
      const needsHigh = detectNeedsHigh(response.content);
      if (needsHigh && (this.tierEscalationsThisTurn ?? 0) < 2) {
        const routerKnobs = getCliKnobs().router;
        if (routerKnobs.enabled && routerKnobs.aliases['tier:pro']) {
          const config = loadOrInitConfig();
          const baseName = config.providers?.base ? 'base-config' : 'base';
          const registry = buildModelRegistry(
            { ...(config.providers ?? {}), [baseName]: this.llmConfig },
            {
              aliases: routerKnobs.aliases,
              chain: [...routerKnobs.chain, ...getCliKnobs().fallbackModels, `${baseName}/${this.llmConfig.model}`],
              order: routerKnobs.order,
              strategy: routerKnobs.strategy,
              passThrough: routerKnobs.passThrough,
              availableModels: getCliKnobs().availableModels,
              enforceAvailableModels: getCliKnobs().enforceAvailableModels,
            },
          );
          const route = resolveRoutes(registry, 'tier:pro', { withFallbacks: true })[0];
          if (route && !sameLlmRoute(route, this.llmConfig)) {
            this.tierEscalationsThisTurn = (this.tierEscalationsThisTurn ?? 0) + 1;
            const before = `${this.llmConfig.provider}/${this.llmConfig.model}`;
            this.llmConfig = { ...route.llm };
            traceEvent('tier.escalate', {
              from: before,
              to: route.slug,
              provider: route.provider,
              reason: needsHigh.reason ?? null,
              router: true,
            });
            callbacks.onStatusUpdate(
              `⚠️ Tier escalation: ${before} → ${route.slug}${needsHigh.reason ? ` — ${needsHigh.reason}` : ''}`,
            );
            continue;
          }
        }
        // Endpoint-aware (same resolver as effort/auth): a hidden provider
        // reached via a custom endpoint — e.g. DeepSeek as provider:'openai' +
        // endpoint:api.deepseek.com — resolves to its OWN tier ladder instead of
        // OpenAI's, so `<<<NEEDS_HIGH>>>` escalation walks the right models.
        const provider = (activeProviderDef(this.llmConfig)?.id ?? this.llmConfig.provider ?? 'openai').toLowerCase();
        const ladder = resolveTierLadder({ provider });
        const cur = currentTier(this.llmConfig.model, ladder);
        const next = nextTier(cur);
        if (next && ladder.ladder[next] && ladder.ladder[next] !== this.llmConfig.model) {
          this.tierEscalationsThisTurn = (this.tierEscalationsThisTurn ?? 0) + 1;
          const before = this.llmConfig.model;
          this.llmConfig = { ...this.llmConfig, model: ladder.ladder[next] };
          traceEvent('tier.escalate', {
            from: before,
            to: this.llmConfig.model,
            provider,
            reason: needsHigh.reason ?? null,
          });
          callbacks.onStatusUpdate(
            `⚠️ Tier escalation: ${before} → ${this.llmConfig.model}${needsHigh.reason ? ` — ${needsHigh.reason}` : ''}`,
          );
          // Retry the SAME turn on the new tier — skip pushing this
          // half-answer into chatHistory and re-invoke the LLM.
          continue;
        }
      }
      // Strip the marker from the user-visible content regardless of
      // whether we escalated (no-op on top-tier).
      if (needsHigh) {
        response.content = stripNeedsHigh(response.content);
      }

      // Cut-off surfacing — the provider truncated this reply at its output-token
      // cap (`finish_reason: 'length'`) and it's a FINAL prose answer (no tool
      // calls to continue with), so the user is seeing the mid-sentence cut-off.
      // Persist a notice telling them how to lift the cap. (A truncated tool-call
      // response keeps looping, so we don't nag there.)
      if (response.finishReason === 'length' && !(response.toolCalls && response.toolCalls.length) && (response.content?.trim().length ?? 0) > 0) {
        callbacks.onNotice?.({
          level: 'warn',
          message: 'The reply was cut off at the provider’s output-token limit. Raise it by setting `cli.maxOutputTokens` (e.g. 8192) in config.json.',
        });
      }

      if (response.usage) {
        this.lastTurnUsage.promptTokens += response.usage.prompt_tokens ?? 0;
        this.lastTurnUsage.completionTokens += response.usage.completion_tokens ?? 0;
        this.lastTurnUsage.calls += 1;
        // 0.3.9 token-tally rework: track the LATEST authoritative
        // prompt_tokens count so the next turn's auto-compact decision
        // uses what the provider actually charged us, not the legacy
        // `JSON.stringify(history).length / 4` proxy.
        if (typeof response.usage.prompt_tokens === 'number' && response.usage.prompt_tokens > 0) {
          this.lastSeenPromptTokens = response.usage.prompt_tokens;
        }
        // 0.3.9 item 10 — normalise provider cache fields (OpenAI /
        // DeepSeek / Anthropic shapes) into a single counter so the
        // /tokens panel and the usage.jsonl roll-up don't have to
        // re-branch.
        const cache = extractCacheStats(response.usage as any);
        this.lastTurnUsage.cachedTokens += cache.cachedTokens;
        this.lastTurnUsage.missedTokens += cache.missedTokens;
        traceEvent('llm_call.cache_stats', {
          model: this.llmConfig.model,
          cachedTokens: cache.cachedTokens,
          missedTokens: cache.missedTokens,
          cacheHitRatio: cache.cacheHitRatio,
          source: cache.source,
        });
        enforceTaskBudget({
          caps: this.taskBudgetCaps ?? getCliKnobs().budget,
          modelId: this.llmConfig.model,
          usage: {
            promptTokens: this.sessionUsage.promptTokens + this.lastTurnUsage.promptTokens,
            completionTokens: this.sessionUsage.completionTokens + this.lastTurnUsage.completionTokens,
            cachedTokens: this.sessionUsage.cachedTokens + this.lastTurnUsage.cachedTokens,
            missedTokens: this.sessionUsage.missedTokens + this.lastTurnUsage.missedTokens,
          },
        });
        // HEADLESS-EVENTS — running token tally after each LLM call.
        callbacks.onUsageUpdate?.({ ...this.lastTurnUsage });
      }

      promisedToolsAtCount = repairAndRecordToolCalls({
        agent: this,
        callbacks,
        response,
        allTools,
        promisedToolsAtCount,
      });

      if (!response.toolCalls || response.toolCalls.length === 0) {
        // A steer may have arrived while this LLM response was streaming. The
        // assistant message is now durably recorded and has no unpaired tool
        // calls, so this is the earliest safe boundary to continue with it.
        if (applyPendingSteeringAtBoundary(this, callbacks) > 0) continue;
        const pendingSteering = pendingSteeringConstraint(
          this.workspaceRoot,
          this.sessionKey,
        );
        if (
          pendingSteering &&
          steeringReconciliationGuardFired < STEERING_RECONCILIATION_GUARD_MAX
        ) {
          steeringReconciliationGuardFired += 1;
          const instruction = pendingSteering.phase === 'classify'
            ? `Call \`reconcile_steer\` for receipt "${pendingSteering.receiptId}" before continuing or finishing.`
            : `Call \`update_plan\` with steeringReceiptId "${pendingSteering.receiptId}" before related work or finishing.`;
          const guard = {
            role: 'user',
            content: `A steering receipt is still pending. ${instruction}`,
          };
          this.chatHistory.push(guard);
          this.recordTranscript({ ...guard, name: 'guard' });
          callbacks.onStatusUpdate('Pending steer requires typed reconciliation');
          continue;
        }
        const unobservedChildIds = [...spawnedChildIdsThisTurn].filter((id) => !waitedChildIdsThisTurn.has(id));
        // DESK-6 — a Stop skips the auto-drain (it bypasses both interrupt
        // seams); the loop-top check below returns the clean interrupted answer.
        if (unobservedChildIds.length > 0 && !this.interruptRequested) {
          const drainTimeoutMs = Math.max(1, getCliKnobs().childDrainTimeoutMs);
          const waitName = 'wait_agents';
          const waitArgs = { ids: unobservedChildIds, timeoutMs: drainTimeoutMs };

          callbacks.onStatusUpdate(`Auto-draining ${unobservedChildIds.length} spawned child agent${unobservedChildIds.length === 1 ? '' : 's'}...`);
          callbacks.onToolStart(waitName, waitArgs);
          this.lastTurnToolCalls += 1;

          let waitResultText = '';
          let waitFailed = false;
          let waitSummary = '';
          try {
            waitResultText = await executeOrchestrationTool(waitName, waitArgs, buildOrchestrationContext());
            waitSummary = getToolSummary(waitName, waitArgs, waitResultText);
            trackChildObservation(waitName, waitArgs, waitResultText, spawnedChildIdsThisTurn, waitedChildIdsThisTurn);
          } catch (err: any) {
            // Wait tool failure: surface the error text to the model so it can
            // report failure rather than silently synthesizing stale output.
            waitFailed = true;
            waitResultText = `Tool execution failed: ${err?.message ?? String(err)}`;
            waitSummary = err?.message ?? String(err);
          }
          callbacks.onToolEnd(waitName, { success: !waitFailed, summary: waitSummary, preview: !waitFailed ? getToolPreview(waitName, waitArgs, waitResultText) : undefined });

          const timeouts = parseChildDrainTimeouts(waitResultText);
          if (timeouts.length > 0) {
            // C1 — record the timed-out ids so the REPL can poll them and
            // auto-resume once they settle (instead of waiting for a manual /continue).
            this.lastTurnPendingChildIds = timeouts.map((t) => t.id).filter((id) => id && id !== '(unknown)');
            finalAnswer = formatChildDrainTimeoutAnswer(timeouts);
            exitedCleanly = true;
            break;
          }

          const correction = [
            `Runtime child-drain guardrail auto-called \`${waitName}\` because this turn spawned child agents and the model tried to answer without observing them.`,
            `Child wait result:\n${waitResultText}`,
            'Now synthesize the child output for the user. Do not say you are waiting unless the wait result timed out.',
          ].join('\n\n');
          const childResultSystem = summarizeWaitedChildOutputs(waitResultText);
          if (childResultSystem) {
            childOutputDeliveredThisTurn = true; // MAR-3 — drained child output reached the parent
            const systemMsg = { role: 'system', content: childResultSystem };
            this.chatHistory.push(systemMsg);
            this.recordTranscript(systemMsg);
          }
          const guardMsg = { role: 'user', content: correction };
          this.chatHistory.push(guardMsg);
          this.recordTranscript({ ...guardMsg, name: 'guard' });
          continue;
        }

        const failedProfileStage = activeProfileStageController?.failedRequiredStage();
        if (failedProfileStage) {
          finalAnswer =
            `The active profile strategy failed required stage "${failedProfileStage.stageId}"` +
            `${failedProfileStage.roleId ? ` for role "${failedProfileStage.roleId}"` : ''}. ` +
            'Its dependent stages were not unlocked. Review the stage tool result before retrying the task.';
          exitedCleanly = true;
          break;
        }

        const requiredProfileAction = activeProfileStageController?.nextRequiredAction();
        if (requiredProfileAction) {
          if (profileStageGuardFired < PROFILE_STAGE_GUARD_MAX) {
            profileStageGuardFired += 1;
            const correction = buildRequiredProfileStageCorrection(requiredProfileAction);
            const guardMsg = { role: 'user', content: correction };
            this.chatHistory.push(guardMsg);
            this.recordTranscript({ ...guardMsg, name: 'guard' });
            callbacks.onStatusUpdate(
              `Recovery: required profile stage ${requiredProfileAction.stageId}/${requiredProfileAction.skillId} ` +
              `(${profileStageGuardFired}/${PROFILE_STAGE_GUARD_MAX})`,
            );
            continue;
          }
          finalAnswer =
            `The active profile strategy could not finish required stage "${requiredProfileAction.stageId}" ` +
            `because skill "${requiredProfileAction.skillId}" was not ${requiredProfileAction.action === 'begin' ? 'started' : 'completed'} ` +
            `within the bounded runtime guard. No broader tool authority was granted.`;
          exitedCleanly = true;
          break;
        }

        const requiredDelegatedStage = activeProfileStageController?.nextRequiredDelegation();
        if (requiredDelegatedStage) {
          if (profileStageGuardFired < PROFILE_STAGE_GUARD_MAX) {
            profileStageGuardFired += 1;
            const correction = buildRequiredDelegatedStageCorrection(requiredDelegatedStage);
            const guardMsg = { role: 'user', content: correction };
            this.chatHistory.push(guardMsg);
            this.recordTranscript({ ...guardMsg, name: 'guard' });
            callbacks.onStatusUpdate(
              `Recovery: required delegated stage ${requiredDelegatedStage.stageId}/${requiredDelegatedStage.roleId} ` +
              `(${profileStageGuardFired}/${PROFILE_STAGE_GUARD_MAX})`,
            );
            continue;
          }
          finalAnswer =
            `The active profile strategy could not launch required delegated stage ` +
            `"${requiredDelegatedStage.stageId}" with role "${requiredDelegatedStage.roleId}" ` +
            'within the bounded runtime guard. No child was launched outside the compiled plan.';
          exitedCleanly = true;
          break;
        }

        // Empty-answer-after-tools guardrail. The model ran real tool calls this
        // turn but returned a FINAL response with NO tool_calls AND no text — it
        // abandoned the synthesis, so the turn would end on an empty / placeholder
        // answer ("…the model returned no additional commentary"). This is the most
        // common weak/free-model failure (deepseek-*-flash-free, small OS models):
        // they run the tools then go silent. The preamble/deferral guards all miss
        // it because they require NON-empty content. Re-prompt ONCE (bounded by the
        // shared preamble budget) to force the actual answer from the tool results.
        if (
          preambleGuardFired < PREAMBLE_GUARD_MAX &&
          this.lastTurnToolCalls > 0 &&
          !(response.content ?? '').trim()
        ) {
          preambleGuardFired += 1;
          const correction = [
            'Runtime empty-answer guardrail tripped.',
            `You ran ${this.lastTurnToolCalls} tool call(s) this turn, then returned an EMPTY response — no text and no further tool_calls. The user only sees your final prose and tool_calls, so right now they got nothing back.`,
            '',
            'Write your final answer NOW, in THIS response:',
            "- Answer the user's original question using what the tools returned.",
            '- Cite concrete findings (files, line numbers, values) from the tool output.',
            '- If the results were inconclusive, say what you found and what is still unknown.',
            '',
            'Do NOT return empty text again, and do NOT just restate that you ran the tools.',
          ].join('\n');
          const guardMsg = { role: 'user', content: correction };
          this.chatHistory.push(guardMsg);
          this.recordTranscript({ ...guardMsg, name: 'guard' });
          callbacks.onStatusUpdate(`Recovery: empty-answer-after-tools (${preambleGuardFired}/${PREAMBLE_GUARD_MAX}) — forcing synthesis`);
          continue;
        }

        // Stalled-preamble guardrail: when the model emits a short preamble
        // like "I'll start by exploring…" / "Let me check…" but ATTACHES NO
        // tool_calls in the same response, the loop would otherwise break
        // with that preamble as the final answer — leaving the user staring
        // at an announcement of work the model never did. This is the most
        // common Gemma 2B / free-tier OS-model failure mode after we started
        // teaching them to "send a preamble before tool batches"
        // pattern.
        //
        // Fire only when:
        //   1. The turn already had ≥1 real tool call (so we know the model
        //      engaged — this isn't a fresh "I don't have enough info" reply)
        //   2. `looksLikeStalledPreamble(content)` matches the start-of-text
        //      preamble regexes in toolCallRecovery.ts
        //   3. We haven't already injected the guardrail too many times this
        //      turn (PREAMBLE_GUARD_MAX = 2)
        //
        // Inject a corrective user message and continue one more iteration.
        // The model either delivers the substantive answer or, on the next
        // pass, writes a real reply that escapes the preamble heuristic.
        // Fire when it's a stalled preamble AND either (a) the model already
        // called tools this turn then stalled, OR (b) it opened with a
        // confident "I'll run/check/spawn X" promise but emitted ZERO tools
        // (the "narrated intent, never acted" turn — gpt-5.3-codex's
        // "Absolutely — I'll run the full deep sweep now" stall). Without (b)
        // a turn that promises work and does nothing slips straight through.
        if (
          preambleGuardFired < PREAMBLE_GUARD_MAX &&
          looksLikeStalledPreamble(response.content) &&
          (this.lastTurnToolCalls > 0 || looksLikeDeferredToolPromise(response.content))
        ) {
          preambleGuardFired += 1;
          const preview = response.content.trim().slice(0, 140);
          const correction = [
            'Runtime preamble guardrail tripped.',
            `Your last assistant message was a preamble ("${preview}${response.content.trim().length > 140 ? '…' : ''}") but ended with NO tool_calls. The user is still waiting for the actual answer — they cannot see your intent, only your tool_calls and final prose.`,
            '',
            'Do ONE of these now, in THIS response:',
            '1. **Execute the next tool batch you announced** — emit structured tool_calls for the reads/grep/spawn you said you were about to do. The preamble alone does not count.',
            '2. **Write the substantive answer the user originally asked for** — the actual analysis, findings, code references, or conclusions. Not another preamble.',
            '',
            'Do NOT write "I\'ll start by…", "Let me…", or any other preamble again. Either call tools or deliver the answer.',
          ].join('\n');
          const guardMsg = { role: 'user', content: correction };
          this.chatHistory.push(guardMsg);
          this.recordTranscript({ ...guardMsg, name: 'guard' });
          callbacks.onStatusUpdate(`Recovery: preamble-without-action (${preambleGuardFired}/${PREAMBLE_GUARD_MAX}) — forcing continuation`);
          continue;
        }

        // Promise-then-ask guardrail. The model announced tool work earlier this
        // turn (a deferred-tool-promise) but ran NO tools since and is now ending
        // the turn — typically by asking the user a clarifying question it could
        // have answered itself (e.g. "which folders are projectA/projectB?" when a
        // glob would reveal them). The preamble guard misses this because the
        // FINAL message is a question, not a preamble. Fire one bounded nudge
        // that steers toward DISCOVERY over asking. Bounded by the shared
        // PREAMBLE_GUARD_MAX so it can never loop.
        if (
          preambleGuardFired < PREAMBLE_GUARD_MAX &&
          promisedToolsAtCount >= 0 &&
          this.lastTurnToolCalls === promisedToolsAtCount
        ) {
          preambleGuardFired += 1;
          promisedToolsAtCount = -1; // consume the promise so it can't re-fire on the same one
          const correction = [
            'Runtime promise-then-ask guardrail tripped.',
            'Earlier this turn you said you would run tools (scan / read / search / spawn …) but you ran NONE since, and you are now ending the turn — apparently to ask the user instead of acting.',
            '',
            'Before asking the user anything, ask yourself: **can I discover this with a tool?**',
            '- Missing a path, a directory name, which repos match a label, what a file/config contains? → find it now with `list_dir` / `glob_files` / `grep_search` / `read_file`. Do NOT ask the user for something a tool can reveal.',
            '- Genuinely blocked by external info no tool can provide (a credential, a product decision, an ambiguous intent)? → then ask ONE focused question as your only output, and do NOT also claim you are about to act.',
            '',
            'Do the work you promised: emit the tool_calls now, or deliver the substantive answer. Auto-detect sensible defaults and proceed rather than stalling on a question.',
          ].join('\n');
          const guardMsg = { role: 'user', content: correction };
          this.chatHistory.push(guardMsg);
          this.recordTranscript({ ...guardMsg, name: 'guard' });
          callbacks.onStatusUpdate(`Recovery: promised-tools-then-asked (${preambleGuardFired}/${PREAMBLE_GUARD_MAX}) — steering to discovery`);
          continue;
        }

        // Fan-out follow-through guardrail. The breadth detector recommended a
        // parallel `spawn_agents` fan-out for this turn, but the model is ending
        // the turn having spawned NO children — i.e. it delivered a shallow
        // single-thread answer (or "I'll inspect in parallel" then a summary)
        // instead of actually fanning out. Nudge ONCE to spawn for real, or to
        // state explicitly why fan-out doesn't apply. Bounded → never loops.
        if (shouldRunFanOutFollowThroughGuard({
          fanOutHinted,
          guardFired: fanOutGuardFired,
          maxGuardFires: FANOUT_GUARD_MAX,
          spawnedChildCount: spawnedChildIdsThisTurn.size,
          interactiveTopLevel: !this.silent && this.agentDepth === 0,
          internalSession: isInternalSessionKey(this.sessionKey),
        })) {
          fanOutGuardFired += 1;
          const correction = [
            'Runtime fan-out follow-through guardrail tripped.',
            'A fan-out was recommended for this broad/multi-target task, but you are ending the turn having spawned ZERO child agents — that is a shallow single-thread answer, not the parallel coverage the task wanted.',
            '',
            'Do ONE of these now, in THIS response:',
            '1. **Actually fan out** — emit `spawn_agents` with 3–5 children covering distinct angles/targets (one child per comparison target / subsystem), then `wait_agents` and synthesize. Discover targets yourself (`list_dir`, `glob_files`) — do not ask the user for paths you can find.',
            '2. **Justify skipping** — if the task genuinely does not benefit from parallel children (it is small, or the targets are not separable), say so in one sentence and deliver the complete answer.',
            '',
            'Do NOT just promise "I\'ll inspect in parallel" and stop, and do NOT hand back a thin summary while offering to "go deeper if you want" — deliver the deep result now.',
          ].join('\n');
          const guardMsg = { role: 'user', content: correction };
          this.chatHistory.push(guardMsg);
          this.recordTranscript({ ...guardMsg, name: 'guard' });
          callbacks.onStatusUpdate(`Recovery: fan-out-hinted-but-no-spawn (${fanOutGuardFired}/${FANOUT_GUARD_MAX}) — forcing follow-through`);
          continue;
        }

        // CC-P6.2 — deliverable guardrail. The model did real tool work this
        // turn but its FINAL message ends on a deferral (trailing question,
        // "let me know…" offer, or a promise of future work) instead of the
        // deliverable. Nudge once to deliver the result in-message, then
        // accept the next reply regardless. Applies to child agents too —
        // their final message IS their return value, so a deferral ending
        // hands the parent an empty result.
        if (
          deliverableGuardFired < DELIVERABLE_GUARD_MAX &&
          this.lastTurnToolCalls > 0 &&
          // A turn that just completed/blocked the goal is terminal — the model
          // delivered its proof via goal_complete. Don't nudge it to "deliver"
          // again (that produced the spurious post-completion guardrail turns).
          !this.lastGoalTransition &&
          typeof response.content === 'string'
        ) {
          const deferral = classifyDeferral(response.content);
          if (deferral) {
            deliverableGuardFired += 1;
            const preview = response.content.trim().slice(-160).replace(/\s+/g, ' ');
            const guardMsg = { role: 'user', content: buildDeliverableCorrection(deferral, preview) };
            this.chatHistory.push(guardMsg);
            this.recordTranscript({ ...guardMsg, name: 'guard' });
            callbacks.onStatusUpdate(`Recovery: ended-on-${deferral} (${deliverableGuardFired}/${DELIVERABLE_GUARD_MAX}) — forcing the deliverable`);
            continue;
          }
        }

        // CC-P6.5 — verification gate (scoping-hardened). Fires ONLY when this
        // turn actually wrote files and ran no build/test/lint. A read-only turn
        // never reaches here, and a workspace/session switch doesn't run a turn,
        // so neither can trip it. A docs/config-only change isn't asked to run a
        // check — it's asked to SAY no verification was required.
        // Skip entirely on a goal-completing/blocking turn — the goal is done,
        // and demanding a build/test after goal_complete is the false-positive
        // the user saw ("you wrote files this turn" on a read-only turn).
        const verificationDecision = this.lastGoalTransition ? 'none' : decideVerification({
          filesWritten: this.filesWrittenThisTurn,
          shellWroteUnknown: this.shellWroteThisTurn,
          verified: this.verifiedThisTurn,
          alreadyNudged: verificationNudged,
        });
        if (verificationDecision !== 'none') {
          verificationNudged = true;
          const docsOnly = verificationDecision === 'report-docs-only';
          const content = docsOnly
            ? buildDocsOnlyVerificationNote(this.filesWrittenThisTurn)
            : buildVerificationNudge({ local: localModelProfileActive(this.llmConfig.model, getCliKnobs().localModelProfile) });
          const guardMsg = { role: 'user', content };
          this.chatHistory.push(guardMsg);
          this.recordTranscript({ ...guardMsg, name: 'guard' });
          callbacks.onStatusUpdate(docsOnly
            ? 'Recovery: docs/config-only change — asking the agent to state no verification was required'
            : 'Recovery: wrote files but ran no verification — nudging to verify');
          continue;
        }

        // Plan-sync guardrail — see planCompletedAtTurnStart. The model is about
        // to finish (no tool_calls, clean exit) but it did real work this turn
        // yet advanced NO plan item while open items remain. That's the "work
        // done, plan left at ⏳" bug — nudge once to reconcile, then accept the
        // turn regardless (bounded).
        if (planSyncGuardFired < PLAN_SYNC_GUARD_MAX && this.lastTurnToolCalls > 0) {
          let plan: ReturnType<typeof readPlan> | { items: [] };
          try { plan = readPlan(this.workspaceRoot, this.sessionKey); } catch { plan = { items: [] }; }
          const open = plan.items.filter((i) => i.status !== 'completed');
          const completedNow = plan.items.length - open.length;
          if (plan.items.length > 0 && open.length > 0 && completedNow === planCompletedAtTurnStart) {
            planSyncGuardFired += 1;
            const openSummary = open
              .map((i) => `  - [${i.status === 'in_progress' ? '⏳' : '☐'}] ${i.step}`)
              .join('\n');
            const correction = [
              'Runtime plan-sync guardrail tripped.',
              `You did work this turn but advanced no plan item, and the plan still has ${open.length} open item(s):`,
              openSummary,
              '',
              'Before finishing, make the plan honest about what you ACTUALLY did this turn:',
              '- If you completed any of these, call `update_plan` now to mark them `completed` (keep at most one `in_progress`).',
              '- If an item is genuinely still unfinished, leave it as-is and just say so in your answer.',
              'Then deliver your final answer — the user only sees your tool_calls and final prose, not the plan unless you sync it.',
            ].join('\n');
            const guardMsg = { role: 'user', content: correction };
            this.chatHistory.push(guardMsg);
            this.recordTranscript({ ...guardMsg, name: 'guard' });
            callbacks.onStatusUpdate(`Recovery: plan not advanced this turn — nudging to reconcile (${planSyncGuardFired}/${PLAN_SYNC_GUARD_MAX})`);
            continue;
          }
        }

        // Requirement/Track sync guardrail. Runs after the model-facing
        // plan-sync correction so a ready requirement can be materialised into
        // a plan and board without another LLM turn. Bounded and opt-in.
        const automation = getCliKnobs().automation;
        if (
          requirementPlanTrackSyncGuardFired < REQUIREMENT_PLAN_TRACK_SYNC_GUARD_MAX
          && this.lastTurnToolCalls > 0
          && automation.enabled
          && automation.sync.enabled
        ) {
          requirementPlanTrackSyncGuardFired += 1;
          try { this.autoSynchronizeRequirementPlanTrack(callbacks); } catch { /* best-effort — never break the reply */ }
        }

        if (
          sprintAutomationGuardFired < SPRINT_AUTOMATION_GUARD_MAX
          && this.lastTurnToolCalls > 0
          && automation.enabled
          && automation.sprints.enabled
        ) {
          sprintAutomationGuardFired += 1;
          try { this.autoSynchronizeSprints(callbacks); } catch { /* best-effort — never break the reply */ }
        }

        // CC-P9.2 — task-tracking nudge. This turn did substantial multi-step
        // tool work but no plan is being kept. Inject one per-session reminder
        // to use update_plan (distinct from plan-sync, which needs an existing
        // plan). Latched so it never nags.
        if (!this.taskTrackingNudged) {
          let planCount = 0;
          try { planCount = readPlan(this.workspaceRoot, this.sessionKey).items.length; } catch { planCount = 0; }
          if (shouldNudgeTaskTracking({
            toolCallsThisTurn: this.lastTurnToolCalls,
            planItemCount: planCount,
            alreadyNudged: this.taskTrackingNudged,
            silent: this.silent,
          })) {
            this.taskTrackingNudged = true;
            const guardMsg = { role: 'user', content: buildTaskTrackingNudge(this.lastTurnToolCalls) };
            this.chatHistory.push(guardMsg);
            this.recordTranscript({ ...guardMsg, name: 'guard' });
            callbacks.onStatusUpdate('Reminder: multi-step work with no task list — nudging to use update_plan');
            continue;
          }
        }

        // MAR-3 (0.4.13) — child-synthesis guard. Child results were delivered this
        // turn but the model is ending with a deferral ("I'll summarize later" /
        // "still working") instead of synthesizing them. Force ONE synthesis pass.
        // Bounded → never loops.
        if (
          synthesisGuardFired < SYNTHESIS_GUARD_MAX &&
          childOutputDeliveredThisTurn &&
          looksLikeChildSynthesisPunt(response.content ?? '')
        ) {
          synthesisGuardFired += 1;
          const correction = [
            'Runtime child-synthesis guardrail tripped.',
            'A child agent already returned its results to you THIS turn, but your answer defers ("I\'ll summarize later" / "still working") instead of delivering them.',
            'Their output is in the conversation above. Synthesize it into your final answer for the user NOW — do not promise a future summary, and do not spawn or wait on new agents.',
          ].join('\n');
          const guardMsg = { role: 'user', content: correction };
          this.chatHistory.push(guardMsg);
          this.recordTranscript({ ...guardMsg, name: 'guard' });
          callbacks.onStatusUpdate(`Recovery: child results delivered but answer deferred — forcing synthesis (${synthesisGuardFired}/${SYNTHESIS_GUARD_MAX})`);
          continue;
        }

        // MAR-1 (0.4.13) — arm the auto-resume for any child spawned this turn that
        // the model never observed/synthesized (a background spawn the drain step
        // couldn't reach, or a wait that errored), so its result is still delivered
        // without a manual /continue. Additive: drain timeouts already armed above;
        // this only ever ADDS still-unsynthesized ids (deduped).
        const unsynthesized = unsynthesizedChildIds(spawnedChildIdsThisTurn, waitedChildIdsThisTurn);
        if (unsynthesized.length > 0) {
          this.lastTurnPendingChildIds = mergePendingChildIds(this.lastTurnPendingChildIds, unsynthesized);
        }

        // POLISH-2 (0.4.13) — repair the `*#COLON|*` citation garble some weak models
        // emit, so the final answer (display, transcript, memory capture) reads clean.
        finalAnswer = response.content ? sanitizeModelArtifacts(response.content) : response.content;
        exitedCleanly = true;
        break;
      }

      // Execute tool calls chosen by the LLM.
      //
      // 0.3.8-R4 — Independent read-only tool calls (read_file, list_dir,
      // grep_search, glob_files, fetch_url, web_search, MCP memory reads)
      // are dispatched concurrently when emitted in the same assistant
      // response; consecutive serial tools (writes, shell, orchestration,
      // unknown names) execute one-by-one in their original position to
      // preserve causality. Tool-result messages are still appended to
      // chatHistory in the ORIGINAL call order so the model's next turn
      // sees a deterministic trace even if a later read settled first.
      const candidates = [
        ...localToolSpecsFromExecutors().map((tool) => tool.name),
        ...mcpTools.map((t: any) => t.name).filter((n: any) => typeof n === 'string'),
      ];
      const toolCalls: any[] = response.toolCalls ?? [];
      const normalizedNames = toolCalls.map((tc: any) =>
        normalizeToolName(tc.function.name, candidates),
      );
      // ARGUMENT-AWARE signature: a batch only counts as a "repeat" when the
      // model re-issued the SAME tools with the SAME args in the SAME order — a
      // genuine no-progress loop. A read_file → edit_file → run_command sweep
      // over DIFFERENT files yields a different signature each iteration, so
      // methodical multi-file work (read/edit/apply/test) never trips this guard.
      // The per-call identical-(name,args) guard below still catches re-issuing
      // the exact same call, and the mutation-exempt set is a further escape hatch.
      const sequenceSignature = buildSequenceSignature(
        toolCalls.map((tc: any, idx: number) => ({ name: normalizedNames[idx], args: tc.function?.arguments })),
      );
      const previousSequenceRepeats = recentToolSequences.filter((s) => s === sequenceSignature).length;
      recentToolSequences.push(sequenceSignature);
      if (recentToolSequences.length > TOOL_SEQUENCE_GUARD_LIMIT * 2) recentToolSequences.shift();
      if (previousSequenceRepeats >= TOOL_SEQUENCE_GUARD_LIMIT && !isSequenceGuardExempt(normalizedNames, sequenceGuardExempt)) {
        const sequenceLabel = normalizedNames.join(' → ');
        const resultText = [
          `Repeat-loop guard tripped: the identical tool batch (${sequenceLabel}) — same tools AND same arguments — has repeated ${previousSequenceRepeats + 1} times this turn.`,
          'Re-running the same calls returns the same results.',
          'Use the evidence already gathered, change the arguments or strategy, spawn a bounded child, or report what remains unknown.',
        ].join(' ');
        const processed = toolCalls.map((tc: any, idx: number) => ({
          toolMsg: {
            role: 'tool',
            tool_call_id: tc.id,
            name: normalizedNames[idx],
            content: resultText,
            isError: true,
          },
          fullResultText: resultText,
        }));
        for (const name of normalizedNames) {
          callbacks.onToolStart(name, {});
          const delegationLaunch = registryDelegationLaunchTool(name);
          callbacks.onToolEnd(name, {
            success: false,
            summary: `repeat sequence guard tripped (${previousSequenceRepeats + 1}× ${sequenceLabel})`,
            preview: resultText,
            ...(delegationLaunch ? { delegationState: 'not-started' as const } : {}),
          });
          traceEvent('brainrouter.tool', {
            tool: name,
            ok: false,
            local: isRegisteredLocalTool(name),
            session_key: this.sessionKey,
            guard: 'repeat_sequence',
            ...(delegationLaunch ? { delegation_state: 'not_started' } : {}),
          }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
        }
        for (const entry of processed) {
          this.chatHistory.push(entry.toolMsg);
          this.recordTranscript({ ...entry.toolMsg, content: entry.fullResultText });
        }
        continue;
      }
      const parallelEnabled = parallelExecutionEnabled();
      const safeFlags: boolean[] = toolCalls.map(
        (_tc: any, idx: number) => parallelEnabled && isParallelSafe(normalizedNames[idx]),
      );
      // Freeze the steering barrier for this entire assistant tool batch. A
      // model must observe the reconciliation result in a later iteration
      // before any newly-authorized tool can run.
      const steeringConstraintAtBatchStart = pendingSteeringConstraint(
        this.workspaceRoot,
        this.sessionKey,
      );

      const processOneToolCall = async (tc: any, name: string): Promise<{ toolMsg: any; fullResultText: string; systemMsg?: any }> => {
        this.lastTurnToolCalls += 1;
        const delegationLaunch = registryDelegationLaunchTool(name);
        // INTERRUPT — skip queued tools once a stop is requested; the loop-top
        // check then ends the turn before the next LLM call.
        if (this.interruptRequested) {
          const skipped = 'Skipped: turn interrupted by user.';
          callbacks.onToolEnd(name, {
            success: false,
            summary: 'turn interrupted — tool skipped',
            ...(delegationLaunch ? { delegationState: 'not-started' as const } : {}),
          }, tc.id);
          return { toolMsg: { role: 'tool', tool_call_id: tc.id, name, content: skipped, isError: true }, fullResultText: skipped };
        }
        // 0.3.8-I4: Use the strict-recovery helper so a malformed-arguments
        // tool_call surfaces as a structured tool_result (with the raw
        // arguments echoed back) instead of throwing out of the loop.
        const parsedArgs = parseArgumentsOrError(tc);
        let args: any = parsedArgs.args;
        const argParseError: string | undefined = parsedArgs.error;

        const isLocal = isRegisteredLocalTool(name);
        callbacks.onToolStart(name, args, tc.id);

        let resultText = '';
        let isError = false;
        let summary = '';
        let runtimeUnavailable = false;

        // If the LLM emitted malformed JSON for arguments, fail the tool call
        // up-front with a clear error so it can self-correct next turn.
        if (argParseError) {
          isError = true;
          resultText = argParseError;
          summary = 'malformed JSON args';
          callbacks.onToolEnd(name, {
            success: false,
            summary,
            ...(delegationLaunch ? { delegationState: 'not-started' as const } : {}),
          }, tc.id);
          traceEvent('brainrouter.tool', {
            tool: name,
            ok: false,
            local: isLocal,
            session_key: this.sessionKey,
            guard: 'bad_args',
            ...(delegationLaunch ? { delegation_state: 'not_started' } : {}),
          }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
          const toolMsg = { role: 'tool', tool_call_id: tc.id, name, content: resultText, isError };
          return { toolMsg, fullResultText: resultText };
        }

        // A pending Steer is a turn-level control barrier. Enforce it before
        // hooks, verification credit, policy prompts, or any tool adapter runs.
        const steeringGate = evaluateSteeringToolGate(
          steeringConstraintAtBatchStart,
          name,
          args,
        );
        const steeringDenial = steeringGate.allowed ? null : steeringGate.reason!;
        if (steeringDenial) {
          try { recordDenial(this.workspaceRoot, this.sessionKey, name.slice(0, 120), steeringDenial); } catch { /* best-effort */ }
          callbacks.onToolEnd(name, {
            success: false,
            summary: steeringDenial,
            ...(delegationLaunch ? { delegationState: 'not-started' as const } : {}),
          }, tc.id);
          traceEvent('brainrouter.tool', {
            tool: name,
            ok: false,
            local: isLocal,
            session_key: this.sessionKey,
            guard: 'steering_reconciliation',
            ...(delegationLaunch ? { delegation_state: 'not_started' } : {}),
          }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
          const toolMsg = {
            role: 'tool',
            tool_call_id: tc.id,
            name,
            content: steeringDenial,
            isError: true,
          };
          return { toolMsg, fullResultText: steeringDenial };
        }

        // CC-P6.5 — credit mutations and verification only after the steering
        // barrier accepts this call.
        const cmdText = name === 'run_command' ? String(args?.command ?? '') : '';
        const verificationSignal = classifyForVerification(name, cmdText);
        if (verificationSignal === 'mutated') {
          this.mutatedThisTurn = true;
          if (name === 'run_command') {
            if (commandWritesFiles(cmdText)) this.shellWroteThisTurn = true;
          } else {
            const p = typeof args?.path === 'string' ? args.path
              : typeof args?.file === 'string' ? args.file
              : typeof args?.filePath === 'string' ? args.filePath : '';
            if (p) this.filesWrittenThisTurn.push(p);
          }
        } else if (verificationSignal === 'verified') {
          this.verifiedThisTurn = true;
        }

        // Repeat-loop guard: if the model has already issued this exact
        // (name, args) call REPEAT_GUARD_LIMIT times in this turn, short-
        // circuit with corrective feedback instead of executing again.
        const signature = `${name}::${(() => { try { return JSON.stringify(args); } catch { return String(args); } })()}`;
        const repeatCount = recentToolSignatures.filter((s) => s === signature).length;
        if (repeatCount >= REPEAT_GUARD_LIMIT) {
          isError = true;
          resultText = [
            `Repeat-loop guard tripped: \`${name}\` has been called ${repeatCount + 1} times with identical args this turn.`,
            `The result hasn't changed and won't change on another call.`,
            'Pick a different action: read a different file, write the output you have, spawn a worker child, or call `goal_blocked` if no further path remains.',
          ].join(' ');
          summary = `repeat guard tripped (${repeatCount + 1}× ${name})`;
          callbacks.onToolEnd(name, {
            success: false,
            summary,
            ...(delegationLaunch ? { delegationState: 'not-started' as const } : {}),
          }, tc.id);
          traceEvent('brainrouter.tool', {
            tool: name,
            ok: false,
            local: isLocal,
            session_key: this.sessionKey,
            guard: 'repeat',
            ...(delegationLaunch ? { delegation_state: 'not_started' } : {}),
          }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
          const toolMsg = { role: 'tool', tool_call_id: tc.id, name, content: resultText, isError };
          return { toolMsg, fullResultText: resultText };
        }
        recentToolSignatures.push(signature);
        // Keep the window small so the guard only blocks tight loops, not
        // legitimate revisits separated by other tool calls.
        if (recentToolSignatures.length > 12) recentToolSignatures.shift();

        // Lifecycle: pre-tool hook. Non-zero exit (or {decision:deny}) blocks the
        // call — BLOCKING, so it runs for unattended agents too (enforcement).
        let blockedByHook: string | undefined;
        const hookifyWarnings: string[] = [];
        if (this.hookEnforceActive()) {
          // Typed extension pre-tool handlers (in-process) deny identically to a
          // non-zero shell-hook exit; they may inspect the structured args.
          const extDeny = await this.runExtensionHooks('pre-tool', { tool: name, args });
          if (extDeny && !blockedByHook) blockedByHook = extDeny;
          const preResults = runHooks(this.workspaceRoot, 'pre-tool', { tool: name, payload: args });
          const denial = preResults.find((r) => r.exitCode !== 0);
          if (denial) {
            blockedByHook = (denial.stderr || denial.stdout || '').toString().trim() || `Hook ${denial.hook.id} denied tool call (exit ${denial.exitCode})`;
          }
          // CC-P4.2 — structured decision contract: a hook may print JSON
          // ({decision, reason, updatedInput}) instead of using its exit code.
          // deny blocks even on exit 0; updatedInput REPLACES the tool args.
          for (const r of preResults) {
            const d = parseHookDecision(r.stdout);
            if (!d) continue;
            if (d.decision === 'deny' && !blockedByHook) {
              blockedByHook = d.reason?.trim() || `Hook ${r.hook.id} (pre-tool) denied this call`;
            } else if (d.updatedInput && typeof d.updatedInput === 'object') {
              args = d.updatedInput;
              hookifyWarnings.push(`hook ${r.hook.id} rewrote the tool input${d.reason ? ` — ${d.reason}` : ''}`);
            }
          }
          // Hookify markdown rules: warn/block matching by event + pattern.
          const rules = listHookifyRules(this.workspaceRoot);
          if (rules.length > 0) {
            const ctx = buildHookifyContext(name, args);
            const matches = evaluateHookify(rules, ctx);
            for (const m of matches) {
              if (m.action === 'block') {
                blockedByHook = `Hookify rule "${m.rule.name}" blocked this ${ctx.event} operation: ${m.rule.message.slice(0, 240)}`;
                break;
              }
              hookifyWarnings.push(`⚠️ ${m.rule.name}: ${m.rule.message.slice(0, 200)}`);
            }
          }
        }

        try {
          if (blockedByHook) {
            throw new Error(`Blocked by pre-tool hook: ${blockedByHook}`);
          }
          authorizeToolCall({
            agent: this,
            callbacks,
            name,
            args,
            isLocal,
            mcpTool: mcpToolByName.get(name),
            skillAllowsTool,
            workspaceAllowsLocalTool,
            workspaceAllowsMcpTool,
            requiredSkillActivation,
            loadedRequiredSkills,
            trace: { traceId: turnSpan.traceId, spanId: turnSpan.spanId },
          });
          // 0.4.x-4 (`/context`) — count each tool that actually dispatches.
          this.toolCallCounts.set(name, (this.toolCallCounts.get(name) ?? 0) + 1);
          // CC-UX-E3 (`/usage`) — attribute MCP tool dispatch to its server so
          // the breakdown can show per-server call counts. `mcp_<server>_<tool>`
          // → serverId; non-MCP tools return undefined and aren't counted.
          {
            const serverId = this.serverIdFromMcpToolName(name);
            if (serverId) this.mcpServerCallCounts.set(serverId, (this.mcpServerCallCounts.get(serverId) ?? 0) + 1);
          }
          if (isLocal) {
            let lifecycleSummarySuffix = '';
            let assertOrchestrationActive: (toolName: string) => void = () => {};
            const activeOrchestrationRuntime = createActiveTurnOrchestrationRuntime({
              ownerSessionKey: turnSessionKey,
              currentSessionKey: () => this.sessionKey,
              signal: this.turnAbort!.signal,
              invoke: async (toolName, toolArgs, metadata) => {
                  // High-cost workflow launch policy is extension metadata, not
                  // a native-name check in the turn loop.
                  if (metadata.workflowLaunch && this.silent) {
                    throw new Error(`${toolName}: nested workflows are blocked for spawned/child agents because they run unattended.`);
                  }
                  if (metadata.workflowLaunch && !(await this.confirmRunWorkflowLaunch(toolArgs))) {
                    throw new Error(`${toolName} declined — the high-cost workflow launch was not approved.`);
                  }
                  // Approval is asynchronous; the user may interrupt or switch
                  // sessions while the prompt is open. Re-check the same owner
                  // immediately before any work is accepted.
                  assertOrchestrationActive(toolName);
                  const output = await executeOrchestrationTool(toolName, toolArgs, buildOrchestrationContext());
                  trackChildObservation(toolName, toolArgs, output, spawnedChildIdsThisTurn, waitedChildIdsThisTurn);
                  if (isChildSynthesisTool(toolName) && resultHasChildOutput(output)) childOutputDeliveredThisTurn = true;
                  return output;
              },
            });
            assertOrchestrationActive = activeOrchestrationRuntime.assertActive;
            try {
              resultText = await this.executeLocalTool(name, args, {
                orchestrationRuntime: activeOrchestrationRuntime.port,
                lifecycleRuntime: {
                  afterInvoke: (kind, toolArgs) => {
                    if (kind === 'track-automation') {
                      let automationCount = 0;
                      try { automationCount = this.applyTrackCodeSignalAutomation(toolArgs, callbacks); } catch { /* best-effort */ }
                      if (automationCount > 0) lifecycleSummarySuffix = ` | automation advanced ${automationCount} Track item${automationCount === 1 ? '' : 's'}`;
                    } else if (kind === 'goal-reconcile') {
                      try { this.autoReconcileGoalCompletion(callbacks); } catch { /* best-effort */ }
                    } else if (kind === 'plan-update') {
                      if (Array.isArray(toolArgs.plan) && callbacks.onPlanUpdate) {
                        callbacks.onPlanUpdate(toolArgs.plan, toolArgs.explanation);
                      }
                      const receiptId = typeof toolArgs.steeringReceiptId === 'string'
                        ? toolArgs.steeringReceiptId.trim()
                        : '';
                      const receipt = receiptId
                        ? readWorkContract(this.workspaceRoot, this.sessionKey)
                          ?.steering.find((candidate) => candidate.id === receiptId)
                        : undefined;
                      if (receipt) callbacks.onSteerReceipt?.(receipt);
                    } else if (kind === 'steer-reconcile') {
                      const receiptId = String(toolArgs.receiptId ?? '');
                      const receipt = readWorkContract(this.workspaceRoot, this.sessionKey)
                        ?.steering.find((candidate) => candidate.id === receiptId);
                      if (receipt) callbacks.onSteerReceipt?.(receipt);
                    }
                  },
                },
              });
            } finally {
              // A required extension may invoke the port only while its own
              // active tool call is on the stack. Captured/deferred calls fail
              // terminally instead of replaying after the owning turn.
              activeOrchestrationRuntime.close();
              // profile_stage can activate or finish a skill inside this same
              // model turn. Rebuild the request-facing subset immediately so
              // the next iteration sees the stage policy instead of the
              // broader tool list captured at turn start.
              refreshActiveSkillTools();
            }
            summary = getToolSummary(name, args, resultText) + lifecycleSummarySuffix;
          } else if (this.lastBudgetHiddenTools.has(name)) {
            // MAS-P4-T1: the model called an MCP tool that was trimmed from
            // this turn's inventory by the tool budget. It's real and
            // available — return a structured hint so the next turn can
            // proceed (the tool re-enters the inventory when the task text
            // makes it relevant, or raise cli.agentMcpToolBudget).
            isError = true;
            resultText = JSON.stringify({
              ok: false,
              error: `Tool "${name}" is available but was hidden this turn by the MCP tool budget (cli.agentMcpToolBudget). It will reappear when it's relevant to the task, or raise the budget.`,
              suggested: Array.from(this.lastBudgetHiddenTools).slice(0, 8),
            });
            summary = `tool "${name}" hidden by budget`;
          } else {
            // Federation tools need THIS agent's federation identity, not
            // the chat sessionKey the LLM sees in its prompt. Rewrite the
            // identity fields at the boundary so "check my inbox" reads the
            // key the poller/registry actually used (otherwise the read
            // misses the federation-key inbox and comes back empty).
            const mcpArgs = applyFederationIdentity(name, args, this.federationSessionKey) as Record<string, any>;
            const mcpTool = mcpToolByName.get(name);
            await this.approveMcpToolCall(name, mcpTool, mcpArgs);
            const rawMcpName = String(mcpTool?.__rawName ?? this.rawMcpToolName(name));
            const mcpServerId = typeof mcpTool?.__serverId === 'string'
              ? mcpTool.__serverId
              : this.serverIdFromMcpToolName(name);
            const mcpStatus = mcpServerId && typeof (this.mcpClient as any).getStatus === 'function'
              ? (this.mcpClient as any).getStatus(mcpServerId)
              : undefined;
            const isBrainrouterSkillTool = ['list_skills', 'get_skill', 'search_skills'].includes(rawMcpName)
              && (!mcpServerId || mcpStatus?.identity === 'brainrouter');
            const localSkillResult = isBrainrouterSkillTool
              && rawMcpName === 'get_skill'
              && typeof mcpArgs.name === 'string'
              && mcpArgs.file === undefined
              ? resolveWorkspaceManagedSkill(this.workspaceRoot, mcpArgs.name, mcpArgs.section ?? 'workflow')
              : undefined;
            const mcpRes = localSkillResult
              ?? await this.mcpClient.callTool(name, mcpArgs, { signal: this.turnAbort?.signal });
            if (mcpRes.isError) {
              isError = true;
            }
            resultText = extractToolText(mcpRes);
            if (
              isBrainrouterSkillTool &&
              rawMcpName === 'get_skill' &&
              !isError &&
              typeof mcpArgs.name === 'string' &&
              resultText.trim().length > 0
            ) {
              loadedRequiredSkills.add(mcpArgs.name);
            }
            if (isBrainrouterSkillTool && (rawMcpName === 'list_skills' || rawMcpName === 'search_skills')) {
              resultText = adaptWorkspaceSkillCatalogText({
                workspaceRoot: this.workspaceRoot,
                activeCapabilities: this.activeWorkspaceCapabilities.active,
                text: resultText,
                tool: rawMcpName,
                args: mcpArgs,
              });
            }
            summary = `MCP: ${resultText.length} chars returned`;
          }
        } catch (err: any) {
          isError = true;
          const message = err?.message ?? String(err);
          runtimeUnavailable = isOrchestrationRuntimeUnavailableError(err);
          // -32601 is JSON-RPC's MethodNotFound. We hit it most often when
          // the LLM hallucinates a tool name — typically a skill name
          // ("incremental-implementation", "spec-driven", "...-skill") that
          // it has confused for an invocable tool. Surface a correction so
          // the next iteration self-corrects instead of retrying garbage.
          const denial = classifyDenial(message);
          if (runtimeUnavailable) {
            const subject = delegationLaunch ? 'Delegation' : 'Orchestration action';
            resultText = `${subject} not started: ${message}`;
            summary = `${subject.toLowerCase()} not started — active-turn orchestration lifecycle ended; do not retry`;
          } else if (/-32601|Unknown tool|MethodNotFound/i.test(message)) {
            const hint = explainUnknownToolName(name);
            // 0.3.8-I4: surface a "did you mean: X?" suggestion when the
            // LLM-emitted name normalises to a real registered tool (case,
            // separator, or alias mismatch). This is cheaper for the model
            // to recover from than the generic skill-vs-tool explanation.
            const didYouMean = suggestSimilarToolName(name, candidates, normalizeToolName);
            const suggestionLine = didYouMean ? `did you mean: ${didYouMean}?\n` : '';
            resultText = `Tool "${name}" does not exist. ${suggestionLine}${hint}\nUnderlying error: ${message}`;
            summary = didYouMean ? `unknown tool — did you mean ${didYouMean}?` : `unknown tool — ${hint.slice(0, 120)}`;
          } else if (denial) {
            // CC-P6.8 — a DENIAL (user declined / hook / policy / access mode)
            // is a decision, not a transient failure. Tell the model to adjust
            // its approach, not retry the identical call.
            resultText = formatDenialResult(name, denial, message);
            summary = `denied (${denial}) — adjust, do not retry`;
          } else {
            resultText = `Tool execution failed: ${message}`;
            summary = message;
          }
        }
        if (isError) {
          this.recentToolFailure = `${name}: ${summary || resultText.slice(0, 160)}`;
        }

        const finalSummary = hookifyWarnings.length > 0 ? `${summary} | ${hookifyWarnings.join(' | ')}` : summary;
        // Inspection tools (list_dir, grep_search, glob_files) commonly fail to
        // surface anything when the LLM gets lazy and replies with a stub like
        // "I have listed the directory" instead of echoing the contents. Compute
        // a short preview from the raw result so the REPL can show the user
        // SOMETHING even when the model declines to.
        //
        // For ERROR cases, surface the failure text as the preview too —
        // previously `preview: undefined` meant the user just saw
        // `Read(.) · 0ms` with no indication WHY the tool failed (e.g. "EISDIR:
        // illegal operation on a directory"). Truncate to 400 chars so a
        // stack trace doesn't blow up the scrollback.
        const preview = !isError
          ? getToolPreview(name, args, resultText)
          : (resultText
              ? `${resultText.length > 400 ? resultText.slice(0, 400) + '…' : resultText}`
              : (summary || undefined));
        const delegationState = delegationLaunch
          ? (isError ? 'not-started' : 'accepted')
          : undefined;
        callbacks.onToolEnd(name, {
          success: !isError,
          summary: finalSummary,
          preview,
          ...(delegationState ? { delegationState } : {}),
        }, tc.id);
        const toolTrace: Record<string, unknown> = {
          tool: name,
          ok: !isError,
          local: isLocal,
          session_key: this.sessionKey,
        };
        if (delegationLaunch) {
          toolTrace.delegation_state = delegationState === 'not-started' ? 'not_started' : 'accepted';
          if (runtimeUnavailable) toolTrace.lifecycle_reason = 'runtime_unavailable';
        }
        traceEvent('brainrouter.tool', toolTrace, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
        if (this.hookAdvisoryActive()) {
          const postResults = runHooks(this.workspaceRoot, 'post-tool', {
            tool: name,
            payload: { args, ok: !isError, summary, resultPreview: resultText.slice(0, 1000) },
          });
          // A post-tool hook may REPLACE the model-visible result text and/or
          // mark it an error (redact secrets, fail on a lint/policy breach).
          // Applied before the result is clamped + handed to the LLM below.
          for (const r of postResults) {
            const d = parseHookDecision(r.stdout);
            if (!d) continue;
            if (typeof d.updatedOutput === 'string') resultText = d.updatedOutput;
            if (d.isError === true) isError = true;
          }
          void this.runExtensionHooks('post-tool', { tool: name, args });
        }

        // Tool-result clamp: huge MCP payloads (memory_recall, spawn_agent
        // outputs, big greps, file dumps) used to be re-sent to the LLM
        // verbatim every subsequent turn, which blew the context window in
        // long sessions. Clamp at ~8 KB per result for the LLM-visible copy
        // while keeping the full text on disk via recordTranscript.
        const compaction = compactToolOutput({ toolName: name, args, output: resultText });
        if (compaction.omittedChars > 0) {
          this.memoryMetrics.compactedToolCharsAvoided += compaction.omittedChars;
        }
        const llmVisibleResult = compaction.requiresResultHandoff
          ? attachCompactedResultHandoff(this.resultCache, resultText, compaction.inlineText, { label: name }).content
          : compaction.inlineText;
        const MAX_TOOL_RESULT_CHARS = getCliKnobs().maxToolResultChars;
        let clampedContent = llmVisibleResult;
        if (llmVisibleResult.length > MAX_TOOL_RESULT_CHARS) {
          // MAS-P5-T2: progressive result handoff. Rather than hard-
          // truncating (and losing the tail), park the full result in the
          // session cache and show the model a preview + resultRef it can
          // expand on demand via extract_result. Full text still lands in
          // the transcript via recordTranscript below.
          const { handoff, full } = makeResultHandoff(llmVisibleResult, { previewChars: MAX_TOOL_RESULT_CHARS });
          this.resultCache.put(handoff.resultRef, full);
          this.memoryMetrics.compactedToolCharsAvoided += Math.max(0, full.length - handoff.preview.length);
          clampedContent = formatHandoffForModel(handoff, { label: name });
        }
        const toolMsg = {
          role: 'tool',
          tool_call_id: tc.id,
          name: name,
          content: clampedContent,
          isError
        };
        const childResultSystem = (name === 'wait_agent' || name === 'wait_agents')
          ? summarizeWaitedChildOutputs(resultText)
          : undefined;
        const systemMsg = childResultSystem ? { role: 'system', content: childResultSystem } : undefined;
        // Return; the caller pushes to chatHistory in original call order
        // (NOT settle order) and records the FULL untruncated result for
        // /transcript. Doing the push here would let parallel batches land
        // in finish order, which the LLM's next turn would see as a
        // non-deterministic trace.
        return { toolMsg, fullResultText: resultText, systemMsg };
      };

      // Partition the tool_calls into runs of consecutive parallel-safe
      // calls separated by single serial calls. Each run preserves original
      // position; safe runs of size ≥ 2 dispatch with Promise.allSettled,
      // serial runs (and unknown-tool fallbacks) execute one-by-one. The
      // result array is indexed by original call position so the
      // chatHistory push at the end is deterministic.
      const processed: Array<{ toolMsg: any; fullResultText: string; systemMsg?: any } | undefined> =
        new Array(toolCalls.length);

      const runSafeBatch = async (startIdx: number, endIdx: number): Promise<void> => {
        // [startIdx, endIdx) — at least 1 entry; size > 1 means concurrent.
        // Calling `processOneToolCall` synchronously schedules every batch
        // member's onToolStart + repeat-guard prep BEFORE any await yields,
        // so the user sees N "in flight" tool rows immediately. Promise.
        // allSettled then waits for all to settle; any rejection is
        // translated into a "Tool execution failed" envelope so the LLM's
        // next turn still sees a tool_result for every original tool_call_id.
        const slice = toolCalls.slice(startIdx, endIdx);
        const promises = slice.map((tc: any, j: number) =>
          processOneToolCall(tc, normalizedNames[startIdx + j]),
        );
        const settled = await Promise.allSettled(promises);
        for (let k = 0; k < settled.length; k++) {
          const s = settled[k];
          if (s.status === 'fulfilled') {
            processed[startIdx + k] = s.value;
          } else {
            const tc = slice[k];
            const name = normalizedNames[startIdx + k];
            const message = s.reason?.message ?? String(s.reason);
            const resultText = `Tool execution failed: ${message}`;
            processed[startIdx + k] = {
              toolMsg: { role: 'tool', tool_call_id: tc.id, name, content: resultText, isError: true },
              fullResultText: resultText,
            };
          }
        }
      };

      let i = 0;
      while (i < toolCalls.length) {
        if (safeFlags[i]) {
          let j = i + 1;
          while (j < toolCalls.length && safeFlags[j]) j++;
          await runSafeBatch(i, j);
          i = j;
        } else {
          // Serial slot — run in isolation so any state mutation (write,
          // spawn_agent, update_plan) completes before the next call starts.
          processed[i] = await processOneToolCall(toolCalls[i], normalizedNames[i]);
          i++;
        }
        // DESK-6 — a Stop landed while a tool was running (Bundle A/B already
        // killed the in-flight one): don't dispatch the rest. Every remaining
        // tool_call STILL needs a tool_result or the next provider call 400s on
        // an unmatched tool_call — fill them with the interrupted-skip envelope
        // (same shape as the per-tool skip at the top of processOneToolCall).
        if (this.interruptRequested) {
          for (let k = i; k < toolCalls.length; k++) {
            if (processed[k]) continue;
            const tc = toolCalls[k];
            const name = normalizedNames[k];
            const delegationLaunch = registryDelegationLaunchTool(name);
            callbacks.onToolEnd(name, {
              success: false,
              summary: 'turn interrupted — tool skipped',
              ...(delegationLaunch ? { delegationState: 'not-started' as const } : {}),
            }, tc.id);
            processed[k] = {
              toolMsg: { role: 'tool', tool_call_id: tc.id, name, content: 'Skipped: turn interrupted by user.', isError: true },
              fullResultText: 'Skipped: turn interrupted by user.',
            };
          }
          break;
        }
      }

      const postToolSystemMessages: any[] = [];
      for (const entry of processed) {
        if (!entry) continue;
        this.chatHistory.push(entry.toolMsg);
        // Record the FULL untruncated result so /transcript shows everything,
        // even when the LLM-facing copy was clamped.
        this.recordTranscript({ ...entry.toolMsg, content: entry.fullResultText });
        if (entry.systemMsg) {
          postToolSystemMessages.push(entry.systemMsg);
        }
      }
      for (const systemMsg of postToolSystemMessages) {
        this.chatHistory.push(systemMsg);
        this.recordTranscript(systemMsg);
      }

      // 0.3.8-I4: orphan safety net. Even after dedupe + the per-call
      // recovery branches above, a tool_call without a paired tool_result
      // would 400 the next OpenAI request. Synthesize ERROR envelopes for
      // any unmatched id so strict tool_call ↔ tool_result pairing is
      // preserved. Synthetic content is a plain `ERROR: …` string so the
      // R1 child-drain guardrail's parseJsonObject(resultText) returns
      // undefined and we don't accidentally claim a child was spawned.
      // Synthetics do NOT bump lastTurnToolCalls — they aren't real
      // dispatches, just a well-formed-history fix.
      const producedResults = processed.filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.toolMsg);
      const orphans = synthesizeOrphanResults(toolCalls, producedResults);
      for (const synthetic of orphans) {
        this.chatHistory.push(synthetic);
        this.recordTranscript(synthetic);
        callbacks.onStatusUpdate(`Recovery: synthesized placeholder for orphan tool_call ${synthetic.tool_call_id}.`);
      }
    }

    // Normalize the final answer FIRST so every exit path (loop limit, empty
    // commentary after tool calls, normal) feeds the same non-empty string
    // into both lastAnswer and captureTurn. Previously this happened AFTER
    // captureTurn, which meant memory capture + citation feedback silently
    // skipped every turn that hit the loop limit or returned no prose.
    const normalizedCompletion = normalizeTurnCompletionAnswer({
      answer: finalAnswer,
      exitedCleanly,
      maxLoops,
      goalTransition: this.lastGoalTransition,
      toolCallCount: this.lastTurnToolCalls,
      workspaceRoot: this.workspaceRoot,
      sessionKey: this.sessionKey,
    });
    finalAnswer = normalizedCompletion.answer;
    this.lastTurnHitLoopLimit = normalizedCompletion.hitLoopLimit;
    this.lastAnswer = finalAnswer;

    await this.captureTurn(prompt, finalAnswer, callbacks);
    if (this.hookAdvisoryActive()) {
      runHooks(this.workspaceRoot, 'post-turn', {
        payload: { prompt, answerPreview: finalAnswer.slice(0, 1000), tokens: this.lastTurnUsage },
      });
    }
    // CC-hooks parity — the `stop` (top-level) / `subagent-stop` (silent worker)
    // event, and the completion notification. These fire on the `hookNotifyActive`
    // gate (enabled + not safe-mode) so they ALSO run for unattended/background
    // workers — the whole point of `subagent-stop` + `agent_completed` is to tap
    // into silent runs. A `stop` hook may return {"additionalContext":"…"}; we
    // STORE it on `pendingStopContext` for injection into the model on the next
    // turn (top-level) or for the parent to read after a child's drain.
    if (this.hookNotifyActive()) {
      try {
        const stopEvent = this.silent ? 'subagent-stop' : 'stop';
        const stopResults = runHooks(this.workspaceRoot, stopEvent, {
          payload: { prompt, answerPreview: finalAnswer.slice(0, 1000), tokens: this.lastTurnUsage },
        });
        const extra = collectStopAdditionalContext(stopResults);
        if (extra) {
          this.pendingStopContext = this.pendingStopContext
            ? `${this.pendingStopContext}\n${extra}`
            : extra;
        }
      } catch { /* stop hooks are advisory — never break the turn */ }
      // Completion notification, so a user can wire a desktop/OS notifier
      // (`terminal-notifier`, `osascript`, a webhook curl).
      try {
        runHooks(this.workspaceRoot, 'notification-agent-completed', {
          payload: { sessionKey: this.sessionKey, silent: this.silent, answerPreview: finalAnswer.slice(0, 200) },
        });
      } catch { /* advisory */ }
    }
    turnSpan.end({
      outcome: exitedCleanly ? 'ok' : 'loop_limit',
      loops_used: loopCount,
      tokens_in: this.lastTurnUsage.promptTokens,
      tokens_out: this.lastTurnUsage.completionTokens,
      orchestration_profile_id: activeTurnOrchestration.plan.orchestrationProfileId,
      orchestration_strategy_id: activeTurnOrchestration.plan.strategyId,
      orchestration_selection_source: activeTurnOrchestration.plan.selectionSource,
      orchestration_stage_count: activeTurnOrchestration.plan.stages.length,
      orchestration_signal_ids: activeTurnOrchestration.taskSignalIds.join(','),
      orchestration_source: activeTurnOrchestration.source,
    });
    // Accumulate session usage + (below) run the turn-end tool-result shrink on
    // EVERY exit path, the loop-limit path included. A `return finalAnswer`
    // used to sit here and skip all of it for loop-limit turns — which both
    // undercounted session token totals for the MOST expensive turns (the ones
    // that ran to the limit) AND left their oversized tool results uncompacted,
    // bloating the next `/continue`. Callers detect the loop-limit branch via
    // `lastTurnHitLoopLimit` (set above) + the answer string, not this return,
    // so falling through to the shared tail is contract-safe.
    this.sessionUsage.promptTokens += this.lastTurnUsage.promptTokens;
    this.sessionUsage.completionTokens += this.lastTurnUsage.completionTokens;
    this.sessionUsage.calls += this.lastTurnUsage.calls;
    this.sessionUsage.turns += 1;
    // 0.3.9 item 10 — roll cache stats into session totals.
    this.sessionUsage.cachedTokens += this.lastTurnUsage.cachedTokens;
    this.sessionUsage.missedTokens += this.lastTurnUsage.missedTokens;
    // 0.4.x-4 (`/context`) — bucket this turn's usage by the skill in effect.
    {
      const skillKey = this.activeSkill ?? 'chat';
      const b = this.usageBySkill.get(skillKey) ?? { promptTokens: 0, completionTokens: 0, turns: 0, calls: 0 };
      b.promptTokens += this.lastTurnUsage.promptTokens;
      b.completionTokens += this.lastTurnUsage.completionTokens;
      b.calls += this.lastTurnUsage.calls;
      b.turns += 1;
      this.usageBySkill.set(skillKey, b);
    }
    // WS10 — record this turn into the persistent cross-session usage history
    // (TOP-LEVEL agent only, so children don't double-count; survives session
    // delete). Gated on the local telemetry toggle; best-effort, never fatal.
    if (!this.silent && isTelemetryEnabled()) {
      try {
        recordDailyUsage(
          {
            promptTokens: this.lastTurnUsage.promptTokens,
            completionTokens: this.lastTurnUsage.completionTokens,
            calls: this.lastTurnUsage.calls,
            cachedTokens: this.lastTurnUsage.cachedTokens,
            missedTokens: this.lastTurnUsage.missedTokens,
          },
          Date.now(),
        );
      } catch { /* observability only */ }
    }

    // 0.3.9 item 12 — turn-end tool-result auto-shrink. Any `role: tool`
    // message whose content exceeds TURN_END_RESULT_CAP_TOKENS gets
    // replaced with the compacted version on the way out of the turn.
    // Full raw outputs remain in the transcript layer.
    const shrinkResult = shrinkOversizedToolResults(this.chatHistory, { resultCache: this.resultCache });
    if (shrinkResult.shrunkCount > 0) {
      this.memoryMetrics.compactedToolCharsAvoided += shrinkResult.charsSaved;
      traceEvent('turn_end.shrink', {
        shrunkCount: shrinkResult.shrunkCount,
        charsSaved: shrinkResult.charsSaved,
        tokensSaved: shrinkResult.tokensSaved,
      });
    }
    return finalAnswer;
    } finally {
      profileStageController?.terminate(
        this.sessionKey !== turnSessionKey
          ? 'session-changed'
          : this.turnAbort?.signal.aborted || this.interruptRequested
            ? 'turn-interrupted'
            : 'turn-ended',
      );
    }
}
