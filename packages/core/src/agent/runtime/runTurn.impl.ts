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
import { selectEngine, describeRunningEngine } from './engineSelection.js';
import { readGoal } from '../../goal/store/goalStore.js';
import { buildHookifyContext, evaluateHookify, listHookifyRules } from '../../hooks/hookifyStore.js';
import { runHooks, parseHookDecision } from '../../hooks/hooksStore.js';
import { listAll as listAgentDefinitions } from '../../orchestration/agents/agentRegistry.js';
import { synthesizeDelegateTools, OrchestrationContext } from '../../orchestration/tools.js';
import {
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
import { makeResultHandoff, formatHandoffForModel, attachCompactedResultHandoff } from '../../util/result/resultHandoff.js';
import { classifyDenial, formatDenialResult } from '../guards/denialMessage.js';
import { NoTTYError } from '../support/prompter.js';
import { analyzeSchema, flattenSchema, nestArguments, type JSONSchema } from '../repair/flatten.js';
import { isSequenceGuardExempt, buildSequenceSignature } from '../guards/repeatGuard.js';
import {
  parseArgumentsOrError, suggestSimilarToolName,
} from '../guards/toolCallRecovery.js';
import { isParallelSafe, parallelExecutionEnabled } from '../guards/toolSafety.js';
import { resolveToolBudget } from '../guards/turnBudget.js';
import { classifyForVerification, commandWritesFiles } from '../guards/verificationGate.js';
import { browserUseAvailableFor } from '../../browser/control.js';
import { getCurrentWorkflow } from '../../workflow/run/workflowArtifacts.js';
import { getToolPreview } from '../support/toolSummary.js';
import { summarizeWaitedChildOutputs } from '../support/childObservation.js';
import { explainUnknownToolName } from '../agent.js';
import { refreshWorkspaceCapabilityState } from '../workspaceCapabilityState.js';
import { resolveActiveTurnOrchestration } from '../../workspace/activeTurnOrchestration.js';
import { resolveRequiredSkillActivation } from '../../workspace/requiredSkillActivation.js';
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
import { prepareTurnContextPhase } from './contextPreparationPhase.js';
import { repairAndRecordToolCalls } from './toolCallRepairPhase.js';
import { authorizeToolCall } from './toolAuthorizationPhase.js';
import { invokeAuthorizedToolAdapter } from './toolAdapterInvocationPhase.js';
import { preflightRequiredSkills } from './requiredSkillPreflight.js';
import {
  executeToolBatch,
  publishToolBatch,
  repairOrphanToolResults,
} from './toolBatchExecutionPhase.js';
import { frameToolResultForModel } from './toolResultTrustBoundary.js';
import {
  finalizeTurnPhase,
  resolveTurnTerminationReason,
} from './turnFinalizationPhase.js';
import { TurnLifecycleCoordinator } from './turnLifecycleCoordinator.js';
import {
  createProfileStageControllerForTurn,
  describeProfileStageTool,
} from './profileStageRuntime.js';
import { runChildProfileGuardPhase } from './childProfileGuardPhase.js';

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
    const planForSkillActivation = readPlan(this.workspaceRoot, this.sessionKey);
    const activePlanPhase = planForSkillActivation.phases?.find((phase) =>
      phase.status === 'in_progress');
    const requiredSkillActivation = resolveRequiredSkillActivation({
      prompt,
      activeGoal: goalForSkillActivation?.status === 'active',
      manifest: workspaceManifestForTurn,
      phaseRequiredSkillIds: activePlanPhase?.requiredSkillIds,
    });
    const initiallyLoadedRequiredSkills = new Set([
      ...this.activeSkills,
      ...(this.activeSkill ? [this.activeSkill] : []),
    ]);
    const requiredSkillPreflight = await preflightRequiredSkills({
      workspaceRoot: this.workspaceRoot,
      mcpClient: this.mcpClient,
      signal: this.turnAbort.signal,
      activation: requiredSkillActivation,
      alreadyLoadedSkillIds: initiallyLoadedRequiredSkills,
      callbacks,
    });
    const loadedRequiredSkills = requiredSkillPreflight.loadedSkillIds;
    // ADR-027 D3 — warn once per skill per turn, not per mutating call.
    const warnedRequiredSkills = new Set<string>();
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
    // ADR-028 C1 — the execution-engine knob is READ here. It was resolved and
    // validated for two releases while nothing consumed it, so a person could
    // flip the setting and watch it do nothing. Requesting an engine that is
    // missing features the loop has falls back and says so, rather than
    // silently removing interrupts or tool authorization from the turn.
    const engineSelection = selectEngine(cliKnobs.executionEngine);
    // Requirement 4 — name the engine where the WORK happens, not only where
    // the switch is. A setting whose effect is invisible is one nobody trusts
    // they changed.
    callbacks.onStatusUpdate(describeRunningEngine(engineSelection));
    if (engineSelection.notice) callbacks.onStatusUpdate(engineSelection.notice);
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
      ...requiredSkillPreflight.skills.disallowedTools,
    ];
    const toolDisallowed = (name: string): boolean =>
      name !== 'profile_stage' && toolNameMatchesAny(name, effectiveDisallowed());
    // A skill allowlist can only subtract from the surface that every
    // existing access/role/capability/scope gate already permits. `undefined`
    // preserves legacy behavior; a declared empty list intentionally hides all.
    const skillAllowsTool = (name: string): boolean =>
      name === 'profile_stage'
      || (
        (
          this.activeSkillAllowedTools === undefined
          || toolNameMatchesAny(name, this.activeSkillAllowedTools)
        )
        && (
          requiredSkillPreflight.skills.allowedTools === undefined
          || toolNameMatchesAny(
            name,
            requiredSkillPreflight.skills.allowedTools,
          )
        )
      );
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
      requiredSkillPreflight,
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
    let finalAnswer = '';
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
    const lifecycleCoordinator = new TurnLifecycleCoordinator({
      agent: this,
      callbacks,
      budgetWindow,
      maxLoops,
      fanOutHinted,
    });
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
      const interruptedAnswer = lifecycleCoordinator.beginLoop(loopCount);
      if (interruptedAnswer) return interruptedAnswer;

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

      lifecycleCoordinator.setPromisedToolsAtCount(repairAndRecordToolCalls({
        agent: this,
        callbacks,
        response,
        allTools,
        promisedToolsAtCount: lifecycleCoordinator.getPromisedToolsAtCount(),
      }));

      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (lifecycleCoordinator.applyPendingSteeringGuard()) continue;
        const childProfileGuard = await runChildProfileGuardPhase({
          agent: this,
          callbacks,
          spawnedChildIds: spawnedChildIdsThisTurn,
          waitedChildIds: waitedChildIdsThisTurn,
          buildOrchestrationContext,
          profileStageController: activeProfileStageController,
          profileStageGuardFired,
          profileStageGuardMax: PROFILE_STAGE_GUARD_MAX,
        });
        profileStageGuardFired = childProfileGuard.profileStageGuardFired;
        if (childProfileGuard.childOutputDelivered) {
          lifecycleCoordinator.markChildOutputDelivered();
        }
        if (childProfileGuard.action === 'continue') continue;
        if (childProfileGuard.action === 'finish') {
          finalAnswer = childProfileGuard.answer ?? '';
          exitedCleanly = true;
          break;
        }

        const terminalGuard = lifecycleCoordinator.evaluateTerminalGuards({
          response,
          spawnedChildIds: spawnedChildIdsThisTurn,
          waitedChildIds: waitedChildIdsThisTurn,
        });
        if (terminalGuard.action === 'continue') continue;
        finalAnswer = terminalGuard.answer;
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
            attemptedRequiredSkills:
              requiredSkillPreflight.attemptedSkillIds,
            warnedRequiredSkills,
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
          if (!isLocal && this.lastBudgetHiddenTools.has(name)) {
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
            const invocation = await invokeAuthorizedToolAdapter({
              agent: this,
              callbacks,
              name,
              args,
              isLocal,
              delegationLaunch: Boolean(delegationLaunch),
              turnSessionKey,
              mcpTool: mcpToolByName.get(name),
              candidateNames: candidates,
              loadedRequiredSkills,
              spawnedChildIds: spawnedChildIdsThisTurn,
              waitedChildIds: waitedChildIdsThisTurn,
              buildOrchestrationContext,
              refreshActiveSkillTools,
              markChildOutputDelivered: () => {
                lifecycleCoordinator.markChildOutputDelivered();
              },
            });
            resultText = invocation.resultText;
            isError = invocation.isError;
            summary = invocation.summary;
            runtimeUnavailable = invocation.runtimeUnavailable;
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

        // Browser observations contain page-controlled text. Frame them before
        // compaction, result handoff, and transcript persistence so restored
        // sessions keep the same trust boundary as the live turn.
        const trustFrame = frameToolResultForModel(name, resultText);
        resultText = trustFrame.content;

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
        const resultSystemMessage = trustFrame.systemMessage ?? childResultSystem;
        const systemMsg = resultSystemMessage
          ? { role: 'system', content: resultSystemMessage }
          : undefined;
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
      const processed = await executeToolBatch({
        toolCalls,
        normalizedNames,
        parallelSafe: safeFlags,
        executeOne: processOneToolCall,
        interrupted: () => this.interruptRequested,
        onInterrupted: (name, toolCall) => {
          const delegationLaunch = registryDelegationLaunchTool(name);
          callbacks.onToolEnd(name, {
            success: false,
            summary: 'turn interrupted — tool skipped',
            ...(delegationLaunch ? { delegationState: 'not-started' as const } : {}),
          }, toolCall.id);
        },
      });

      publishToolBatch({
        results: processed,
        publishToolResult: (toolMsg, fullResultText) => {
          this.chatHistory.push(toolMsg);
          this.recordTranscript({ ...toolMsg, content: fullResultText });
        },
        publishSystemMessage: (systemMsg) => {
          this.chatHistory.push(systemMsg);
          this.recordTranscript(systemMsg);
        },
      });

      repairOrphanToolResults({
        toolCalls,
        results: processed,
        publishSyntheticResult: (synthetic) => {
          this.chatHistory.push(synthetic);
          this.recordTranscript(synthetic);
          callbacks.onStatusUpdate(`Recovery: synthesized placeholder for orphan tool_call ${synthetic.tool_call_id}.`);
        },
      });
    }

    return await finalizeTurnPhase(this, {
      prompt,
      answer: finalAnswer,
      exitedCleanly,
      maxLoops,
      loopCount,
      callbacks,
      activeTurnOrchestration,
      turnSpan,
    });
    } finally {
      profileStageController?.terminate(
        resolveTurnTerminationReason(this, turnSessionKey),
      );
    }
}
