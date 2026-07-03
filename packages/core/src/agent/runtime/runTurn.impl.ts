// runTurn — the agent turn loop, split out of agent.ts (god-file breakdown).
// Byte-identical body; a free function bound to `this: Agent` and assigned onto
// Agent.prototype so all instance state + private helpers resolve exactly as
// before. Imports mirror the symbols the loop referenced inside the class.
import chalk from 'chalk';
import path from 'node:path';
import type { Agent, RunTurnCallbacks } from '../agent.js';
import { getCliKnobs } from '../../config/config.js';
import { linkArtifact } from '../../artifact/artifactStore.js';
import { contextWindowForBudget } from '../../context/contextWindow.js';
import { resolveToolPolicy, externalDirectoryDecision } from '../../exec/policy/execPolicy.js';
import { isPathWithinRoots } from '../../exec/policy/pathPolicy.js';
import { evaluatePermissionRules, primaryArgText } from '../../exec/policy/permissionRules.js';
import { classifyShellCommand } from '../../exec/policy/shellClassifier.js';
import { recordDenial } from '../../exec/runtime/recentDenials.js';
import { readGoal, formatGoalBlock } from '../../goal/store/goalStore.js';
import { buildHookifyContext, evaluateHookify, listHookifyRules } from '../../hooks/hookifyStore.js';
import { runHooks, parseHookDecision, collectStopAdditionalContext } from '../../hooks/hooksStore.js';
import { extractToolText } from '../../mcp/mcpUtils.js';
import { reconnectBackoffMs, probeConnectivity } from '../../mcp/reconnect/reconnect.js';
import { listAll as listAgentDefinitions } from '../../orchestration/agents/agentRegistry.js';
import { executeOrchestrationTool, isOrchestrationToolName, synthesizeDelegateTools, OrchestrationContext } from '../../orchestration/tools.js';
import { buildFanOutHint, shouldSuggestFanOut } from '../../prompt/planning/breadthHint.js';
import { buildNextActionMessages, parseNextActionPlan, nextActionDirective, planWantsFanOut, shouldSkipPlanner } from '../../prompt/planning/nextAction.js';
import { compactToolOutput } from '../../prompt/compaction/toolCompaction.js';
import { isModelNotFoundError, nextFallbackModel, shouldFallbackModel } from '../../provider/modelFallback.js';
import { resolveLocalModelProfile, localModelProfileActive, isLocalModelCoreTool } from '../../provider/modelFamily.js';
import { currentTier, detectNeedsHigh, nextTier, resolveTierLadder, stripNeedsHigh } from '../../provider/tierLadder.js';
import { switchModelToolAvailable } from '../../provider/llmProfiles.js';
import { drainCompletions, formatCompletionFeedback } from '../../session/completion/completionInbox.js';
import { resolveActiveMode } from '../../session/state/sessionModeStore.js';
import { isInternalSessionKey } from '../../session/transcript/sessionStore.js';
import { isConnectivityError, isRetryableServerError } from '../../storage/checkpointStore.js';
import { readPlan } from '../../task/taskStore.js';
import { startSpan, traceEvent } from '../../telemetry/tracing/tracing.js';
import { localToolSpecsFromExecutors } from '../../tool/registry/executors.js';
import { normalizeToolName } from '../../tool/specs/names.js';
import { registryAllowedTools, hideWorkerToolsFor, WORKER_THREAD_TOOLS, MCP_DISCOVERY_TOOLS } from '../../tool/registry/registry.js';
import { LOCAL_TOOLS } from '../../tool/specs/specs.js';
import { applyToolScope, rankAndCapTools } from '../../tool/policy/toolBudget.js';
import { resolveToolVisible } from '../../tool/policy/toolPolicy.js';
import { extractCacheStats } from '../../util/tokens/cacheStats.js';
import { unsynthesizedChildIds, mergePendingChildIds, buildPendingChildStatusHint } from '../../util/agentloop/childResume.js';
import { applyFederationIdentity } from '../../util/agentloop/federationIdentity.js';
import { sanitizeModelArtifacts } from '../../util/agentloop/outputSanitize.js';
import { makeResultHandoff, formatHandoffForModel, attachCompactedResultHandoff } from '../../util/result/resultHandoff.js';
import { isChildSynthesisTool, resultHasChildOutput, looksLikeChildSynthesisPunt } from '../../util/agentloop/synthesisGuard.js';
import { estimateChatHistoryTokens } from '../../util/tokens/tokenEstimate.js';
import { classifyDeferral, buildDeliverableCorrection } from '../guards/deliverableCheck.js';
import { classifyDenial, formatDenialResult } from '../guards/denialMessage.js';
import { resolveEffortForTurn } from '../support/effortRouting.js';
import { shouldRunFanOutFollowThroughGuard } from '../guards/fanOutFollowThroughGuard.js';
import { assessMcpToolApproval } from '../guards/mcpApproval.js';
import { NoTTYError } from '../support/prompter.js';
import { analyzeSchema, flattenSchema, nestArguments, type JSONSchema } from '../repair/flatten.js';
import { ToolCallRepair } from '../repair/index.js';
import { isSequenceGuardExempt, buildSequenceSignature } from '../guards/repeatGuard.js';
import { shouldNudgeTaskTracking, buildTaskTrackingNudge } from '../guards/taskTrackingNudge.js';
import {
  dedupeToolCalls, looksLikeDeferredToolPromise, looksLikeStalledPreamble, mentionsImminentToolWork,
  parseArgumentsOrError, sanitizeToolCallPairing, suggestSimilarToolName, synthesizeOrphanResults,
} from '../guards/toolCallRecovery.js';
import { isParallelSafe, parallelExecutionEnabled } from '../guards/toolSafety.js';
import { resolveToolBudget, isBudgetCheckpoint, buildBudgetCheckpoint, buildBudgetCeilingMessage } from '../guards/turnBudget.js';
import { classifyForVerification, commandWritesFiles, decideVerification, buildVerificationNudge, buildDocsOnlyVerificationNote } from '../guards/verificationGate.js';
import { isTelemetryEnabled } from '../../telemetry/recorder/telemetry.js';
import { recordDailyUsage } from '../../usage/usageHistoryStore.js';
import { shrinkOversizedToolResults } from '../guards/turnEndShrink.js';
import { getToolSummary, getToolPreview } from '../support/toolSummary.js';
import { trackChildObservation, parseChildDrainTimeouts, formatChildDrainTimeoutAnswer, summarizeWaitedChildOutputs } from '../support/childObservation.js';
import { sanitizeToolCallsForHistory, explainUnknownToolName } from '../agent.js';
import {
  buildChatCompletionPayload, buildResponsesPayload, resolveRequestFormat, resolveWireEffort,
  callOpenAI, callOpenAIStream, InterruptError, isInterrupt, activeProviderDef, effortForTurnSelection,
  minimalReasoningEffort, abortableDelay,
} from '../transport/llmTransport.js';

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
    this.interruptRequested = false;
    // DESK-6 — fresh abort controller per turn (AFTER the reset), so a stale
    // pre-turn abort can never poison this turn's first LLM call.
    this.turnAbort = new AbortController();
    // Persist the user's message to the transcript IMMEDIATELY — before recall,
    // the next-action planner, or the main LLM call. Previously this happened
    // only after those server round-trips, so a turn that errored mid-flight
    // (e.g. the 2013 pairing reject) or an app kill lost what the user typed.
    // The model-visible copy is still pushed into chatHistory at its ordered
    // position below (after the goal anchor); only the durable record moves up.
    this.recordTranscript(opts?.hiddenPrompt ? { role: 'user', content: prompt, name: 'goal' } : { role: 'user', content: prompt });
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

    const allowed = this.allowedToolsForAccess();
    // Collapse the orchestration surface the LLM sees onto
    // task_agent (foreground) + delegate_agent (background). spawn_agent /
    // spawn_agents stay registered and executable (workflow.ts slash commands
    // still call them, and `executeOrchestrationTool` dispatches them) but
    // we don't advertise them to the model — that's what made the model
    // pick four overlapping tools at random instead of consistently using
    // task_agent.
    const MODEL_HIDDEN_TOOLS = new Set(['spawn_agent', 'spawn_agents']);
    // Worker-thread tools are registered so the model can call them, but only a
    // depth-0, non-worker orchestrator should SEE them (workers can't spawn
    // workers; a child owns none) — hide the surface from everyone else.
    const hideWorkerTools = hideWorkerToolsFor(this.agentDepth, this.tier);
    const cliKnobs = getCliKnobs();
    const hideComputerUse =
      !cliKnobs.computerUse.enabled ||
      !this.computerUsePort ||
      this.silent ||
      !!cliKnobs.brainUrl;
    // MC-D3 — switch_model is offered ONLY when the install has 2+ named LLM
    // profiles (cli.llmProfiles): with 0–1 there is nothing to switch between,
    // so the surface stays hidden and default behavior is unchanged.
    const llmProfileNames = Object.keys(cliKnobs.llmProfiles ?? {}).sort();
    const hideSwitchModel = !switchModelToolAvailable(cliKnobs.llmProfiles);
    // §5.4 — when progressive discovery is OFF (default) the discovery entry
    // points stay hidden; when ON they're exposed and the full MCP catalog is
    // collapsed below so the model searches for tools instead of carrying them all.
    const mcpDiscoveryOn = cliKnobs.mcpProgressiveDiscovery;
    // HONK-L2 — for local/weak models, pin the built-in surface to the core
    // allowlist and hide the long tail (a small surface is what they handle
    // reliably). Strong/unknown models are untouched. Orchestration tools are
    // added separately, so delegation is unaffected.
    const localToolScope = localModelProfileActive(this.llmConfig.model, cliKnobs.localModelProfile);
    // Per-tool user overrides (cli.toolOverrides). Force-on re-enables a tool the
    // L2 allowlist / budget hid; force-off hides a non-protected tool. Hard gates
    // (access tier, capability) are NEVER bypassed by an override.
    const toolOverrides = cliKnobs.toolOverrides;
    const overrideForceOnNames = new Set(Object.keys(toolOverrides).filter((k) => toolOverrides[k] === true));
    const overrideForceOffNames = Object.keys(toolOverrides).filter((k) => toolOverrides[k] === false);
    // CC-SKILLS-D3 — the active skill's `disallowed-tools` frontmatter blacklists
    // apply for THIS turn on top of the role/agent-def `disallowedTools`. Computed
    // here so it filters BOTH local tools (below) and MCP tools (further down).
    const effectiveDisallowed = [...this.disallowedTools, ...this.activeSkillDisallowedTools];
    const disallowedLocalSet = new Set(effectiveDisallowed);
    let filteredLocalTools = localToolSpecsFromExecutors().filter((t) => {
      // HARD gates first — a user override can never escalate past these.
      const hardVisible =
        allowed.has(t.name) &&
        !disallowedLocalSet.has(t.name) &&
        !MODEL_HIDDEN_TOOLS.has(t.name) &&
        !(hideWorkerTools && WORKER_THREAD_TOOLS.has(t.name)) &&
        !(hideComputerUse && t.name === 'computer_use') &&
        !(hideSwitchModel && t.name === 'switch_model') &&
        !(!mcpDiscoveryOn && MCP_DISCOVERY_TOOLS.has(t.name));
      if (!hardVisible) return false;
      // SOFT gate = the local-model L2 allowlist; the override flips it.
      const softVisible = !(localToolScope && !isLocalModelCoreTool(t.name));
      return resolveToolVisible(t.name, softVisible, toolOverrides);
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
    let visibleMcpTools = mcpTools.filter((t: any) => this.isModelVisibleMcpTool(t));
    // MAS-P4-T1: tool-surface budgeting. First apply the agent def's scope
    // (whitelist `toolScope.mcp` + blacklist `disallowedTools`), then cap the
    // catalog to `cli.agentMcpToolBudget`, keeping the tools most relevant to
    // the latest user turn. Trimmed tools are remembered so a model call to
    // one returns a structured "hidden by budget" hint instead of a bare
    // unknown-tool error.
    this.lastBudgetHiddenTools = new Set();
    if (this.toolScope || effectiveDisallowed.length > 0 || overrideForceOffNames.length > 0) {
      visibleMcpTools = applyToolScope(visibleMcpTools, {
        allow: this.toolScope?.mcp,
        // cli.toolOverrides force-off applies to MCP tools by their namespaced name.
        disallow: [...effectiveDisallowed, ...overrideForceOffNames],
      });
    }
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
    const delegateTools = synthesizeDelegateTools(listAgentDefinitions(this.workspaceRoot));
    const allTools = [...filteredLocalTools, ...delegateTools, ...visibleMcpTools];
    const mcpToolByName = new Map<string, any>();
    for (const tool of mcpTools) {
      const name = String(tool?.name ?? '');
      if (name) mcpToolByName.set(name, tool);
      const rawName = typeof tool?.__rawName === 'string' ? tool.__rawName : '';
      if (rawName) mcpToolByName.set(rawName, tool);
    }
    callbacks.onStatusUpdate(`Loaded ${filteredLocalTools.length} local tools, ${delegateTools.length} delegate tools, and ${mcpTools.length} MCP tools.`);

    // Auto-compact pre-turn check.
    //
    // Threshold: `cli.autoCompactTokens` (default 80_000). An absolute knob —
    // the model's max context window is NOT the driver because (a) hitting 75%
    // of a 1M-context model still costs real money and the user might want to
    // compact much earlier, (b) smaller models with tight windows are better
    // served by a hard ceiling the user explicitly set. BUT the knob is clamped
    // DOWN to ~90% of the model window: a knob larger than the window can never
    // fire (the provider rejects the request before that many tokens accrue), so
    // compaction must trigger within the window, leaving output headroom.
    //
    // Token-count source (the actual correction in 0.3.9):
    //   1. `lastSeenPromptTokens` — the authoritative `usage.prompt_tokens`
    //      from the previous response. The provider charged us for this
    //      number, so it's the truest count available.
    //   2. Content-aware estimator (`tokenEstimate.ts → estimateChatHistoryTokens`)
    //      — fallback for turn 1 (no usage yet) and silent runs. Buckets
    //      chars by class (prose / code-density / CJK) so CJK pastes and
    //      code dumps don't drift the count by 2–4× as the old
    //      `text.length / 4` proxy did.
    if (!this.silent) {
      const windowCap = Math.floor(contextWindowForBudget(this.getModel()) * 0.9);
      const autoCompactThreshold = Math.min(getCliKnobs().autoCompactTokens, windowCap);
      const promptTokens = this.lastSeenPromptTokens !== undefined && this.lastSeenPromptTokens > 0
        ? this.lastSeenPromptTokens
        : estimateChatHistoryTokens(this.chatHistory as any);
      if (promptTokens > autoCompactThreshold && this.chatHistory.length > 6) {
        callbacks.onStatusUpdate(`Auto-compacting history (~${promptTokens.toLocaleString()} tokens > ${autoCompactThreshold.toLocaleString()})...`);
        try {
          const beforeLen = this.chatHistory.length;
          const r = await this.compactHistory();
          if (r && callbacks.onCompactionEvent) {
            callbacks.onCompactionEvent({
              droppedMessages: Math.max(0, beforeLen - this.chatHistory.length),
              keptMessages: this.chatHistory.length,
              summary: r.summary,
            });
          }
          // After a successful compaction the prior `lastSeenPromptTokens`
          // is stale — the history we just summarized doesn't reflect the
          // new compact log. Reset so the next turn's estimator falls back
          // to its content-aware count of the COMPACTED history.
          this.lastSeenPromptTokens = undefined;
        } catch {
          // If compaction fails (no LLM, network), continue without it — better
          // a big payload than a hard turn failure.
        }
      }
    }

    await this.injectRecallContext(prompt, mcpTools, callbacks);

    // Lifecycle: pre-turn hook (informational; failures don't abort the turn).
    if (this.hookAdvisoryActive()) {
      runHooks(this.workspaceRoot, 'pre-turn', { payload: { prompt } });
      void this.runExtensionHooks('pre-turn');
    }
    // CC-P4.2 — user-prompt-submit gate: a hook returning {"decision":"deny"}
    // (or a non-zero exit) blocks the turn before any LLM call; the reason is
    // returned to the user verbatim. BLOCKING — runs for unattended agents too.
    if (this.hookEnforceActive()) {
      const extDeny = await this.runExtensionHooks('user-prompt-submit', { args: { prompt } });
      if (extDeny) return `Prompt blocked by user-prompt-submit hook: ${extDeny}`;
      const submitResults = runHooks(this.workspaceRoot, 'user-prompt-submit', { payload: { prompt } });
      const injectedContext: string[] = [];
      for (const r of submitResults) {
        const d = parseHookDecision(r.stdout);
        const denied = d?.decision === 'deny' || (!d && r.exitCode !== 0);
        if (denied) {
          const reason = d?.reason?.trim() || (r.stderr || r.stdout || '').toString().trim() || `Hook ${r.hook.id} blocked this prompt`;
          return `Prompt blocked by user-prompt-submit hook: ${reason}`;
        }
        // A non-denying hook may INJECT extra context for the model (e.g. a
        // policy reminder, ticket metadata) via {"additionalContext":"…"}.
        if (typeof d?.additionalContext === 'string' && d.additionalContext.trim()) {
          injectedContext.push(d.additionalContext.trim());
        }
      }
      if (injectedContext.length > 0) {
        prompt = `${prompt}\n\n[hook context]\n${injectedContext.join('\n')}`;
      }
    }

    this.lastUserPrompt = prompt;
    this.lastTurnHitLoopLimit = false;
    // Automation is best-effort: a store/detector throw must NEVER escape the
    // turn and break the user's reply (the brief's hard rule). Each automation
    // seam is guarded the same way memory capture is.
    try { this.autoCaptureRequirement(prompt, callbacks); } catch { /* best-effort */ }
    // Breadth-intent detection: when the user signals "do everything" / "in 1 go"
    // / "thoroughly" / "as much as possible", inject a fan-out hint so the
    // agent reaches for spawn_agents instead of a single sequential tool call.
    // Skipped for child agents (silent) — they've already been narrowed by
    // their parent.
    let fanOutHinted = false;
    if (!this.silent) {
      let planned = false;
      // NEXT-ACTION PLANNER — a focused pre-flight reasoning call DECIDES the
      // turn's strategy (answer-direct / investigate / fan-out / workflow) and
      // concrete subtasks, then injects a decisive directive. This replaces the
      // keyword-only breadth guess with actual reasoning. Fail-open: any error /
      // unparseable reply falls through to the breadthHint heuristic below.
      if (getCliKnobs().nextActionPlanner !== 'off' && !shouldSkipPlanner(prompt)) {
        try {
          callbacks.onToolStart('next-action-planner', {});
          // BUILD-LOOP P3 — the `cli.buildLoop` knob lets the planner escalate a
          // code-writing task into the `build` workflow (off | escalate | always).
          const buildLoop = getCliKnobs().buildLoop;
          // POLISH-3 (0.4.13) — the planner is a one-shot CLASSIFIER (pick 1 of 5
          // strategies); it needs no deep reasoning. Run it at low effort so
          // reasoning-capable models don't burn a long thinking pass here — the main
          // lever on the planner's pre-turn latency. Providers that ignore effort no-op.
          const planResp: any = await callOpenAI(this.llmConfig, buildNextActionMessages(prompt, undefined, buildLoop), [], { effort: 'low', signal: this.turnAbort?.signal });
          const plan = parseNextActionPlan(planResp?.content, { buildLoop });
          if (plan) {
            planned = true; // a valid decision (incl. answer-direct) suppresses the keyword fallback
            const directive = nextActionDirective(plan);
            if (directive) this.replaceTaggedSystemMessage('next-action-plan', directive);
            if (planWantsFanOut(plan)) fanOutHinted = true;
            callbacks.onToolEnd('next-action-planner', {
              success: true,
              summary: `strategy=${plan.strategy}${plan.subtasks.length ? ` (${plan.subtasks.length} subtasks)` : ''}`,
            });
            callbacks.onStatusUpdate(`Next-action plan: ${plan.strategy}${planWantsFanOut(plan) ? ' — fanning out' : ''}`);
          } else {
            callbacks.onToolEnd('next-action-planner', { success: true, summary: 'no usable plan — fail-open to heuristic' });
          }
        } catch {
          callbacks.onToolEnd('next-action-planner', { success: false, summary: 'planner unavailable — fail-open to heuristic' });
        }
      }
      // Fallback: planner disabled / skipped / failed / produced nothing → the
      // keyword breadth heuristic still nudges fan-out for obvious broad prompts.
      if (!planned) {
        const { suggest, intent } = shouldSuggestFanOut(prompt);
        if (suggest) {
          fanOutHinted = true;
          this.replaceTaggedSystemMessage('fanout-hint', buildFanOutHint(prompt, intent));
          callbacks.onStatusUpdate(`Fan-out hint injected (signals: ${intent.signals.join(', ')})`);
          callbacks.onToolStart('breadth-detector', { signals: intent.signals, score: intent.score });
          callbacks.onToolEnd('breadth-detector', { success: true, summary: `fan-out hint injected (${intent.signals.length} signals)` });
        }
      }
    }

    // Per-turn goal anchor: re-inject a FRESH goal block at the end of the
    // chatHistory's system messages (replaceTaggedSystemMessage appends), so
    // it lands right before the user prompt. Pre-9d the goal block was ALSO
    // embedded in the foundational system message (via createSystemMessage),
    // which meant every turn carried two copies; 9d made this anchor the
    // single source — `createSystemMessage` no longer touches goal state.
    // The fresh re-push every iteration keeps the up-to-date iteration
    // counter in immediate-context distance and prevents the long /goal
    // continuation-loop drift that PR #26 originally addressed. The anchor
    // also auto-folds the final-budget-turn wrap-up directive (via
    // `formatGoalBlock`'s internal `goalIsOnFinalBudgetTurn` check), so
    // the separate `goal-budget-steering` tagged message is gone too.
    if (!this.silent) {
      const activeGoal = readGoal(this.workspaceRoot, this.sessionKey);
      if (activeGoal?.text && activeGoal.status === 'active') {
        this.replaceTaggedSystemMessage('goal-anchor', formatGoalBlock(activeGoal));
      } else {
        // No active goal — drop any stale anchor from a prior /goal so the
        // model doesn't keep seeing a completed/cleared goal as "current."
        this.removeTaggedSystemMessage('goal-anchor');
      }
    }

    const userMsg: { role: string; content: string; images?: Array<{ mediaType: string; dataBase64: string }> } = { role: 'user', content: prompt };
    // vision — pasted/attached images ride as a SIDECAR on the user message so
    // `content` stays a string (every token-tally / transcript / compaction path
    // keeps working); the payload builders inline them per provider at request
    // time. The durable transcript (recorded above) stays text-only by design.
    if (opts?.images?.length) userMsg.images = opts.images;
    this.chatHistory.push(userMsg);
    // The durable transcript record for this user message was already written
    // at the top of runTurn (so it survives a mid-turn failure); here we only
    // push the model-visible copy into chatHistory, after the goal anchor. A
    // goal kickoff / continuation prompt was recorded tagged `name:'goal'` so
    // the render layer hides it while the model still sees the clean message.
    // MAR-4 — when children from the prior turn are still pending, hand the model the
    // exact ids to wait on so it resolves them directly instead of guessing from list_agents.
    const pendingChildHint = buildPendingChildStatusHint(carriedPendingChildIds);
    if (pendingChildHint) {
      const hintMsg = { role: 'system', content: pendingChildHint };
      this.chatHistory.push(hintMsg);
      this.recordTranscript(hintMsg);
    }
    // COMPLETION-FEEDBACK — fold in any DETACHED background actor (worker thread
    // or fire-and-forget child) that finished since this agent's last turn, so
    // its result lands in context the way an in-turn `wait_*` result would. The
    // drain delivers each completion exactly once.
    const completions = drainCompletions(this.sessionKey);
    if (completions.length > 0) {
      const feedback = formatCompletionFeedback(completions);
      if (feedback) {
        const feedbackMsg = { role: 'system', content: feedback };
        this.chatHistory.push(feedbackMsg);
        this.recordTranscript(feedbackMsg);
      }
    }

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
      parentVisibleTools: () => mcpTools.map((t: any) => String(t.name)).filter(Boolean),
      // Snapshot the parent's ACTIVE SESSION stance at spawn time (session
      // override > workspace pref) so the child records the mode the parent
      // was actually running — not a workspace default a later, unrelated
      // session switch might change.
      parentExecutionMode: resolveActiveMode(this.workspaceRoot, this.sessionKey).executionMode,
      parentReviewPolicy: resolveActiveMode(this.workspaceRoot, this.sessionKey).reviewPolicy,
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

      let response: { content: string; toolCalls?: any[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; finishReason?: string };
      const invokeLlm = async () => {
        // Transport boundary guard: never send a malformed assistant.tool_calls ↔
        // tool-result sequence (strict gateways reject it with "tool call result
        // does not follow tool call (2013)"). Idempotent on a well-formed history;
        // a non-mutating copy so the in-memory guard logic still reads the raw
        // chatHistory. loadHistory already repairs the resumed prefix — this also
        // covers any live malformation (compaction, interrupts, guard injects).
        const requestMessages = sanitizeToolCallPairing(this.chatHistory);
        // Re-resolve every loop iteration so an in-session `/effort` flip
        // (which only refreshes the system prompt) also updates the next
        // request's reasoning_effort slot — no restart needed. Resolve from
        // the ACTIVE SESSION (session override > workspace pref/config) so a
        // per-chat `/effort` sticks to that chat. A spawned child with a
        // per-run effort override (0.4.x-5) uses that instead. `fast` execution
        // mode forces the model's MINIMUM reasoning (Fast = minimal reasoning).
        const activeMode = resolveActiveMode(this.workspaceRoot, this.sessionKey);
        const selectedEffort = effortForTurnSelection(activeMode, this.llmConfig.model, this.effortOverride);
        const effort = resolveEffortForTurn(selectedEffort, this.chatHistory, getCliKnobs());
        // TIER A: stream when the UI is listening for deltas, AND the
        // user hasn't disabled it. Streaming opts in only when a delta
        // callback is supplied — silent mode / children / tests stay on
        // the non-streaming path so their behavior is unchanged.
        const streamRequested = Boolean(
          callbacks.onAssistantDelta || callbacks.onReasoningDelta,
        ) && getCliKnobs().disableStream !== true;
        if (streamRequested) {
          try {
            let started = false;
            const final = await callOpenAIStream(
              this.llmConfig,
              requestMessages,
              allTools,
              { effort, signal: this.turnAbort?.signal },
              {
                onTextDelta: (text) => {
                  if (!started) {
                    started = true;
                    callbacks.onAssistantTurnStart?.();
                  }
                  callbacks.onAssistantDelta?.(text);
                },
                onReasoningDelta: (text) => {
                  callbacks.onReasoningDelta?.(text);
                },
              },
            );
            if (started) callbacks.onAssistantTurnEnd?.(final.content);
            return { content: final.content, toolCalls: final.toolCalls, usage: final.usage, finishReason: final.finishReason };
          } catch (streamErr: any) {
            // DESK-6 — a user Stop must NOT silently restart as a non-streaming
            // call; rethrow the interrupt so the turn unwinds. (Detect by the
            // sentinel/flag, never message-substring — "aborted" is overloaded.)
            if (isInterrupt(streamErr) || this.interruptRequested) throw streamErr;
            // Streaming failed (provider doesn't support SSE, malformed
            // chunks, network blip). Fall back transparently to the
            // non-streaming path so the turn still completes — log via
            // status so the user can see why their text wasn't live.
            callbacks.onStatusUpdate(`Streaming failed (${String(streamErr?.message ?? streamErr).slice(0, 120)}) — falling back to non-streaming.`);
          }
        }
        return await callOpenAI(this.llmConfig, requestMessages, allTools, { effort, signal: this.turnAbort?.signal });
      };
      // Transient connectivity failures (fetch failed / ECONNRESET / socket
      // hang up / timeouts) are retried with backoff before giving up — a
      // network blip shouldn't kill a turn, a worker, or a child agent. This
      // is why background workers (which are `silent`) were dying on the first
      // hiccup while grok/claude-code/codex ride it out. `shouldRetryLlm` also
      // covers transient SERVER-side failures — HTTP 5xx, gateway timeouts
      // (the "504 Gateway Time-out" from the provider's load balancer), rate
      // limits (429), and overload errors — not just client-side connectivity.
      // Context-overflow and model-not-found errors are neither, so they fall
      // straight through to the dedicated recovery in the catch below.
      // RECONNECT (0.4.12) — Codex-style: a transient failure (timeout / disconnect
      // / 5xx / 429) RECONNECTS with exponential backoff (honoring Retry-After) up to
      // `llmMaxReconnects`, rather than dying on the first hiccup. AND — if the
      // machine is genuinely OFFLINE — it keeps waiting for the link to return WITHOUT
      // spending the reconnect budget, so a dropped connection auto-resumes once the
      // network is back (a long background worker no longer dies on a Wi-Fi blip).
      const maxReconnects = Math.max(1, getCliKnobs().llmMaxReconnects);
      const OFFLINE_MAX_WAITS = 120; // generous: keep waiting for the network to return
      const llmEndpoint = this.llmConfig?.endpoint ?? '';
      const invokeLlmResilient = async (): Promise<Awaited<ReturnType<typeof invokeLlm>>> => {
        // WS0 — record cache-stable-prefix stability once per logical LLM call
        // (here, BEFORE the retry loop, so transient-failure retries don't
        // double-count). The prefix slice is unaffected by invokeLlm's
        // per-attempt sanitize, so deriving it from chatHistory + allTools is
        // equivalent to the sanitized request.
        this.recordPrefixStability(this.chatHistory, allTools);
        let attempt = 0;
        let offlineWaits = 0;
        for (;;) {
          // DESK-6 — a Stop ends the turn here, BEFORE the reconnect classifier:
          // a user interrupt must never be mistaken for a transient blip and
          // retried (CONNECTIVITY_RE matches "aborted", so a naive abort would
          // reconnect — re-firing the exact request the user tried to stop).
          if (this.interruptRequested) throw new InterruptError();
          try {
            return await invokeLlm();
          } catch (err: any) {
            if (this.interruptRequested || isInterrupt(err)) throw isInterrupt(err) ? err : new InterruptError();
            // Only transient transport / server failures reconnect; deterministic
            // errors (4xx, context overflow, model-not-found) fall straight through.
            const serverSide = isRetryableServerError(err);
            if (!serverSide && !isConnectivityError(err)) throw err;
            // A connectivity error may just be the network being down — probe; while
            // offline, wait for it to come back without consuming the retry budget.
            const online = serverSide ? true : await probeConnectivity(llmEndpoint);
            if (!online) {
              if (offlineWaits >= OFFLINE_MAX_WAITS) throw err;
              offlineWaits += 1;
              const delay = reconnectBackoffMs(Math.min(offlineWaits, 6), { capMs: 15_000 });
              callbacks.onStatusUpdate(`Waiting for connection… offline — retrying in ${(delay / 1000).toFixed(1)}s (${offlineWaits})`);
              await abortableDelay(delay, this.turnAbort?.signal); // DESK-6 — Stop wakes the wait
              continue;
            }
            attempt += 1;
            if (attempt > maxReconnects) throw err;
            const retryAfterMs = typeof err?.retryAfterMs === 'number' ? err.retryAfterMs : undefined;
            const delay = reconnectBackoffMs(attempt, { retryAfterMs });
            callbacks.onStatusUpdate(
              `Reconnecting… ${attempt}/${maxReconnects} — ${String(err?.message ?? err).slice(0, 60)} (in ${(delay / 1000).toFixed(1)}s)`,
            );
            await abortableDelay(delay, this.turnAbort?.signal); // DESK-6 — Stop wakes the wait
          }
        }
      };
      try {
        response = await invokeLlmResilient();
      } catch (err: any) {
        // DESK-6 — a user Stop unwinds to the SAME clean "interrupted" answer as
        // the loop-top check, BEFORE any reactive compaction / model-fallback
        // recovery (so a Stop during a 504-ish moment isn't re-routed into a
        // retry path). Mirrors the loop-top handler exactly.
        if (isInterrupt(err) || this.interruptRequested) {
          this.interruptRequested = false;
          const note = '⏹ Turn interrupted by user.';
          const interruptMsg = { role: 'system', content: 'The user interrupted this turn before it finished; the work above may be incomplete.' };
          this.chatHistory.push(interruptMsg);
          this.recordTranscript(interruptMsg);
          callbacks.onStatusUpdate('Interrupted');
          return note;
        }
        // Layered LLM recovery. We detect context-
        // window-exceeded errors (the single failure mode where a fresh
        // request is guaranteed to fail the same way) and trigger a
        // reactive compaction before retrying ONCE. Other errors propagate
        // unchanged — bare rethrow preserves the prior surface for
        // network/auth/rate-limit failures the user wants to see.
        const message = String(err?.message ?? err);
        const looksContextOverflow = /context length|context window|maximum context|too many tokens|reduce the length|prompt is too long|413|tokens? exceed/i.test(message);
        if (looksContextOverflow && !this.silent && this.chatHistory.length > 6) {
          callbacks.onStatusUpdate(`Context overflow detected — reactive compaction before retry...`);
          try {
            const beforeLen = this.chatHistory.length;
            const r = await this.compactHistory();
            if (r && callbacks.onCompactionEvent) {
              callbacks.onCompactionEvent({
                droppedMessages: Math.max(0, beforeLen - this.chatHistory.length),
                keptMessages: this.chatHistory.length,
                summary: r.summary,
              });
            }
            response = await invokeLlmResilient();
          } catch (retryErr: any) {
            throw new Error(`LLM Execution failed after reactive compaction: ${retryErr?.message ?? retryErr}`);
          }
        } else if (
          isModelNotFoundError(message) &&
          (() => {
            // CC-CONFIG-A2: walk the ORDERED fallback chain (which already appends
            // the legacy single `cli.fallbackModel` last for back-compat). The
            // per-turn `triedModels` set ensures we never re-try a dead candidate,
            // so a model-not-found cascades through each fallback until one works.
            this.triedModels.add((this.llmConfig.model ?? '').trim());
            return nextFallbackModel(this.llmConfig.model, getCliKnobs().fallbackModels, this.triedModels) !== null;
          })()
        ) {
          const from = this.llmConfig.model;
          const fallback = nextFallbackModel(from, getCliKnobs().fallbackModels, this.triedModels) as string;
          this.triedModelFallback = true;
          this.triedModels.add(fallback);
          this.setModel(fallback);
          callbacks.onStatusUpdate(`Model "${from}" unavailable — falling back to ${fallback}...`);
          try {
            response = await invokeLlmResilient();
          } catch (retryErr: any) {
            throw new Error(`LLM Execution failed after model fallback (${from} → ${fallback}): ${retryErr?.message ?? retryErr}`);
          }
        } else {
          throw new Error(`LLM Execution failed: ${message}`);
        }
      }
      // 0.3.9 item 13 — model-tier self-escalation. When the response
      // starts with `<<<NEEDS_HIGH>>>` (with or without `:reason`), the
      // model is telling us this task exceeds its current tier. Step
      // the ladder one up, retry the same turn, and surface a yellow
      // warning row. Pro-tier marker is a no-op. Bounded by a per-turn
      // counter so a marker-emitting model can't loop forever.
      const needsHigh = detectNeedsHigh(response.content);
      if (needsHigh && (this.tierEscalationsThisTurn ?? 0) < 2) {
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
        // HEADLESS-EVENTS — running token tally after each LLM call.
        callbacks.onUsageUpdate?.({ ...this.lastTurnUsage });
      }

      // 0.3.8-I4: Strict tool-call recovery. Real-world LLMs (especially
      // smaller / quantised) sometimes emit duplicate tool_call ids in a
      // single response. If we let both through, OpenAI's next request 400s
      // because one of the duplicates has no paired tool_result. Dedupe
      // before pushing the assistant message — last occurrence wins (closest
      // to the model's final intent).
      // Enforces the same well-formed history invariant as the pre-request
      //   dangling-tool-call recovery, applied per-response instead.
      if (response.toolCalls && response.toolCalls.length > 0) {
        const deduped = dedupeToolCalls(response.toolCalls, (id) => {
          callbacks.onStatusUpdate(`Recovery: dropped duplicate tool_call id "${id}" (last occurrence wins).`);
        });
        response.toolCalls = deduped;
      }

      // 0.3.9 item 11 — run the repair pipeline on the
      // assistant's tool_calls before they reach dispatch:
      //   • scavenge — recover calls leaked into the content channel;
      //   • truncation — rebalance JSON in arguments cut off by
      //     max_tokens;
      //   • storm — suppress identical-args loops.
      // `flatten` runs at registration time, not per-turn (see the
      // schema-flatten patch in orchestration/tools.ts).
      const allowedToolNames = new Set<string>(allTools.map((t: any) => t.name).filter(Boolean));
      if (!this.toolCallRepair) {
        this.toolCallRepair = new ToolCallRepair({
          allowedToolNames,
          isMutating: (call) => {
            const n = call.function?.name ?? '';
            return n === 'write_file' || n === 'edit_file' || n === 'apply_patch' || n === 'run_command';
          },
          isStormExempt: (call) => {
            const n = call.function?.name ?? '';
            return n === 'list_jobs' || n === 'get_status' || n === 'list_agents' || n === 'wait_agent' || n === 'wait_agents';
          },
        });
      }
      const repairInput = (response.toolCalls ?? []) as any[];
      // Identify which originals were suppressed by storm/repair (by id) so
      // we can synthesize matching ERROR tool_results and surface
      // user-visible `onToolEnd` events. Otherwise the OpenAI invariant
      // breaks (assistant tool_call with no paired tool_result) and the
      // legacy "repeat guard tripped" UX regresses.
      const survivingIds = new Set<string>();
      const repaired = this.toolCallRepair.process(
        repairInput.map((c) => ({ id: c.id, type: c.type, function: c.function })),
        // OpenAI-compat callOpenAI() doesn't return reasoning_content
        // separately yet — pass content as the secondary scavenge
        // channel so DSML / leaked JSON in content is still caught.
        null,
        typeof response.content === 'string' ? response.content : null,
      );
      this.lastRepairReport = repaired.report;
      // CLI-8 — fold this turn's report into the session totals.
      const rr = repaired.report;
      const touched = rr.scavenged > 0 || rr.truncationsFixed > 0 || rr.truncationsUnrecoverable > 0 || rr.stormsBroken > 0;
      if (touched) {
        this.repairTotals.scavenged += rr.scavenged;
        this.repairTotals.truncationsFixed += rr.truncationsFixed;
        this.repairTotals.truncationsUnrecoverable += rr.truncationsUnrecoverable;
        this.repairTotals.stormsBroken += rr.stormsBroken;
        this.repairTotals.turnsWithRepair += 1;
      }
      for (const c of repaired.calls) if (c.id) survivingIds.add(c.id);
      if (repaired.report.scavenged > 0 || repaired.report.truncationsFixed > 0 || repaired.report.stormsBroken > 0) {
        traceEvent('tool_call.repair', {
          scavenged: repaired.report.scavenged,
          truncationsFixed: repaired.report.truncationsFixed,
          truncationsUnrecoverable: repaired.report.truncationsUnrecoverable,
          stormsBroken: repaired.report.stormsBroken,
          notes: repaired.report.notes,
        });
        if (repaired.report.scavenged > 0) {
          callbacks.onStatusUpdate(`Repair: scavenged ${repaired.report.scavenged} tool call${repaired.report.scavenged === 1 ? '' : 's'} from response content.`);
        }
      }
      // Surface storm-suppressed originals as `onToolEnd` events so the
      // user sees "repeat guard tripped (Nx <tool>)" and the model
      // receives a paired ERROR tool_result on the next request.
      const suppressedSynthetic: any[] = [];
      if (repairInput.length > 0) {
        for (const original of repairInput) {
          if (original.id && survivingIds.has(original.id)) continue;
          // The storm pipeline-level suppression was the only path that
          // can drop a declared call without emitting its own
          // tool_result. Mirror the legacy guard's user-visible summary.
          const name = original.function?.name ?? 'unknown';
          const summary = `repeat guard tripped (storm pipeline ${name})`;
          callbacks.onToolStart?.(name, {});
          callbacks.onToolEnd?.(name, { success: false, summary });
          suppressedSynthetic.push({
            role: 'tool',
            tool_call_id: original.id,
            name,
            content: `ERROR: ${summary}. The same (name, args) pair fired more times than the pipeline-level storm guard allows. Pick a different action or call goal_blocked if no further path remains.`,
            isError: true,
          });
        }
      }
      response.toolCalls = repaired.calls.length > 0 ? (repaired.calls as any[]) : undefined;
      // Stash the synthetic tool_results to push AFTER the assistant
      // message lands in chatHistory — preserve OpenAI's tool_call ↔
      // tool_result ordering.
      (response as any)._suppressedSyntheticResults = suppressedSynthetic;
      // Record Assistant message
      const assistantMsg: any = { role: 'assistant', content: response.content };
      if (response.toolCalls) {
        // History gets args sanitized to valid JSON (execution below still uses
        // the ORIGINAL response.toolCalls, so a malformed call still errors to the
        // model). Prevents a later "400 invalid function arguments json string".
        assistantMsg.tool_calls = sanitizeToolCallsForHistory(response.toolCalls);
      }
      this.chatHistory.push(assistantMsg);
      this.recordTranscript(assistantMsg);

      // Note an unfulfilled tool-promise: the model announced future tool work.
      // Record the tool count so the terminal guard can tell whether the
      // promise was actually kept (tools ran after it) or the turn stalled /
      // pivoted to asking the user instead.
      if (
        (!response.toolCalls || response.toolCalls.length === 0) &&
        (looksLikeDeferredToolPromise(response.content) || mentionsImminentToolWork(response.content))
      ) {
        // Arm on a strict start-anchored preamble OR a lenient "buried" forward
        // promise (a long message that ends "…I'll proceed by locating … and
        // run the comparison"), so the terminal guard catches the stall either
        // way.
        promisedToolsAtCount = this.lastTurnToolCalls;
      } else if (response.toolCalls && response.toolCalls.length > 0) {
        promisedToolsAtCount = -1; // a real tool batch fulfils any prior promise
      }

      // 0.3.9 item 11 — flush any storm-suppressed synthetic tool_results
      // immediately after the assistant message so the LLM sees them
      // paired with the original tool_call ids. Done before the
      // no-tool_calls early-exit because the assistantMsg may still
      // carry some surviving calls (mixed case).
      const syntheticResults = (response as any)._suppressedSyntheticResults as any[] | undefined;
      if (syntheticResults && syntheticResults.length > 0) {
        for (const r of syntheticResults) {
          this.chatHistory.push(r);
          this.recordTranscript(r);
        }
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
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
        ...LOCAL_TOOLS.map((lt) => lt.name),
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
          callbacks.onToolEnd(name, { success: false, summary: `repeat sequence guard tripped (${previousSequenceRepeats + 1}× ${sequenceLabel})`, preview: resultText });
          traceEvent('brainrouter.tool', { tool: name, ok: false, local: LOCAL_TOOLS.some(lt => lt.name === name), session_key: this.sessionKey, guard: 'repeat_sequence' }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
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

      const processOneToolCall = async (tc: any, name: string): Promise<{ toolMsg: any; fullResultText: string; systemMsg?: any }> => {
        this.lastTurnToolCalls += 1;
        // INTERRUPT — skip queued tools once a stop is requested; the loop-top
        // check then ends the turn before the next LLM call.
        if (this.interruptRequested) {
          const skipped = 'Skipped: turn interrupted by user.';
          callbacks.onToolEnd(name, { success: false, summary: 'turn interrupted — tool skipped' }, tc.id);
          return { toolMsg: { role: 'tool', tool_call_id: tc.id, name, content: skipped, isError: true }, fullResultText: skipped };
        }
        // CC-P6.5 — classify this call for the verification gate (wrote files vs
        // ran a build/test/lint). Best-effort arg parse; the real execution +
        // arg validation happens below. We also record WHICH files were written
        // (edit-tool paths) so the gate can tell a docs/config-only change from a
        // code change, and flag an opaque file-writing shell command.
        try {
          const parsedArgs = typeof tc?.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc?.function?.arguments ?? {});
          const cmdText = name === 'run_command' ? String(parsedArgs?.command ?? '') : '';
          const signal = classifyForVerification(name, cmdText);
          if (signal === 'mutated') {
            this.mutatedThisTurn = true;
            if (name === 'run_command') {
              // A file-writing shell command — we can't reliably know which path
              // it wrote, so it can never be ruled docs-only.
              if (commandWritesFiles(cmdText)) this.shellWroteThisTurn = true;
            } else {
              const p = typeof parsedArgs?.path === 'string' ? parsedArgs.path
                : typeof parsedArgs?.file === 'string' ? parsedArgs.file
                : typeof parsedArgs?.filePath === 'string' ? parsedArgs.filePath : '';
              if (p) this.filesWrittenThisTurn.push(p);
            }
          } else if (signal === 'verified') {
            this.verifiedThisTurn = true;
          }
        } catch { /* arg parse is best-effort; gate just won't credit this call */ }
        // 0.3.8-I4: Use the strict-recovery helper so a malformed-arguments
        // tool_call surfaces as a structured tool_result (with the raw
        // arguments echoed back) instead of throwing out of the loop.
        const parsedArgs = parseArgumentsOrError(tc);
        let args: any = parsedArgs.args;
        const argParseError: string | undefined = parsedArgs.error;

        const isLocal = LOCAL_TOOLS.some(lt => lt.name === name);
        callbacks.onToolStart(name, args, tc.id);

        let resultText = '';
        let isError = false;
        let summary = '';

        // If the LLM emitted malformed JSON for arguments, fail the tool call
        // up-front with a clear error so it can self-correct next turn.
        if (argParseError) {
          isError = true;
          resultText = argParseError;
          summary = 'malformed JSON args';
          callbacks.onToolEnd(name, { success: false, summary }, tc.id);
          traceEvent('brainrouter.tool', { tool: name, ok: false, local: isLocal, session_key: this.sessionKey, guard: 'bad_args' }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
          const toolMsg = { role: 'tool', tool_call_id: tc.id, name, content: resultText, isError };
          return { toolMsg, fullResultText: resultText };
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
          callbacks.onToolEnd(name, { success: false, summary }, tc.id);
          traceEvent('brainrouter.tool', { tool: name, ok: false, local: isLocal, session_key: this.sessionKey, guard: 'repeat' }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
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
          // POLICY-2 — route EVERY tool (local, orchestration, worker, MCP)
          // through the unified execution policy, not just local ones (POLICY-1).
          // A mutating action (file edit, child spawn/delegate, shell) emits an
          // audit + trace event; a deny throws with the policy's reason; an 'ask'
          // a silent child can't answer fails closed. This closes the gap where
          // spawn/delegate/worker dispatches bypassed the access-mode gate.
          {
            // CC-SAFETY-B2 — record any denial into the bounded, session-scoped
            // recent-denials ring so `/recent-denials` can surface WHY the agent
            // kept getting blocked. Best-effort; never breaks the gate.
            const denyAndRecord = (reason: string): never => {
              try { recordDenial(this.workspaceRoot, this.sessionKey, name, reason); } catch { /* best-effort */ }
              throw new Error(reason);
            };
            // CC-P3.2 — declarative cli.permissions rules run FIRST: a deny match
            // blocks outright; an allow match downgrades an `ask` below (it never
            // overrides a mode-based deny — rules can't escalate read mode).
            const ruleDecision = evaluatePermissionRules(
              getCliKnobs().permissions, name, primaryArgText(name, args as Record<string, unknown> | null),
              { workspace: this.workspaceRoot });
            if (ruleDecision === 'deny') {
              denyAndRecord(`Tool "${name}" denied: matched a cli.permissions deny rule.`);
            }
            // CC-SAFETY-B1 — classify-all-shell: when enabled, route EVERY
            // run_command through the safety classifier at the gate (not just the
            // ones a downstream heuristic catches). 'on' asks/denies on a risky
            // verdict; 'strict' denies unless whitelisted. Silent sessions can't
            // answer a prompt, so an 'ask' verdict fails closed there.
            if (name === 'run_command') {
              const knobs = getCliKnobs();
              if (knobs.autoClassifyShell !== 'off') {
                const cmd = String((args as { command?: unknown } | null)?.command ?? '');
                const verdict = classifyShellCommand(cmd, {
                  mode: knobs.autoClassifyShell,
                  silent: this.silent,
                  enforceWhenSilent: knobs.autoClassifyShellEnforceWhenSilent,
                  allowlist: knobs.commandAllowlist,
                  destructiveContext: { userIntent: this.lastUserPrompt },
                });
                if (verdict.decision === 'deny') {
                  denyAndRecord(`Tool "${name}" denied by autoClassifyShell (${verdict.rule}): ${verdict.reason}`);
                }
                if (verdict.decision === 'ask' && this.silent) {
                  denyAndRecord(`Tool "${name}" flagged by autoClassifyShell but this session can't prompt (fail-closed) (${verdict.rule}): ${verdict.reason}`);
                }
              }
            }
            const policy = resolveToolPolicy(name, this.accessMode, args as Record<string, unknown> | null);
            if (ruleDecision === 'allow' && policy.decision === 'ask') {
              policy.decision = 'allow';
              policy.reason = 'cli.permissions allow rule';
            }
            if (policy.mutating) {
              this.policyAudit.push({ tool: name, action: policy.action, decision: policy.decision, reason: policy.reason });
              traceEvent(
                'policy.decision',
                { tool: name, action: policy.action, decision: policy.decision, access_mode: this.accessMode, session_key: this.sessionKey, local: isLocal },
                { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId },
              );
              // HEADLESS-EVENTS — surface the policy decision to consumers.
              callbacks.onApproval?.({ tool: name, action: policy.action, decision: policy.decision, reason: policy.reason });
            }
            if (policy.decision === 'deny') {
              denyAndRecord(`Tool "${name}" denied by execution policy: ${policy.reason}.`);
            }
            if (policy.decision === 'ask' && this.silent) {
              denyAndRecord(`Tool "${name}" requires approval but this session can't prompt (fail-closed): ${policy.reason}.`);
            }
            // POLICY-3 — external-directory gate: a file write whose target
            // escapes the workspace is governed by the profile's
            // `externalDirWrites` mode (deny / ask / allow). Independent of the
            // access-mode decision above.
            if (policy.action === 'file_edit' && typeof args?.path === 'string' && args.path) {
              const target = path.resolve(this.workspaceRoot, args.path);
              const ext = externalDirectoryDecision(target, this.workspaceRoot, getCliKnobs().externalDirWrites, isPathWithinRoots);
              if (ext.decision === 'deny') {
                denyAndRecord(`Tool "${name}" denied: ${ext.reason}.`);
              }
              if (ext.decision === 'ask' && this.silent) {
                denyAndRecord(`Tool "${name}" requires approval (external write) but this session can't prompt: ${ext.reason}.`);
              }
            }
          }
          // Defense-in-depth: a LOCAL tool outside the access-mode inventory
          // (scope/budget-filtered) is still blocked even when its action kind
          // is allowed. Orchestration/MCP tools have their own inventory; the
          // `allowed` set is the local-tool roster.
          if (isLocal && !allowed.has(name)) {
            throw new Error(`Tool "${name}" is not permitted in access mode "${this.accessMode}".`);
          }
          // 0.4.x-4 (`/context`) — count each tool that actually dispatches.
          this.toolCallCounts.set(name, (this.toolCallCounts.get(name) ?? 0) + 1);
          // CC-UX-E3 (`/usage`) — attribute MCP tool dispatch to its server so
          // the breakdown can show per-server call counts. `mcp_<server>_<tool>`
          // → serverId; non-MCP tools return undefined and aren't counted.
          {
            const serverId = this.serverIdFromMcpToolName(name);
            if (serverId) this.mcpServerCallCounts.set(serverId, (this.mcpServerCallCounts.get(serverId) ?? 0) + 1);
          }
          if (isOrchestrationToolName(name)) {
            // WF-NO-NEST — a silent/child agent (itself a spawned worker, incl.
            // a workflow PHASE agent) must never launch its own workflow. That
            // recursion is what produced the "lots of workflows" runaway: a
            // build worker called run_workflow → a nested install/verify
            // workflow → token blow-up, with no human to approve it. Phase work
            // is done DIRECTLY (or via plain spawn_agents, depth-capped); only a
            // top-level, user-facing agent may launch a workflow.
            // Both the declarative `run_workflow` and the saved-graph
            // `run_workflow_graph` fan out child agents, so they share the
            // nest-block + cost-confirm gate.
            const isWorkflowLaunch = name === 'run_workflow' || name === 'run_workflow_graph';
            if (isWorkflowLaunch && this.silent) {
              isError = true;
              resultText =
                `${name} is not available to a spawned/child agent — nested workflows are blocked ` +
                '(they recurse and run unattended). Do this work directly with the regular tools ' +
                '(read_file, write_file, edit_file, run_command), or use spawn_agents for genuinely ' +
                'independent sub-tasks.';
              summary = `nested ${name} blocked`;
            } else if (isWorkflowLaunch && !(await this.confirmRunWorkflowLaunch(args))) {
              isError = true;
              resultText =
                `${name} declined — the workflow launch was not approved (workflows fan out ` +
                'multiple agents and cost more tokens). Proceed with the regular tools (spawn_agents, ' +
                'run_command, …) or ask the user to approve the workflow.';
              summary = 'workflow launch declined';
            } else {
              resultText = await executeOrchestrationTool(name, args, buildOrchestrationContext());
              summary = getToolSummary(name, args, resultText);
              trackChildObservation(name, args, resultText, spawnedChildIdsThisTurn, waitedChildIdsThisTurn);
              // MAR-3 — note when a child/sub-agent's findings reached the parent this turn.
              if (isChildSynthesisTool(name) && resultHasChildOutput(resultText)) childOutputDeliveredThisTurn = true;
            }
          } else if (isLocal) {
            resultText = await this.executeLocalTool(name, args);
            summary = getToolSummary(name, args, resultText);
            if (name === 'track_update') {
              // Best-effort — a throw here must not fail the tool result.
              let automationCount = 0;
              try { automationCount = this.applyTrackCodeSignalAutomation(args, callbacks); } catch { /* best-effort */ }
              if (automationCount > 0) {
                summary = `${summary} | automation advanced ${automationCount} Track item${automationCount === 1 ? '' : 's'}`;
              }
            }
            if (name === 'goal_complete') { try { this.autoReconcileGoalCompletion(callbacks); } catch { /* best-effort */ } }
            // Plan-ticker: surface update_plan changes to the REPL so the user
            // sees the live ✓/⏳/☐ checklist instead of having to run /plan.
            if (name === 'update_plan' && Array.isArray(args.plan) && callbacks.onPlanUpdate) {
              callbacks.onPlanUpdate(args.plan, args.explanation);
            }
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
            await this.approveMcpToolCall(name, mcpToolByName.get(name), mcpArgs);
            const mcpRes = await this.mcpClient.callTool(name, mcpArgs, { signal: this.turnAbort?.signal });
            if (mcpRes.isError) {
              isError = true;
            }
            resultText = extractToolText(mcpRes);
            summary = `MCP: ${resultText.length} chars returned`;
          }
        } catch (err: any) {
          isError = true;
          const message = err?.message ?? String(err);
          // -32601 is JSON-RPC's MethodNotFound. We hit it most often when
          // the LLM hallucinates a tool name — typically a skill name
          // ("incremental-implementation", "spec-driven", "...-skill") that
          // it has confused for an invocable tool. Surface a correction so
          // the next iteration self-corrects instead of retrying garbage.
          const denial = classifyDenial(message);
          if (/-32601|Unknown tool|MethodNotFound/i.test(message)) {
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
        callbacks.onToolEnd(name, { success: !isError, summary: finalSummary, preview }, tc.id);
        traceEvent('brainrouter.tool', {
          tool: name,
          ok: !isError,
          local: isLocal,
          session_key: this.sessionKey,
        }, { traceId: turnSpan.traceId, parentSpanId: turnSpan.spanId });
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
            callbacks.onToolEnd(name, { success: false, summary: 'turn interrupted — tool skipped' }, tc.id);
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
    if (!exitedCleanly) {
      this.lastTurnHitLoopLimit = true;
      finalAnswer = buildBudgetCeilingMessage(maxLoops);
    } else if (!finalAnswer.trim()) {
      if (this.lastGoalTransition && this.lastTurnToolCalls > 0) {
        // The model fired goal_complete / goal_blocked but skipped the
        // user-visible prose summary in the same response. Without this
        // branch the user saw "Tool calls completed (N)..." and the proof
        // string was buried in goal.json — invisible to them. Surface the
        // proof/reason directly so the work isn't wasted, and warn that
        // the model should have written a real answer.
        const goal = readGoal(this.workspaceRoot, this.sessionKey);
        const evidence = goal?.blockedReason?.trim() || '(no detail recorded)';
        const action = this.lastGoalTransition === 'complete' ? 'completed' : 'blocked';
        const field = this.lastGoalTransition === 'complete' ? 'proof' : 'reason';
        finalAnswer =
          `Goal ${action} after ${this.lastTurnToolCalls} tool call${this.lastTurnToolCalls === 1 ? '' : 's'}, ` +
          `but the model skipped writing a user-visible answer in this turn.\n\n` +
          `Recorded ${field}:\n${evidence}\n\n` +
          `(If you wanted a full analysis/report, ask "summarize what you just analyzed" — the work is in memory.)`;
      } else {
        finalAnswer = this.lastTurnToolCalls > 0
          ? `Tool calls completed (${this.lastTurnToolCalls}) and the model returned no additional commentary.`
          : 'The model returned an empty response.';
      }
    }
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
  }
