import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
// 0.3.7 — Agent now talks to a Pool of MCP servers. The Pool's public
// surface matches McpClientWrapper's (listTools / callTool / isConnected /
// getIdentity / getServerName / close), so existing call sites stay
// unchanged. Single-server setups become a degenerate pool of one.
import type { McpClientPool as McpClientWrapper } from '../mcp/mcpPool.js';
import { NoTTYError, HEADLESS_PROMPTER, type InteractivePrompter } from './support/prompter.js';
import type { LLMConfig } from '../config/config.js';
import { getCliKnobs, isRemoteBrainUrl } from '../config/config.js';
import type { ComputerUsePort } from '@kinqs/brainrouter-agent-protocol';
import { browserUseAvailableFor, type BrowserControlPort } from '../browser/control.js';
import { appendTranscriptEntry, isInternalSessionKey, redactText, readTranscriptEntries } from '../session/transcript/sessionStore.js';
import { recordFileMutation } from '../storage/fileSnapshotStore.js';
import { isConnectivityError, isRetryableServerError } from '../storage/checkpointStore.js';
import { reconnectBackoffMs, probeConnectivity, parseRetryAfterMs } from '../mcp/reconnect/reconnect.js';
import { unsynthesizedChildIds, mergePendingChildIds, buildPendingChildStatusHint } from '../util/agentloop/childResume.js';
import { isChildSynthesisTool, resultHasChildOutput, looksLikeChildSynthesisPunt } from '../util/agentloop/synthesisGuard.js';
import { sanitizeModelArtifacts } from '../util/agentloop/outputSanitize.js';
import { buildPromptLayers, buildSystemPrompt, loadWorkspaceInstructionSummary, type PromptLayers } from '../prompt/systemPrompt.js';
import {
  buildAnthropicMessagesPayload, normalizeAnthropicOutput, ANTHROPIC_DEFAULT_MAX_TOKENS,
  buildGeminiGeneratePayload, normalizeGeminiOutput, nativeRequestSpec,
  type NativeBuildInput, type NativeOutput, type NativeRequestFormat,
} from './transport/nativeProviders.js';
import { formatPlan, readPlan, updatePlan, type PlanState } from '../task/taskStore.js';
import { createRequirement, getRequirement, linkRequirement, listRequirements, updateRequirement } from '../requirement/records/requirementStore.js';
import { detectRequirementShapedPrompt } from '../requirement/records/requirementDetector.js';
import { syncRequirementPlanTrack } from '../requirement/sync/planTrackSync.js';
import { reconcileSessionSprints } from '../track/automation/index.js';
import {
  ensureProject as trackEnsureProject,
  getProject as trackGetProject,
  listWorkItems as trackListWorkItems,
  findWorkItemsByCodeLink as trackFindWorkItemsByCodeLink,
  getWorkItem as trackGetWorkItem,
  createWorkItem as trackCreateWorkItem,
  transitionWorkItem as trackTransitionWorkItem,
  updateWorkItem as trackUpdateWorkItem,
  addComment as trackAddComment,
  linkWorkItem as trackLinkWorkItem,
  createSprint as trackCreateSprint,
  listSprints as trackListSprints,
  setSprintState as trackSetSprintState,
  updateSprint as trackUpdateSprint,
  sprintVelocity as trackSprintVelocity,
} from '../track/trackStore.js';
import { parseTrackQuery } from '../track/query/index.js';
import { createArtifact, updateArtifact, getArtifact, linkArtifact } from '../artifact/artifactStore.js';
// Connectors — agent-callable list/run parity (ingest → memory). The runtime
// switch + full orchestration live in core's shared runner; the agent supplies
// only a static-token GitHub client (no keychain) + its own MCP client for the
// `mcp` source, then imports the resulting docs via `memory_import`.
import {
  listConnectors,
  runConnectorCheckpointCore,
  exportConnectorDocumentsForMemory,
  githubTokenClient,
  defaultEnvTokenResolver,
  type McpConnectorClient,
  type McpConnectorResource,
} from '../connectors/index.js';
import { isArtifactKind, isArtifactFormat, isCodeLinkKind, isWorkItemType, isWorkItemPriority, isTerminalCategory, isUnstartedCategory, type ArtifactKind, type ArtifactFormat, type ArtifactRecord } from '@kinqs/brainrouter-types';
// Auto mode (fast + proceed) has no approval prompt, so the plan history would
// otherwise never record that a plan was acted on. When the agent establishes a
// new plan version under auto mode we record an `actor: 'auto'` approval so the
// history stays complete + consistent with explicit approvals.
import { recordPlanDecision, readPlanHistory, linkPlanDecision, planStepSignature } from '../task/planHistoryStore.js';
import type { AccessMode } from '../orchestration/roles/roles.js';
import {
  executeOrchestrationTool,
  isOrchestrationToolName,
  synthesizeDelegateTools,
  childAgentsFor,
  type OrchestrationContext,
} from '../orchestration/tools.js';
import { getSession } from '../orchestration/session/orchestrator.js';
import { emitAgentEvent, emitArtifactCapture } from '../memory/memoryEvents.js';
import { listAll as listAgentDefinitions } from '../orchestration/agents/agentRegistry.js';
import { ownershipWriteViolation } from '../orchestration/ownership/ownership.js';
// REFAC-APPLY-PATCH-MODULE (0.4.6) — workspace-fs primitives + apply_patch live
// in their own modules now; imported here and re-exported below for back-compat.
import { IGNORED_DIRS, isPathInside, resolveWorkspacePath, matchGlob, globFiles, grepSearch } from './fs/workspaceFs.js';
import { applyPatchEnvelope, assessPatchSafety, parsePatchEnvelope } from './fs/applyPatch.js';
export { isPathInside, resolveWorkspacePath, matchGlob, globFiles } from './fs/workspaceFs.js';
export { applyPatchEnvelope } from './fs/applyPatch.js';
import { normalizeToolName } from '../tool/specs/names.js';
import { registryAllowedTools, registryEntry } from '../tool/registry/registry.js';
import { searchMcpCatalog } from '../mcp/discovery/discovery.js';
import { appendEvidence, setQuestion, readLedger } from '../research/researchStore.js';
import { summarizeLedger, formatBrief } from '../research/evidenceLedger.js';
import { localToolExecutor, type OrchestrationRuntimePort, type ToolLifecycleRuntimePort } from '../tool/registry/executors.js';
import { assessMcpToolApproval } from './guards/mcpApproval.js';
export { normalizeToolName } from '../tool/specs/names.js';
import { applyToolScope, rankAndCapTools } from '../tool/policy/toolBudget.js';
import { resolveToolVisible } from '../tool/policy/toolPolicy.js';
import { buildDefaultSourcePlan, buildMemoryBriefing, describeSourcePlan, selectCitedRecordIds, type RecalledRecord } from '../memory/briefing.js';
import { assessCapturePayload } from '../memory/memoryPolicy.js';
import {
  countEntityTokens as countEntityTokensFromText,
  decideMemoryBriefing,
  resolveRecallMode as resolveRecallModeFromEnv,
  type BriefingDecision,
} from '../memory/briefingTriggers.js';
import { callMcpTool, extractToolText } from '../mcp/mcpUtils.js';
import { applyFederationIdentity } from '../util/agentloop/federationIdentity.js';
import { acquireLLMSlot } from '../util/concurrency/llmSemaphore.js';
import { blockGoal, completeGoal, formatGoalBlock, readGoal } from '../goal/store/goalStore.js';
import { runHooks, parseHookDecision } from '../hooks/hooksStore.js';
import { extensionHookHandlers, requiredExtensionToolNames } from '../extension/registry.js';
import { resolveSandboxConfig, runShell } from '../exec/runtime/sandbox.js';
import { buildRunCommandPrompt, isDangerousCommand, resolveRunCommandApproval } from '../exec/guard/dangerousCommand.js';
import { evaluateDestructiveCommand } from '../exec/guard/destructiveCommandGuard.js';
import { gitHeadSha } from '../git/workspaceGit.js';
import { recordDailyUsage } from '../usage/usageHistoryStore.js';
import { isTelemetryEnabled } from '../telemetry/recorder/telemetry.js';
import { readPreferences, resolveEffort, type EffortLevel } from '../session/preferences/preferencesStore.js';
import { resolveActiveMode } from '../session/state/sessionModeStore.js';
import { resolveEffortForTurn } from './support/effortRouting.js';
// 0.3.9 — Anthropic native adapter removed (the /v1/messages path landed in
// 0.3.8 but never delivered enough cache-hit headroom or stability to justify
// the second provider dispatch). Anthropic models can still be reached through
// OpenAI-compatible gateways (OpenRouter, Together, etc.) on the OpenAI path.
import { startSpan, traceEvent } from '../telemetry/tracing/tracing.js';
// 0.3.9 item 8 — cache-first context regions. The helper here lets us
// fingerprint the cache-stable slice of every outbound chat request
// without rewriting the legacy runTurn message plumbing.
import { computePrefixFingerprint, computePrefixComponents, accumulatePrefixStability, newPrefixStabilityTally, prefixStabilityRatio, type PrefixComponents, type PrefixStabilityTally } from '../context/contextRegions.js';
import { contextWindowForBudget } from '../context/contextWindow.js';
import { decideExecutionPolicy, resolveToolPolicy, externalDirectoryDecision, egressDecision, type ActionKind, type PolicyDecision } from '../exec/policy/execPolicy.js';
import { isPathWithinRoots } from '../exec/policy/pathPolicy.js';
import { runPostEditCheck } from '../util/agentloop/postEditCheck.js';
import { shouldReindex, reindexSignature, languageHint, type ReindexGate } from '../util/indexing/autoReindex.js';
import { gitChurnSignal } from '../git/gitChurn.js';
// MAS-P5-T2: progressive result handoff — large tool results become a
// preview + resultRef the model expands via extract_result.
import { ResultCache, makeResultHandoff, formatHandoffForModel, attachCompactedResultHandoff } from '../util/result/resultHandoff.js';
import { runExtractResult } from '../tool/result/extractResult.js';
// MAS-P5-T3 part 2: persistent worker threads.
import { readWorkerMeta, readWorkerSummary, closeWorker, canSpawnWorker } from '../worker/workerStore.js';
import { drainCompletions, acknowledgeCompletions, formatCompletionFeedback } from '../session/completion/completionInbox.js';
import { classifyDeferral, buildDeliverableCorrection } from './guards/deliverableCheck.js';
import { classifyDenial, formatDenialResult } from './guards/denialMessage.js';
import { evaluatePermissionRules, primaryArgText } from '../exec/policy/permissionRules.js';
import { shouldNudgeTaskTracking, buildTaskTrackingNudge } from './guards/taskTrackingNudge.js';
import { truncateFullRead } from './fs/readTruncation.js';
import { waitUntilCondition } from '../util/agentloop/waitUntil.js';
import { startBackgroundShell, readBackgroundOutput } from '../exec/runtime/backgroundShell.js';
import { CHAPTER_ENTRY_NAME, chapterEntryContent } from '../session/transcript/chapterMarks.js';
import { classifyForVerification, commandWritesFiles, decideVerification, buildVerificationNudge, buildDocsOnlyVerificationNote } from './guards/verificationGate.js';
import { resolveToolBudget, isBudgetCheckpoint, buildBudgetCheckpoint, buildBudgetCeilingMessage } from './guards/turnBudget.js';
import { getCurrentWorkflow } from '../workflow/run/workflowArtifacts.js';
import { advanceRunStep, summarizeRun } from '../workflow/run/workflowRun.js';
import { spawnWorkerThread, waitWorker } from '../orchestration/agents/workerTools.js';
// PARITY-E3: runtime model fallback on model-not-found.
import { isModelNotFoundError, shouldFallbackModel } from '../provider/modelFallback.js';
import { resolveLocalModelProfile, localModelProfileActive, isLocalModelCoreTool } from '../provider/modelFamily.js';
// 0.3.9 item 10 — provider-normalised cache-hit accounting.
import { extractCacheStats } from '../util/tokens/cacheStats.js';
// 0.3.9 item 11 — tool-call repair pipeline (flatten / scavenge /
// truncation / storm).
import { ToolCallRepair, type RepairReport } from './repair/index.js';
import { analyzeSchema, flattenSchema, nestArguments, type JSONSchema } from './repair/flatten.js';
// 0.3.9 token-tally rework: content-aware estimator. The compaction
// threshold itself stays a single `BRAINROUTER_AUTO_COMPACT_TOKENS`
// absolute knob — the model's max context window isn't a good driver
// because hitting 75% of a 1M-context model still costs real money,
// and the user might want to compact much earlier.
import {
  estimateTokens as estimateTokensContentAware,
  estimateChatHistoryTokens,
} from '../util/tokens/tokenEstimate.js';
// 0.3.9 item 12 — turn-end tool-result auto-shrink.
import { shrinkOversizedToolResults } from './guards/turnEndShrink.js';
// 0.3.9 item 13 — model-tier self-escalation.
import { currentTier, detectNeedsHigh, nextTier, resolveTierLadder, stripNeedsHigh } from '../provider/tierLadder.js';
import { PROVIDER_REGISTRY, findProviderByEndpoint, isLoopbackEndpoint, LOCAL_PLACEHOLDER_KEY, normalizeProviderEndpoint, withApiVersion } from '../provider/providers/index.js';
import { DEFAULT_EFFORT_VALUE_MAP } from '../provider/providers/definition.js';
import type { ProviderDefinition } from '../provider/providers/definition.js';
import { normalizeModelName, isReasoningModel, isNonReasoningChatModel, isAlwaysOnReasoner, modelSupportsXhighEffort, isBinaryReasoningModel } from '../provider/models/reasoning.js';
import { isSequenceGuardExempt, buildSequenceSignature } from './guards/repeatGuard.js';
// 0.3.9 item 9 — prefix-pinned memory briefing policy.
import {
  decideAnchorAction,
  hashBriefingContent,
  wrapMidSessionRefresh,
} from '../memory/anchorPin.js';
import { buildHookifyContext, evaluateHookify, listHookifyRules } from '../hooks/hookifyStore.js';
import { renderCompactSystemMessage, runCompaction } from '../prompt/compaction/compactor.js';
import { compactToolOutput } from '../prompt/compaction/toolCompaction.js';
import { appendVerbositySteering } from '../prompt/steering/verbositySteering.js';
import { buildFanOutHint, shouldSuggestFanOut } from '../prompt/planning/breadthHint.js';
import { buildNextActionMessages, parseNextActionPlan, nextActionDirective, planWantsFanOut, shouldSkipPlanner } from '../prompt/planning/nextAction.js';
import { isParallelSafe, parallelExecutionEnabled } from './guards/toolSafety.js';
import { shouldRunFanOutFollowThroughGuard } from './guards/fanOutFollowThroughGuard.js';
import {
  dedupeToolCalls,
  parseArgumentsOrError,
  synthesizeOrphanResults,
  sanitizeToolCallPairing,
  suggestSimilarToolName,
  looksLikeStalledPreamble,
  looksLikeDeferredToolPromise,
  mentionsImminentToolWork,
} from './guards/toolCallRecovery.js';
import { fetchAndExtract } from '../websearch/crawler.js';
import { buildSearchProvider } from '../websearch/factory.js';
import { evaluateDestructiveAction, isComputerActionMutating, validateComputerAction } from './fs/computerUse.js';

const execPromise = promisify(exec);
const DEFAULT_CHILD_DRAIN_TIMEOUT_MS = 30_000;
const MAX_COMPUTER_ACTIONS_PER_TURN = 20;

// Child-agent observation helpers moved to ./childObservation.ts (god-file
// breakdown). Imported back for the Agent turn loop.
import {
  parseJsonObject,
  trackChildObservation,
  parseChildDrainTimeouts,
  formatChildDrainTimeoutAnswer,
  summarizeWaitedChildOutputs,
} from './support/childObservation.js';
// Tool-result presentation + LLM transport layers moved to sibling modules
// (god-file breakdown). Imported back for the Agent class's own use; the public
// re-exports live further down so agent.ts's surface stays unchanged.
import { getToolSummary, getToolPreview } from './support/toolSummary.js';
import {
  activeProviderDef,
  effortForTurnSelection,
  callOpenAI,
  callOpenAIStream,
  InterruptError,
  isInterrupt,
  abortableDelay,
  appendDeveloperPromptLayer,
} from './transport/llmTransport.js';
// Giant turn-loop body stays behind the Agent facade. Tool handlers are owned
// by required capability extensions and enter through an internal-only port.
import { runTurn as runTurnImpl } from './runtime/runTurn.impl.js';
import { invokeBuiltinToolRuntime } from '../extension/builtin/runtime.js';
import {
  bootstrapSession as bootstrapSessionImpl,
  ensureInitialized as ensureInitializedImpl,
  createSystemMessage as createSystemMessageImpl,
  hookEnforceActive as hookEnforceActiveImpl,
  hookAdvisoryActive as hookAdvisoryActiveImpl,
  hookNotifyActive as hookNotifyActiveImpl,
  runExtensionHooks as runExtensionHooksImpl,
  autoCaptureRequirement as autoCaptureRequirementImpl,
  autoSynchronizeRequirementPlanTrack as autoSynchronizeRequirementPlanTrackImpl,
  autoSynchronizeSprints as autoSynchronizeSprintsImpl,
  autoReconcileGoalCompletion as autoReconcileGoalCompletionImpl,
  applyTrackCodeSignalAutomation as applyTrackCodeSignalAutomationImpl,
  autoLinkDoneTrackItem as autoLinkDoneTrackItemImpl,
  captureTrackAutomationEvent as captureTrackAutomationEventImpl,
  injectRecallContext as injectRecallContextImpl,
} from './runtime/lifecycle.impl.js';
import {
  compactHistory as compactHistoryImpl,
  requestInterrupt as requestInterruptImpl,
  setModel as setModelImpl,
  getModel as getModelImpl,
  getCurrentContextTokens as getCurrentContextTokensImpl,
  getPrefixComponents as getPrefixComponentsImpl,
  recordPrefixStability as recordPrefixStabilityImpl,
  getPrefixStability as getPrefixStabilityImpl,
  spawnBackgroundWorker as spawnBackgroundWorkerImpl,
  getRepairTotals as getRepairTotalsImpl,
  getOffloadTotals as getOffloadTotalsImpl,
  maybeAutoApprovePlan as maybeAutoApprovePlanImpl,
  captureFileSnapshot as captureFileSnapshotImpl,
  maybeReindexSource as maybeReindexSourceImpl,
  getLlmConfig as getLlmConfigImpl,
  setLLMConfig as setLLMConfigImpl,
  replaceLLMConfig as replaceLLMConfigImpl,
  getLLMConfig as getLLMConfigImpl,
  getAccessMode as getAccessModeImpl,
  setAccessMode as setAccessModeImpl,
  getPolicyAudit as getPolicyAuditImpl,
  loadHistory as loadHistoryImpl,
} from './runtime/session.impl.js';

export interface RunTurnCallbacks {
  onStatusUpdate: (status: string) => void;
  /**
   * Optional: a PERSISTENT turn-scoped notice the agent wants on the record
   * (unlike `onStatusUpdate`, which is a transient status line). Used to surface
   * provider-side truncation (`finish_reason: 'length'`) → "raise
   * cli.maxOutputTokens". The REPL/host render it as a durable row.
   */
  onNotice?: (notice: { level: 'info' | 'warn'; message: string }) => void;
  // POLISH-1 (0.4.13) — `callId` (the LLM tool_call id) lets the REPL pair each
  // result with its OWN start row; parallel same-name calls no longer collide on a
  // name-keyed map. Optional → existing callers are unaffected.
  onToolStart: (name: string, args: Record<string, any>, callId?: string) => void;
  onToolEnd: (name: string, result: { success: boolean; summary: string; preview?: string }, callId?: string) => void;
  /**
   * Optional: invoked whenever the agent calls update_plan during a turn,
   * so the REPL can render a live ✓ / ⏳ / ☐ checklist instead of leaving the
   * plan invisible until the user runs `/plan`.
   */
  onPlanUpdate?: (items: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>, explanation?: string) => void;
  /**
   * Optional: invoked when a child agent (spawn_agent) finishes its runTurn —
   * either succeeded with a final answer (preview supplied) or failed (error
   * supplied). Lets the REPL signal "Agent X is done" so the user isn't
   * staring at silence after the tool stream stops.
   */
  onChildComplete?: (event: { childId: string; role: string; status: 'completed' | 'failed'; preview?: string; error?: string; worktree?: { changedFiles?: number; applied?: boolean; patchPath?: string; applyError?: string } }) => void;
  /**
   * Optional: paired live child tool events surfaced from spawn_agent
   * children up to the parent REPL. Lets the UI render explicit
   * "child began Read(...)" / "child finished — 1.2s" rows in scrollback
   * so long child runs no longer look like the parent has paused
   * (roadmap §3 child progress visibility).
   */
  onChildToolStart?: (event: { childId: string; role: string; tool: string; args: Record<string, any> }) => void;
  onChildToolEnd?: (event: { childId: string; role: string; tool: string; ok: boolean; summary: string; preview?: string; durationMs: number }) => void;
  /**
   * Optional: invoked when the agent's automatic memory pipeline runs —
   * pre-turn briefing, post-turn capture, citation marking. Surfacing these
   * tells the user the BrainRouter cognitive memory engine is active even
   * though those MCP calls are hidden from the LLM's tool stream.
   */
  onMemoryEvent?: (event: MemoryEvent) => void;
  /**
   * TIER A streaming hooks — when any of these are provided, the agent
   * switches to a streaming LLM call (SSE) so the UI sees text appear
   * character-by-character. When omitted (silent /
   * child agents / tests), the original non-streaming path is used.
   * Firing order per assistant turn:
   *   onAssistantTurnStart → onAssistantDelta* (and/or onReasoningDelta*)
   *   → onAssistantTurnEnd(finalText)
   * onReasoningDelta carries chain-of-thought / reasoning_content chunks
   * — UI should render in dim italic and truncate per its own policy.
   */
  onAssistantTurnStart?: () => void;
  onAssistantDelta?: (chunk: string) => void;
  onAssistantTurnEnd?: (fullText: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  /**
   * Fired right after a compaction collapses chat history. The UI uses
   * this to render a visible "📦 Compacted N → summary" scrollback row
   * so users see why context appears to reset mid-conversation.
   */
  onCompactionEvent?: (event: { droppedMessages: number; keptMessages: number; summary: string }) => void;
  /**
   * Side-question: when set, the agent registers an `ask_user` tool. When
   * the model invokes it mid-turn, the agent calls this callback and
   * awaits the user's answer (resolved by the UI overlay) before
   * returning the answer as the tool result. Silent / child agents leave
   * this unset so the tool is not exposed.
   */
  onSideQuestion?: (question: string, choices?: string[]) => Promise<string>;
  /**
   * HEADLESS-EVENTS (0.4.5) — exec-policy decision for a mutating tool
   * (allow / ask / deny), fired at the dispatch gate. Lets headless consumers
   * see what the policy let through or blocked.
   */
  onApproval?: (event: { tool: string; action: string; decision: 'allow' | 'ask' | 'deny'; reason?: string }) => void;
  /**
   * HEADLESS-EVENTS (0.4.5) — running token tally, fired after each LLM call
   * accrues usage. Carries the cumulative turn totals so consumers can render
   * a live cost ticker without waiting for turn_end.
   */
  onUsageUpdate?: (usage: { promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number; missedTokens?: number }) => void;
  /**
   * HEADLESS-EVENTS (0.4.5) — the code index was refreshed for a file
   * (CLI-REINDEX), fired from the file read/edit paths when content drifted.
   */
  onCodeIndex?: (event: { file: string; chunks: number }) => void;
}

export type MemoryEvent =
  | {
      kind: 'briefing';
      sources: string[];
      recordCount: number;
      /** The actual recalled records so the UI can show WHAT was injected, not just a count. */
      records: Array<{ id: string; type?: string; priority?: number; content?: string; source?: string; score?: number }>;
    }
  | {
      kind: 'capture';
      sessionKey: string;
      messageCount: number;
      /** Number of sensory rows the MCP server wrote (raw conversation log). */
      sensoryRecorded?: number;
      /** True iff cognitive extraction was attempted this turn (may still have failed). */
      extractionTriggered?: boolean;
      /** Number of cognitive records produced — 0 indicates extraction is silently broken. */
      extractedCount?: number;
      /** Set when the extractor reports it couldn't reach the LLM. */
      extractionWarning?: string;
    }
  | { kind: 'citation'; recordIds: string[] }
  | { kind: 'contradiction'; warning: string }
  | { kind: 'skipped'; reason: string };

export interface LastBriefingDetails {
  decision: BriefingDecision['action'] | 'none';
  reasons: string[];
  sources: string[];
  sourcesPlanned: string[];
  skippedSources: Array<{ source: string; reason: string }>;
  sourceStats: Array<{ source: string; chars: number; records: number }>;
  recordIds: string[];
  recordCount: number;
  tokensInjected: number;
  charsSaved: number;
  warnings: string[];
  /**
   * MAS-P2-M3 — first ~500 chars of the rendered briefing block so
   * `ParentExecutionContextSnapshot` can carry an excerpt without
   * holding the full block in memory between turns.
   */
  blockExcerpt?: string;
}

// LLM payload types moved to ./llmTransport.ts (god-file breakdown).
// ChatCompletionPayload / ResponsesPayload were public exports of agent.ts —
// re-export them to keep the surface. PromptLayeredMessage was module-private;
// import it back for the one class use below.
export type { ChatCompletionPayload, ResponsesPayload } from './transport/llmTransport.js';
import type { PromptLayeredMessage } from './transport/llmTransport.js';

export interface AgentOptions {
  workspaceRoot: string;
  launchCwd: string;
  sessionKey?: string;
  roleOverlay?: string;
  accessMode?: AccessMode;
  silent?: boolean;
  /**
   * HONK-H0 — fleet/background executor: force the sandbox + network-deny +
   * secret-env scrubbing on, un-opt-out-able by `cli.sandboxEnforceWhenSilent`.
   */
  forceFleetSandbox?: boolean;
  /** Pentest turns route every shell command through the Docker/proxy perimeter. */
  pentestMode?: boolean;
  /** Job-local pentest perimeter. Supplying this avoids process-global env
   * mutation when several organizations scan concurrently. */
  pentestSandbox?: { image: string; network: string; proxyUrl: string };
  /** Job-local proxy control plane for list/view/repeat/sitemap tools. */
  pentestProxyApiUrl?: string;
  /** Per-session bearer token the proxy control plane requires (defense against
   * another host-local process reaching the loopback control API). */
  pentestProxyToken?: string;
  /** Optional per-agent spend ceiling. Unattended jobs use this instead of the
   * interactive CLI's process-wide budget knobs. */
  taskBudgetCaps?: { maxPerTaskUSD: number; maxPerTaskTokens: number };
  systemPromptOverride?: string;
  /** When true (default for silent children: false), pre-turn memory recall runs even in silent mode. */
  enableRecall?: boolean;
  /**
   * Parent OTEL trace context. Set by `spawn_agent` so the child's per-turn
   * spans nest under the parent's `brainrouter.turn` span. Without this each
   * child started a fresh trace tree and fan-out runs flattened in trace
   * viewers — you couldn't see "this child belongs to that parent turn".
   */
  parentTraceId?: string;
  parentSpanId?: string;
  /** Agent tier — propagated from the definition so hierarchy checks work in grandchildren. */
  tier?: 'chat' | 'reasoning' | 'worker';
  /** Nesting depth in the spawn chain; 0 = direct child of the chat root (default). */
  agentDepth?: number;
  /**
   * MAS-P3 ownership glob (e.g. `src/feature/**`). When set, this agent's
   * file writes (`write_file` / `edit_file` / `apply_patch`) are refused
   * outside the glob. Set by `spawn_agents` for parallel write-children so
   * they can't collide; null/undefined = no boundary (the chat root).
   */
  ownership?: string | null;
  /**
   * MAS-P4-T1 — per-agent tool scoping from the agent definition. When set,
   * the child only sees MCP tools allowed by `toolScope.mcp` (minus
   * `disallowedTools`). Omitted = no scope filter (sees the full catalog,
   * still subject to the budget cap).
   */
  toolScope?: { local: string[]; mcp: string[] };
  disallowedTools?: string[];
  /**
   * 0.4.x-5 — per-child reasoning-effort override. When set, the child uses
   * this instead of the session-resolved `/effort` for its turns.
   */
  effortOverride?: EffortLevel;
  /**
   * CODEX-PARENT-APPROVAL — silent children cannot own terminal prompts. When
   * set, shell approval requests that would otherwise fail closed are forwarded
   * to the parent agent/UI for a decision.
   */
  /**
   * DESK-3 — injectable human-decision port. When set (the Desktop agent
   * host), approval prompts and ask_user_choice render as UI dialogs instead
   * of readline prompts; when unset the CLI's readline behavior is unchanged.
   * Dismissals fail CLOSED (deny / "decide yourself"), never hang a turn.
   */
  interactionPort?: {
    confirm(req: { title: string; detail?: string; dangerous?: boolean; tool?: string }): Promise<boolean>;
    choice(req: { question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect?: boolean }): Promise<string[] | null>;
  };
  /** Desktop-only native computer control capability. Omitted in CLI/headless runtimes. */
  computerUsePort?: ComputerUsePort;
  /** Desktop-only control of this window's embedded browser. Omitted everywhere else. */
  browserControlPort?: BrowserControlPort;
  /**
   * §ADR-003 — the interactive prompt surface (TTY yes/no + choice picker).
   * The CLI injects its readline/ink-backed prompter; headless hosts (Desktop,
   * children, tests) omit it and get {@link HEADLESS_PROMPTER}, which refuses
   * with NoTTYError exactly like the old direct cliPrompt calls did with no TTY.
   */
  prompter?: InteractivePrompter;
  confirmToolApproval?: (info: { tool: string; command?: string; path?: string; summary?: string; reason: string; dangerous?: boolean; arguments?: Record<string, unknown> }) => Promise<boolean>;
  /**
   * DESK-5n — the PARENT session's review stance, threaded into a silent
   * child so its write/edit/patch gate can honor "Auto mode" the same way the
   * parent's own gates do. A silent child may run in an isolated worktree
   * whose local prefs diverge, so the authoritative "is the user in Auto mode"
   * signal is the parent's, passed at spawn time — not the child's own
   * readPreferences. Unset on the user-facing parent (its gates read prefs
   * directly), so omitting these keeps existing behavior unchanged.
   */
  parentReviewPolicy?: 'request' | 'proceed';
  parentExecutionMode?: 'planning' | 'fast';
}


/**
 * @deprecated Prefer passing an explicit workspaceRoot. Returns process.cwd()
 * which is brittle when the Agent was constructed with a workspace different
 * from cwd (e.g. when /resume re-attaches a session originally captured in
 * another dir, or when the user cd's away after launch).
 */
export function getWorkspaceRoot(): string {
  return fs.realpathSync(process.cwd());
}

/**
 * Best-effort guidance for the LLM when it calls a tool name that doesn't
 * exist (JSON-RPC -32601). The most common cause is confusing a BrainRouter
 * skill (documentation) for an invocable tool. Pattern-match on the name and
 * return a corrective hint that the next agent turn will see as the tool
 * result.
 */
/**
 * Normalize each tool_call's `function.arguments` to a VALID JSON object string
 * before it enters chat history. Some weaker models (and complex tools like
 * `run_workflow`) emit malformed or truncated args; left as-is, the NEXT request's
 * assistant message fails provider validation — "400 Bad Request: invalid
 * function arguments json string" — which kills the turn. The tool still EXECUTES
 * from the ORIGINAL args (so a malformed call surfaces its parse error to the
 * model via the paired tool_result); only the HISTORY copy is sanitized to keep
 * the conversation API-valid. Returns a fresh array — the originals are untouched.
 */
export function sanitizeToolCallsForHistory(calls: any[]): any[] {
  return (calls ?? []).map((c) => {
    const fn = c?.function ?? {};
    let argStr: string;
    if (typeof fn.arguments === 'string') argStr = fn.arguments;
    else if (fn.arguments == null) argStr = '{}';
    else { try { argStr = JSON.stringify(fn.arguments); } catch { argStr = '{}'; } }
    // The OpenAI tool schema wants arguments to be a JSON OBJECT string. If it
    // doesn't parse to a plain object, fall back to '{}' — the paired tool_result
    // already tells the model the args were malformed, so it can retry cleanly.
    try {
      const v = JSON.parse(argStr);
      argStr = v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : '{}';
    } catch {
      argStr = '{}';
    }
    return { ...c, function: { ...fn, arguments: argStr } };
  });
}

export function explainUnknownToolName(name: string): string {
  const trimmed = (name ?? '').trim();
  const lower = trimmed.toLowerCase();
  const looksLikeSkill =
    lower.endsWith('-skill') ||
    /(implementation|workflow|driven|generator|recovery|cleanup|simplification)$/i.test(lower) ||
    /skill$/i.test(lower);
  if (looksLikeSkill) {
    return (
      'It looks like you tried to invoke a SKILL as if it were a tool. ' +
      'Skills are markdown documentation packages, not invocable functions. ' +
      'To use one: call `list_skills({ scope: "all" })` to find the canonical name, ' +
      `then \`get_skill({ name: "${trimmed}" })\` (or the closest match) to load its instructions, ` +
      'and then follow the steps yourself with the regular tools (read_file, write_file, run_command, spawn_agent, …).'
    );
  }
  return (
    'Verify the tool name by inspecting the tool list that was attached at turn start. ' +
    'If you intended a skill (documentation/workflow), load it via `get_skill` first; ' +
    'skills are not directly callable.'
  );
}


export class Agent {
  public mcpClient: McpClientWrapper;
  public llmConfig: LLMConfig;
  /** CLI-REINDEX — per-path stat signature of the last reindex, so unchanged
   *  files don't re-ship content to memory_reindex_source on every read. */
  public reindexSignatures = new Map<string, string>();
  /** HEADLESS-EVENTS — per-turn listener for code-index refreshes, set from
   *  RunTurnCallbacks.onCodeIndex at the top of runTurn (executeLocalTool has
   *  no callbacks param, so we bridge through the instance). */
  public codeIndexListener: ((e: { file: string; chunks: number }) => void) | null = null;
  public sessionKey: string;
  /**
   * Federation Stage 3 — the per-process key the `attachFederation`
   * runtime registered against the brain. Used by `/dm` and
   * `/broadcast` so the recipient sees the sender's federation
   * identity (which appears in `/agents --remote`) rather than the
   * agent's per-chat sessionKey (which rotates per `/new`).
   */
  public federationSessionKey: string | null = null;
  public setFederationSessionKey(key: string | null): void {
    this.federationSessionKey = key;
  }
  public getFederationSessionKey(): string | null {
    return this.federationSessionKey;
  }
  public workspaceRoot: string;
  public launchCwd: string;
  public chatHistory: any[] = [];
  /** MAS-P5-T2: per-session cache of full tool results, keyed by resultRef. */
  // MEM-22 — retention is configurable via cli.offloadRetentionMs / cli.offloadMaxEntries.
  public readonly resultCache = new ResultCache(getCliKnobs().offloadRetentionMs, getCliKnobs().offloadMaxEntries);
  /** PARITY-E3: set once we've switched to cli.fallbackModel this turn. */
  public triedModelFallback = false;
  /** CC-CONFIG-A2: models already attempted this turn (primary + each fallback tried),
   *  so the ordered fallback chain cascades without re-trying a dead model. */
  public triedModels = new Set<string>();
  /** Provider-router v2: provider/model route slugs already attempted this turn. */
  public triedRouterRoutes = new Set<string>();
  public initialized = false;
  public recalledRecordIds: string[] = [];
  public recalledRecords: RecalledRecord[] = [];
  public lastBriefingSources: string[] = [];
  public lastBriefingDetails: LastBriefingDetails = {
    decision: 'none',
    reasons: [],
    sources: [],
    sourcesPlanned: [],
    skippedSources: [],
    sourceStats: [],
    recordIds: [],
    recordCount: 0,
    tokensInjected: 0,
    charsSaved: 0,
    warnings: [],
  };
  /**
   * 10b: latest MCP tool inventory captured by `listTools()` calls. Used by
   * `createSystemMessage` to decide whether the BrainRouter memory section
   * should render — when `memory_recall` is missing from this list (the
   * cloud brain is offline), the prompt swaps to a brain-offline notice so
   * the model doesn't try to call tools that aren't there. Undefined until
   * the first successful list; treated as "assume online" by the prompt
   * builder until then (back-compat for callers that don't list pre-turn).
   */
  public lastKnownMcpTools?: Array<{ name: string }>;
  /**
   * 0.3.9 item 9 — content hash of the currently pinned memory anchor.
   * `null` means no anchor has been pinned yet this session (or
   * /refresh-memory just cleared it). When set, subsequent briefings
   * either no-op (same hash → STABLE) or append (different hash →
   * APPEND) rather than rewriting the prefix system message.
   */
  public pinnedAnchorHash: string | null = null;
  /**
   * 0.3.9 item 11 — repair pipeline (lazy: instantiated on first use so
   * the allowed-tool-names set reflects the live MCP inventory). Reset
   * at the start of every fresh user turn via `resetStorm()` so a
   * fresh intent doesn't inherit prior repetition state.
   */
  public toolCallRepair: ToolCallRepair | null = null;
  /** 0.3.9 item 11 — last repair report, surfaced via /briefing debug. */
  public lastRepairReport: RepairReport | null = null;
  /**
   * 0.4.3 (CLI-8) — session-cumulative repair telemetry. The per-turn report
   * is reset every intent; these totals persist across the session (reset only
   * by `resetSessionCounters()`) so `/context` can show how often the
   * tool-call repair pipeline had to intervene — a health signal for the
   * model/transport pairing.
   */
  public repairTotals = { scavenged: 0, truncationsFixed: 0, truncationsUnrecoverable: 0, stormsBroken: 0, turnsWithRepair: 0 };
  /** 0.3.9 item 13 — count of NEEDS_HIGH escalations this turn, bounded so a marker loop can't churn. */
  public tierEscalationsThisTurn = 0;
  /**
   * 0.3.9 token-tally rework: most-recent authoritative `prompt_tokens`
   * from the provider's `usage` payload. The compaction trigger prefers
   * this over the content-aware estimator because the provider charged
   * us for exactly this number — no rounding, no JSON-syntax inflation,
   * no language-class bucket guesses. `undefined` on turn 1 and after a
   * successful compaction (the compact log doesn't reflect the prior
   * `prompt_tokens` value).
   */
  public lastSeenPromptTokens: number | undefined;
  /**
   * 0.4.x-3b (`/rewind --files`) — file-restore undo log state. `snapshotsThisTurn`
   * is null at turn start; on the first file mutation of a turn we lazily compute
   * `fileSnapshotTurn` (the user-turn ordinal from the transcript) and capture
   * each touched file's prior content once. See state/fileSnapshotStore.ts.
   */
  public fileSnapshotTurn = 0;
  public snapshotsThisTurn: Set<string> | null = null;
  // CC-P6.4 — resolved paths this agent has READ this session. Gates
  // edit_file / write-overwrite on a prior read so the model can't clobber a
  // file it hasn't seen (Claude Code's read-before-edit contract). Reset by
  // loadHistory / fork / bootstrapSession (see clearSessionState).
  public filesReadThisSession = new Set<string>();
  // WS5 — commits the agent itself created THIS session (process-lifetime, NOT
  // reset per turn). The destructive-command guard allows `git commit --amend`
  // only when HEAD is in this set; a resumed session starts empty, so amending a
  // pre-existing commit is blocked (fail-safe).
  public agentAuthoredCommits = new Set<string>();
  /** MAS-READMANIFEST (B2) — the files this agent has read this session, so the
   *  phase orchestrator can forward a "already mapped" manifest to later phases
   *  (a child reads deltas, not the whole tree cold). */
  public get filesRead(): string[] {
    return [...this.filesReadThisSession];
  }
  // CC-P9.2 — once-per-session task-tracking reminder latch.
  public taskTrackingNudged = false;
  // CC-P6.5 — per-turn verification gate: did the workspace get mutated, and
  // did a build/test/lint run? Reset at the top of each runTurn.
  public mutatedThisTurn = false;
  public verifiedThisTurn = false;
  // Scoping hardening — the actual files written THIS turn (edit-tool paths),
  // so the gate can tell a docs/config-only change from a code change, and an
  // opaque file-writing shell command (path unknown → can't be ruled docs-only).
  public filesWrittenThisTurn: string[] = [];
  public shellWroteThisTurn = false;
  public computerActionsThisTurn = 0;
  // DESK-2 / CC-P1.5 — cooperative turn interrupt. Set by requestInterrupt()
  // (desktop Stop button / TUI Esc); checked at every LLM-call and tool
  // boundary so a long multi-tool turn stops at the next seam instead of
  // running to completion. Reset at the top of each runTurn.
  public interruptRequested = false;
  // DESK-6 — the per-turn abort controller. requestInterrupt() aborts it, which
  // cancels the in-flight LLM fetch, running shell/MCP tools, and child waits
  // IMMEDIATELY (not at the next cooperative seam). Recreated each turn.
  public turnAbort: AbortController | null = null;
  /** The current turn's interrupt signal — threaded into LLM calls + tools. */
  public get interruptSignal(): AbortSignal | undefined { return this.turnAbort?.signal; }
  /**
   * 9b: gated recall state. `recallHasFiredThisSession` flips to true on the
   * first successful briefing injection so subsequent turns can skip the
   * fresh recall pull unless a gated trigger fires. `recallNextTurnIsPost-
   * Compaction` is set by `compactHistory()` to force the next turn through
   * the full briefing path (compaction just dropped the prior briefing as
   * collateral; replay it once so the model isn't blind). Both are
   * cleared on `loadHistory` / `fork` / `bootstrapSession` so a fresh
   * session re-pulls.
   */
  public recallHasFiredThisSession = false;
  public recallNextTurnIsPostCompaction = false;
  public turnsSinceLastFullBriefing = 0;
  public recentToolFailure?: string;
  public roleOverlay?: string;
  public accessMode: AccessMode;
  /** POLICY-1 — audit trail of execution-policy decisions on mutating tools. */
  public policyAudit: Array<{ tool: string; action: ActionKind; decision: PolicyDecision; reason: string }> = [];
  public silent: boolean;
  /**
   * CODEX-SANDBOX-UNATTENDED — captured ONCE at construction so the
   * silent-enforcement decision is stable for the whole session (knobs are
   * load-time config; this also makes the policy immune to mid-turn knob-cache
   * resets, which matters for the concurrent shared-process test runner).
   */
  public readonly sandboxEnforceWhenSilent: boolean;
  public readonly forceFleetSandbox: boolean;
  public readonly pentestMode: boolean;
  public readonly pentestSandbox?: { image: string; network: string; proxyUrl: string };
  public readonly pentestProxyApiUrl?: string;
  public readonly pentestProxyToken?: string;
  public readonly taskBudgetCaps?: { maxPerTaskUSD: number; maxPerTaskTokens: number };
  /** Proxy control-plane config for the pentest proxy tools (undefined outside a
   * pentest, which makes those tools fall back to the env-configured proxy). */
  public pentestProxyControl(): { apiUrl: string; token?: string } | undefined {
    return this.pentestProxyApiUrl ? { apiUrl: this.pentestProxyApiUrl, token: this.pentestProxyToken } : undefined;
  }
  public enableRecall: boolean;
  public systemPromptOverride?: string;
  /**
   * Name of the BrainRouter skill currently being executed (e.g. via `/skill`
   * or implicit memetic activation). Threaded into `memory_recall` and
   * `memory_capture_turn` so skill-scoped recall boost, neural-spark
   * prewarming, and per-record `skill_tag` extraction all fire correctly.
   * Null/undefined when no skill is active.
   */
  public activeSkill?: string;
  /**
   * CC-SKILLS-D3 — per-turn tool blacklist declared by the active skill's
   * `disallowed-tools` frontmatter. Merged into the same disallow path as the
   * role/agent-def `disallowedTools` for the turn the skill runs, then cleared
   * (like `activeSkill`) once the turn settles. Empty when no skill is active
   * or the active skill declares no disallowed tools.
   */
  public activeSkillDisallowedTools: string[] = [];
  /**
   * Parent trace context (set by spawn_agent for child agents). When present,
   * the per-turn span uses these as its trace/parent so OTEL viewers can
   * stitch the fan-out tree together. Top-level (REPL) agents leave these
   * undefined and get a fresh trace per turn.
   */
  public parentTraceId?: string;
  public parentSpanId?: string;
  /**
   * Synthetic agent id used in OTEL attributes so child spans can be grouped
   * even without trace links. Equals `agent-<6 random hex>` per Agent
   * instance. Surfaced as the `agent_id` / `parent_agent_id` span attrs.
   */
  public readonly agentId: string = `agent-${Math.random().toString(36).slice(2, 8)}`;
  /** agent_id of the parent (set by spawn_agent for children). */
  public parentAgentId?: string;
  /** Agent tier — forwarded to OrchestrationContext so grandchildren can inherit hierarchy checks. */
  public readonly tier?: 'chat' | 'reasoning' | 'worker';
  /** Spawn-chain depth (0 = direct chat-root child). Forwarded to hierarchy checks. */
  public readonly agentDepth: number;
  /** MAS-P3 ownership glob; file writes outside it are refused. Null = no boundary. */
  public ownership: string | null;
  /** MAS-P4-T1 per-agent tool scope (from the agent def); undefined = no filter. */
  public toolScope?: { local: string[]; mcp: string[] };
  public disallowedTools: string[];
  /** HONK-L3 — built-in tools whose schema was flattened for a local model THIS
   *  turn; their args are re-nested at dispatch via `nestArguments`. */
  public flattenedToolNames = new Set<string>();
  /** MAS-P4-T1 — MCP tools trimmed by the budget this turn (model-facing names). */
  public lastBudgetHiddenTools = new Set<string>();
  /** 0.4.x-5 — per-child reasoning-effort override; falls back to session /effort. */
  public effortOverride?: EffortLevel;
  public confirmToolApproval?: AgentOptions['confirmToolApproval'];
  public interactionPort?: AgentOptions['interactionPort'];
  public computerUsePort?: ComputerUsePort;
  public browserControlPort?: BrowserControlPort;
  // §ADR-003 — injected interactive prompter (default = headless/no-TTY stub).
  public prompter: InteractivePrompter;
  // DESK-5n — parent's review stance, for the silent-child Auto-mode bypass.
  private parentReviewPolicy?: AgentOptions['parentReviewPolicy'];
  public parentExecutionMode?: AgentOptions['parentExecutionMode'];

  constructor(mcpClient: McpClientWrapper, llmConfig: LLMConfig, options: AgentOptions) {
    this.mcpClient = mcpClient;
    this.llmConfig = llmConfig;
    this.workspaceRoot = options.workspaceRoot;
    this.launchCwd = options.launchCwd;
    // Each CLI process gets a fresh sessionKey by default. The previous
    // workspace-derived fallback (`brainrouter-cli:<workspaceRoot>`) made
    // MCP's `memory_resolve_session` fall into its workspace-cache branch
    // and return the same UUID for every CLI in the workspace, so two
    // concurrent CLIs shared one goal/plan/working bucket. A randomUUID
    // here is accepted by MCP's `isUniqueId` and echoed back as-is, so
    // each CLI is its own session for local state. The memory DB is
    // userId-scoped, so cross-CLI recall continuity is unaffected.
    this.sessionKey = options.sessionKey ?? randomUUID();
    this.roleOverlay = options.roleOverlay;
    this.accessMode = options.accessMode ?? 'shell';
    this.silent = options.silent ?? false;
    this.sandboxEnforceWhenSilent = getCliKnobs().sandboxEnforceWhenSilent;
    this.forceFleetSandbox = options.forceFleetSandbox ?? false;
    this.pentestMode = options.pentestMode ?? false;
    this.pentestSandbox = options.pentestSandbox;
    this.pentestProxyApiUrl = options.pentestProxyApiUrl;
    this.pentestProxyToken = options.pentestProxyToken;
    this.taskBudgetCaps = options.taskBudgetCaps;
    // Children default to no recall (their seed context already covers the parent's recall).
    // Parents (non-silent) always recall.
    this.enableRecall = options.enableRecall ?? !this.silent;
    this.systemPromptOverride = options.systemPromptOverride;
    this.parentTraceId = options.parentTraceId;
    this.parentSpanId = options.parentSpanId;
    this.ownership = options.ownership ?? null;
    this.toolScope = options.toolScope;
    this.disallowedTools = options.disallowedTools ?? [];
    this.effortOverride = options.effortOverride;
    this.tier = options.tier;
    this.agentDepth = options.agentDepth ?? 0;
    this.confirmToolApproval = options.confirmToolApproval;
    this.interactionPort = options.interactionPort;
    this.computerUsePort = options.computerUsePort;
    this.browserControlPort = options.browserControlPort;
    this.prompter = options.prompter ?? HEADLESS_PROMPTER;
    this.parentReviewPolicy = options.parentReviewPolicy;
    this.parentExecutionMode = options.parentExecutionMode;
  }

  /** Expose for orchestration so spawn_agent can record the parent linkage. */
  public getAgentId(): string {
    return this.agentId;
  }
  /** Internal — used by spawn_agent to record which parent dispatched us. */
  public setParentAgentId(id: string | undefined): void {
    this.parentAgentId = id;
  }

  public async confirmSilentChildToolApproval(info: {
    tool: string;
    command?: string;
    path?: string;
    summary?: string;
    reason: string;
    dangerous?: boolean;
  }): Promise<string | null> {
    if (!this.silent || !this.confirmToolApproval) return null;
    // DESK-5n — honor the parent's "Auto mode" the same way the parent honors
    // its own gates: when the user has opted into proceed-without-asking
    // (executionMode=fast + reviewPolicy=proceed, the yolo predicate at the
    // parent's ask_user_choice gate), a silent child's write/edit/patch
    // proceeds without surfacing the "Allow child-agent tool?" card. Sourced
    // from the PARENT (threaded at spawn) so an isolated-worktree child's
    // diverging local prefs can't defeat it. Dangerous patches keep the gate
    // unless the user is in full proceed — `dangerous` only short-circuits
    // under proceed, which it already satisfies here. Non-fast / request
    // modes are unchanged: the gate still asks.
    if (this.parentExecutionMode === 'fast' && this.parentReviewPolicy === 'proceed') return null;
    const approved = await this.confirmToolApproval(info);
    if (!approved) return `Tool "${info.tool}" rejected by parent approval.`;
    return null;
  }

  /**
   * WF-COST-GATE — confirm a `run_workflow` launch. A workflow fans out MANY
   * child agents and costs far more tokens than a plain `spawn_agent`/
   * `spawn_agents`, so — unlike a spawn (governed by /delegation-policy, `auto`
   * by default → silent) — launching a workflow ALWAYS asks, for the human
   * parent AND for silent children/workers, independent of /mode, /yolo, and
   * /delegation-policy. The escape hatch is `cli.confirmRunWorkflow=false`.
   *
   * Surfacing mirrors the run_command gate: a silent child routes the prompt to
   * the human-facing parent via `confirmToolApproval`; with NO approver at all
   * (deep worker / headless / CI) it PROCEEDS so non-interactive automation
   * (e.g. the build loop) isn't blocked by an unanswerable prompt.
   */
  public async confirmRunWorkflowLaunch(args: Record<string, any>): Promise<boolean> {
    if (getCliKnobs().confirmRunWorkflow === false) return true;
    // Honor a persisted "Always allow" for workflows — the approval card writes
    // `run_workflow(*)` into cli.permissions.allow, so the button actually
    // sticks across calls instead of re-asking. (A deny rule is already enforced
    // upstream by the unified cli.permissions gate before this point.)
    if (evaluatePermissionRules(getCliKnobs().permissions, 'run_workflow', primaryArgText('run_workflow', args ?? null)) === 'allow') {
      return true;
    }
    const name = typeof args?.template === 'string'
      ? args.template
      : typeof args?.name === 'string'
        ? args.name
        : '';
    const label = name ? ` "${name}"` : '';
    const reason = `running a workflow${label} fans out multiple agents and costs more tokens`;
    if (this.silent) {
      if (!this.confirmToolApproval) return true; // no human in the chain — can't ask, proceed
      return await this.confirmToolApproval({ tool: 'run_workflow', reason, dangerous: false, arguments: args });
    }
    const detail = `Run workflow${label}? Workflows fan out multiple agents and cost more tokens.`;
    if (this.interactionPort) {
      return await this.interactionPort.confirm({ title: 'Run workflow?', detail, dangerous: false, tool: 'run_workflow' });
    }
    try {
      return await this.prompter.askYesNo(`${detail} (y/N) `, false);
    } catch (err) {
      if (err instanceof NoTTYError) return true; // headless — no terminal to ask, proceed
      throw err;
    }
  }

  /**
   * ARTIFACT-LINK — capture a model-authored artifact (`artifact_write`) into
   * BrainRouter memory as a SESSION-SCOPED cognitive record and link the
   * returned recordId back into the artifact's `linkedMemoryIds`. Closes the gap
   * where only CLI/desktop lifecycle actions captured. Best-effort: a capture
   * failure must never break the tool call.
   */
  public async captureArtifactToMemory(record: ArtifactRecord): Promise<void> {
    try {
      const memoryId = await emitArtifactCapture(
        { mcpClient: this.mcpClient as any, sessionKey: this.sessionKey },
        {
          artifactId: record.id,
          title: record.title,
          summary: record.summary,
          artifactKind: record.kind,
          format: record.format,
          status: record.status,
          requirementId: record.requirementId,
          taskId: record.taskId,
        },
      );
      if (memoryId) linkArtifact(this.workspaceRoot, record.id, { memoryId });
    } catch {
      // advisory — never break artifact_write
    }
  }

  public isModelVisibleMcpTool(tool: any): boolean {
    const hiddenBrainrouterTools = new Set([
      'memory_capture_turn',
      'memory_mark_cited',
      'memory_resolve_session',
      'memory_register_skill_hints',
      'memory_hook_register',
      'memory_hook_status',
    ]);
    const name = String(tool?.name ?? '');
    const rawName = String(tool?.__rawName ?? this.rawMcpToolName(name));
    if (!hiddenBrainrouterTools.has(rawName)) return true;

    const serverId = typeof tool?.__serverId === 'string'
      ? tool.__serverId
      : this.serverIdFromMcpToolName(name);
    const status = serverId && typeof (this.mcpClient as any).getStatus === 'function'
      ? (this.mcpClient as any).getStatus(serverId)
      : undefined;
    // Hide only BrainRouter auto-pipeline/admin tools. Third-party MCP tools
    // with coincidentally similar names stay visible.
    return status?.identity !== 'brainrouter';
  }

  public rawMcpToolName(name: string): string {
    const serverId = this.serverIdFromMcpToolName(name);
    return serverId ? name.slice(`mcp_${serverId}_`.length) : name;
  }

  public serverIdFromMcpToolName(name: string): string | undefined {
    // Canonical single-underscore prefix: `mcp_<server>_<tool>`. The pool
    // normalises to this shape at its boundary (0.3.8-R5).
    if (!name.startsWith('mcp_')) return undefined;
    const rest = name.slice('mcp_'.length);
    if (typeof (this.mcpClient as any).getServerIds === 'function') {
      const ids = (this.mcpClient as any).getServerIds() as string[];
      for (const id of ids.sort((a, b) => b.length - a.length)) {
        if (rest.startsWith(`${id}_`)) return id;
      }
    }
    const idx = rest.indexOf('_');
    return idx >= 0 ? rest.slice(0, idx) : undefined;
  }

  /**
   * §5.4 — the MCP tool-call approval gate, shared by the main MCP dispatch path
   * and the `mcp_call` discovery tool so neither can bypass it. Throws if the
   * call requires approval and it is rejected (or a silent session has no parent
   * approver). `args` is shown to a parent approver in silent sessions.
   */
  public async approveMcpToolCall(
    name: string,
    descriptor: any,
    args: Record<string, any>,
  ): Promise<void> {
    const mcpApproval = assessMcpToolApproval(name, descriptor);
    if (!mcpApproval.requiresApproval) return;
    if (this.silent) {
      if (!this.confirmToolApproval) {
        throw new Error(`MCP tool "${name}" requires approval but this silent session has no parent approver: ${mcpApproval.reason}.`);
      }
      const approved = await this.confirmToolApproval({
        tool: name,
        arguments: args,
        reason: mcpApproval.reason,
        dangerous: mcpApproval.dangerous,
      });
      if (!approved) {
        throw new Error(`MCP tool "${name}" rejected by parent approval.`);
      }
    } else if (this.interactionPort) {
      const uiApproved = await this.interactionPort.confirm({
        title: 'MCP tool approval',
        detail: `${name} — ${mcpApproval.reason}`,
        dangerous: mcpApproval.dangerous,
        tool: name,
      });
      if (!uiApproved) {
        throw new Error(`MCP tool "${name}" rejected by user.`);
      }
    } else {
      const approved = await this.prompter.askYesNo(
        `${chalk.yellow('⚠️  MCP tool approval request:')} ${chalk.cyan(name)}${mcpApproval.dangerous ? chalk.red(' (potentially destructive)') : ''}\nReason: ${mcpApproval.reason}\nAllow MCP tool call? (y/N) `,
        false,
      );
      if (!approved) {
        throw new Error(`MCP tool "${name}" rejected by user.`);
      }
    }
  }

  /**
   * §5.4 — the live, model-visible MCP catalog (listTools + the same visibility
   * filter the per-turn assembly uses), for the discovery tools. Empty on error.
   */
  public async visibleMcpToolList(): Promise<any[]> {
    try {
      const res = await this.mcpClient.listTools();
      return (res.tools || []).filter((t: any) => this.isModelVisibleMcpTool(t));
    } catch {
      return [];
    }
  }

  /** §5.4 — resolve a visible MCP tool by its exact namespaced name or bare name. */
  public async findVisibleMcpTool(target: string): Promise<any | undefined> {
    const want = target.trim();
    if (!want) return undefined;
    const tools = await this.visibleMcpToolList();
    return tools.find((t: any) =>
      String(t?.name ?? '') === want ||
      String(t?.__rawName ?? this.rawMcpToolName(String(t?.name ?? ''))) === want);
  }

  /**
   * MAS-P4-T1 — the most recent user message text, used to rank MCP tools by
   * relevance when the catalog exceeds the budget. Empty string when there's
   * no user turn yet (the cap then keeps the first N in stable order).
   */
  public latestUserText(): string {
    for (let i = this.chatHistory.length - 1; i >= 0; i--) {
      const m: any = this.chatHistory[i];
      if (m?.role === 'user' && typeof m.content === 'string') return m.content;
    }
    return '';
  }

  public allowedToolsForAccess(): Set<string> {
    // CODEX-TOOL-REGISTRY — the exposure set is GENERATED from the single
    // tool registry (`agent/tools/registry.ts`), which also declares each
    // tool's action kind + parallel-safety. A guard test keeps the registry,
    // the execution policy, and the parallel whitelist from drifting (the
    // class of bug REVIEW-FIX fixed). Read-tier tools (incl. lifecycle +
    // orchestration observers) are always available; write/shell add their
    // tiers on top.
    return registryAllowedTools(this.accessMode);
  }

  async runTurn(prompt: string, callbacks: RunTurnCallbacks, opts?: { hiddenPrompt?: boolean; images?: Array<{ mediaType: string; dataBase64: string }> }): Promise<string> {
    // Body moved to ./runTurn.impl.ts (god-file breakdown); delegate with `this`
    // bound so all instance state resolves exactly as before.
    return runTurnImpl.call(this, prompt, callbacks, opts);
  }

  /**
   * Content-aware token estimate. Calls into `runtime/tokenEstimate.ts`
   * which buckets characters by class (prose / code-density / CJK) and
   * applies per-class chars-per-token ratios — closer to the provider's
   * actual BPE tokenizer than the old `text.length / 4` heuristic.
   *
   * Used only as a fallback when authoritative `response.usage.prompt_tokens`
   * isn't available (turn 1, silent/offline runs).
   */
  public static estimateTokens(text: string): number {
    return estimateTokensContentAware(text);
  }

  public async executeLocalTool(name: string, args: Record<string, any>, runtime?: { orchestrationRuntime?: OrchestrationRuntimePort; lifecycleRuntime?: ToolLifecycleRuntimePort }): Promise<string> {
    // HONK-L3 — re-nest args the local model emitted against a flattened schema
    // (dot-notation keys → nested objects) before any executor sees them.
    if (this.flattenedToolNames.has(name)) args = nestArguments(args);
    const executor = localToolExecutor(name);
    if (!executor) throw new Error(`Unknown local tool: ${name}`);
    if (registryEntry(name)?.runtimePort === 'browser-control' && !browserUseAvailableFor({
      hasPort: !!this.browserControlPort,
      silent: this.silent,
      depth: this.agentDepth,
      tier: this.tier,
      remoteBrain: isRemoteBrainUrl(getCliKnobs().brainUrl),
    })) {
      throw new Error(`Tool "${name}" is unavailable outside the active top-level local Desktop browser session.`);
    }
    // CWE-266 — the builtin/orchestration/lifecycle runtime ports let a tool
    // invoke ANY built-in (shell/file) and spawn child agents. Only FIRST-PARTY
    // tools owned by a required core extension are trusted with them; a
    // user-installed extension tool must never capture these privileged
    // interfaces, so it receives none (its `handle` still runs, just without the
    // escalation surface).
    const trusted = requiredExtensionToolNames().has(name);
    return executor.handle({
      args,
      invokedName: name,
      builtinRuntime: trusted
        ? { invoke: (toolName, toolArgs) => invokeBuiltinToolRuntime.call(this, toolName, toolArgs) }
        : undefined,
      orchestrationRuntime: trusted ? runtime?.orchestrationRuntime : undefined,
      lifecycleRuntime: trusted ? runtime?.lifecycleRuntime : undefined,
      browserControlPort: this.browserControlPort,
      signal: this.turnAbort?.signal,
    });
  }

  /**
   * Adapt the agent's MCP client into the `McpConnectorClient` the `mcp`
   * connector source needs (listResources / readResource). Returns `undefined`
   * when the active MCP client can't read resources, so the shared runner emits
   * a clear "no MCP client" error instead of crashing.
   */
  public agentMcpConnectorClient(): McpConnectorClient | undefined {
    const client = this.mcpClient as any;
    if (typeof client.listResources !== 'function' || typeof client.readResource !== 'function') {
      return undefined;
    }
    const signal = () => this.turnAbort?.signal;
    return {
      listResources: async (opts) => {
        const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
        if (opts.resourceUris?.length) {
          if (!opts.serverId) throw new Error('MCP connector config serverId is required when resourceUris are configured.');
          return opts.resourceUris.slice(0, limit).map((uri) => ({ server: opts.serverId, uri }));
        }
        const resources: McpConnectorResource[] = [];
        let cursor: string | undefined;
        do {
          const result = await client.listResources({ server: opts.serverId, cursor }, { signal: signal() });
          const rows = Array.isArray(result?.resources) ? result.resources : [];
          for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const r = row as Record<string, unknown>;
            const uri = typeof r.uri === 'string' ? r.uri : '';
            if (!uri) continue;
            resources.push({
              server: typeof r.server === 'string' ? r.server : opts.serverId,
              uri,
              name: typeof r.name === 'string' ? r.name : undefined,
              description: typeof r.description === 'string' ? r.description : undefined,
              mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
            });
            if (resources.length >= limit) break;
          }
          cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
        } while (cursor && resources.length < limit);
        return resources;
      },
      readResource: async (resource) => {
        if (!resource.server) throw new Error(`MCP resource ${resource.uri} has no server id.`);
        const result = await client.readResource({ server: resource.server, uri: resource.uri }, { signal: signal() });
        const contents = Array.isArray(result?.contents) ? result.contents : [];
        return {
          contents: contents.map((content: unknown) => {
            const row = content && typeof content === 'object' ? content as Record<string, unknown> : {};
            return {
              uri: typeof row.uri === 'string' ? row.uri : undefined,
              text: typeof row.text === 'string' ? row.text : undefined,
              blob: typeof row.blob === 'string' ? row.blob : undefined,
              mimeType: typeof row.mimeType === 'string' ? row.mimeType : undefined,
            };
          }),
        };
      },
    };
  }

  clearHistory() {
    this.chatHistory = [this.createSystemMessage()];
    this.initialized = true;
    // DESK-5t — a new session has no accumulated context; drop the prior
    // session's authoritative prompt count so getCurrentContextTokens() falls
    // back to estimating the (now-empty) history instead of reporting the old
    // session's fill.
    this.lastSeenPromptTokens = undefined;
  }

  /**
   * Compaction for /compact: summarize current chat history via the LLM,
   * then replace the verbose log with [system, compactedSummary,
   * lastUserMessage]. Returns the summary so the REPL can display it.
   */
  // The bodies of the following methods moved to ./session.impl.ts (god-file
  // breakdown). Each keeps its exact signature and delegates to the extracted
  // impl with `this` bound, so behavior + call sites are unchanged.
  public async compactHistory(): Promise<{ summary: string; estimatedTokens: number; durationMs: number; replacedMessages: number } | null> {
    return compactHistoryImpl.call(this);
  }

  public requestInterrupt(): void {
    return requestInterruptImpl.call(this);
  }

  public setModel(model: string): void {
    return setModelImpl.call(this, model);
  }

  public getModel(): string {
    return getModelImpl.call(this);
  }

  public getCurrentContextTokens(): number {
    return getCurrentContextTokensImpl.call(this);
  }

  public getPrefixComponents(): PrefixComponents {
    return getPrefixComponentsImpl.call(this);
  }

  public recordPrefixStability(messages: readonly unknown[], tools: readonly unknown[]): void {
    return recordPrefixStabilityImpl.call(this, messages, tools);
  }

  public getPrefixStability(): { stableCalls: number; bustCalls: number; ratio: number; lastLabels: string[] } {
    return getPrefixStabilityImpl.call(this);
  }

  public spawnBackgroundWorker(goal: string): { id: string; status: string; goal: string } {
    return spawnBackgroundWorkerImpl.call(this, goal);
  }

  public getRepairTotals(): { scavenged: number; truncationsFixed: number; truncationsUnrecoverable: number; stormsBroken: number; turnsWithRepair: number } {
    return getRepairTotalsImpl.call(this);
  }

  public getOffloadTotals(): { childTokensSpent: number; offloadCharsAvoided: number; compactedToolCharsAvoided: number } {
    return getOffloadTotalsImpl.call(this);
  }

  public maybeAutoApprovePlan(state: PlanState): void {
    return maybeAutoApprovePlanImpl.call(this, state);
  }

  public captureFileSnapshot(absPath: string): void {
    return captureFileSnapshotImpl.call(this, absPath);
  }

  public async maybeReindexSource(resolved: string, content: string): Promise<string> {
    return maybeReindexSourceImpl.call(this, resolved, content);
  }

  public getLlmConfig(): LLMConfig {
    return getLlmConfigImpl.call(this);
  }

  public setLLMConfig(next: Partial<LLMConfig>): void {
    return setLLMConfigImpl.call(this, next);
  }

  public replaceLLMConfig(next: LLMConfig): void {
    return replaceLLMConfigImpl.call(this, next);
  }

  public getLLMConfig(): LLMConfig {
    return getLLMConfigImpl.call(this);
  }

  public getAccessMode(): AccessMode {
    return getAccessModeImpl.call(this);
  }

  public setAccessMode(mode: AccessMode): void {
    return setAccessModeImpl.call(this, mode);
  }

  public getPolicyAudit(): ReadonlyArray<{ tool: string; action: ActionKind; decision: PolicyDecision; reason: string }> {
    return getPolicyAuditImpl.call(this);
  }

  public loadHistory(entries: Array<{ role: string; content?: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>): number {
    return loadHistoryImpl.call(this, entries);
  }

  /** Cumulative token usage across the last runTurn. Cleared at each new turn. */
  public lastTurnUsage: {
    promptTokens: number;
    completionTokens: number;
    calls: number;
    /** 0.3.9 item 10 — provider-normalised cache hit (prefix-cache served). */
    cachedTokens: number;
    /** 0.3.9 item 10 — provider-normalised cache miss (full input price). */
    missedTokens: number;
    /** Last call's `prefixFingerprint` (item 8). Lets `/tokens` show whether the prefix was stable. */
    lastPrefixFingerprint?: string;
  } = { promptTokens: 0, completionTokens: 0, calls: 0, cachedTokens: 0, missedTokens: 0 };

  /** WS0 — running prefix-cache stability tally (cache-stable-prefix hits vs
   *  busts) across the whole session. This is the measurable signal any future
   *  prefix-ordering change is judged against: reorder, then watch the ratio. */
  public prefixStability: PrefixStabilityTally = newPrefixStabilityTally();
  /** WS0 — previous LLM call's prefix components, for call-over-call drift detection. */
  public prevPrefixComponents: PrefixComponents | null = null;

  /** Cumulative token usage across the WHOLE CLI session (all turns). */
  public sessionUsage: {
    promptTokens: number;
    completionTokens: number;
    calls: number;
    turns: number;
    cachedTokens: number;
    missedTokens: number;
  } = { promptTokens: 0, completionTokens: 0, calls: 0, turns: 0, cachedTokens: 0, missedTokens: 0 };

  /**
   * Memory-derived savings counters. These let `/tokens` produce a "memory
   * saved you ~N tokens" narrative the user can actually point at.
   *
   *  - briefingTokensInjected:  approx tokens added to context as memory
   *    briefings (recall + persona + scenes + recency). Each briefing
   *    provides cross-session context that would otherwise require re-reading
   *    files or re-explaining via prompts.
   *  - offloadCharsAvoided:     chars of child-agent output that were pushed
   *    to working memory instead of pasted back into parent context.
   *  - compactedToolCharsAvoided: chars omitted from model-visible tool
   *    results after semantic compaction. Raw outputs remain in transcripts.
   *  - recallRecordsConsulted:  count of memory record references the
   *    briefing put in front of the model this session.
   */
  public memoryMetrics = {
    briefingTokensInjected: 0,
    offloadCharsAvoided: 0,
    recallRecordsConsulted: 0,
    compactedToolCharsAvoided: 0,
    // FOOTER-TELEMETRY-2 — cumulative tokens spent by child agents this session.
    // In-memory parent-side counter (children persist their own usage to disk;
    // this lets the footer surface child spend without a per-render disk scan).
    childTokensSpent: 0,
  };

  /**
   * 0.4.x-4 (`/context`) — per-skill token accounting. Each completed turn's
   * usage is bucketed by the `activeSkill` in effect that turn (or `chat`
   * when none), so `/context` can show where the session's tokens went.
   */
  public usageBySkill: Map<string, { promptTokens: number; completionTokens: number; turns: number; calls: number }> = new Map();

  /** 0.4.x-4 (`/context`) — per-tool call counts (which tools ran, how often). */
  public toolCallCounts: Map<string, number> = new Map();

  /**
   * CC-UX-E3 (`/usage`) — per-MCP-server tool-call counts. Keyed by the MCP
   * server id derived from the tool name (`mcp_<server>_<tool>`); local /
   * orchestration tools are not counted here. Lets `/usage` attribute dispatch
   * to each connected MCP server. Reset alongside `toolCallCounts`.
   */
  public mcpServerCallCounts: Map<string, number> = new Map();

  /** Last assistant message of the most recent turn — used by `/copy`. */
  public lastAnswer = '';

  /** Last user prompt (post-mention-expansion). Used by `/continue` to resume after a loop-limit abort. */
  public lastUserPrompt = '';

  /**
   * CC-hooks parity — additionalContext a `stop` / `subagent-stop` hook asked
   * to inject back into the model on the NEXT turn. Drained (read + cleared)
   * at the top of `runTurn` and appended to the incoming prompt. A parent that
   * spawns a child can also seed this from the child's subagent-stop output.
   */
  public pendingStopContext: string | undefined = undefined;

  /** True when the most recent turn hit the loop-limit ceiling before producing a final answer. */
  public lastTurnHitLoopLimit = false;

  /** Count of tool calls executed during the most recent runTurn. The goal */
  /** continuation loop uses this to suppress auto-continuation after prose-only turns. */
  public lastTurnToolCalls = 0;

  /** C1 — child ids whose drain TIMED OUT this turn (the parent answered before they
   *  finished). The REPL polls these and auto-resumes once they settle. Empty when
   *  nothing timed out. */
  public lastTurnPendingChildIds: string[] = [];

  /** Goal lifecycle transition the LLM triggered during the most recent turn, if any. */
  public lastGoalTransition: 'complete' | 'blocked' | undefined;

  /** Allow REPL slash commands to refresh the system prompt without bumping a new turn. */
  public refreshSystemPrompt(): void {
    if (this.chatHistory.length > 0 && this.chatHistory[0].role === 'system') {
      this.chatHistory[0] = this.createSystemMessage();
    }
  }

  /**
   * CC-UX-E1 — `/cd <path>`: move this session's working directory (the root all
   * path resolution, run_command cwd, and code-index operations are bound to)
   * to a new location WITHOUT dropping the transcript or memory. The chat
   * history, sessionKey, and memory bucket are session-scoped and survive; only
   * the filesystem anchor changes.
   *
   * Because path resolution, the read-before-edit ledger, and any child /
   * worktree context are all anchored to the OLD root, moving the root
   * invalidates them: the read ledger is cleared (a file at the same relative
   * path in the new root is a different file), and any pending-child /
   * last-turn worktree bookkeeping is reset so a subsequent turn doesn't try to
   * apply an old-root patch against the new root. The system prompt is
   * refreshed so the model sees the new workspace line.
   *
   * Returns the resolved absolute path on success. Throws on an invalid path
   * (does not exist / is not a directory) so the caller can surface the error
   * and leave the session pointed at the old root.
   */
  public changeWorkspace(target: string): string {
    const raw = String(target ?? '').trim();
    if (!raw) throw new Error('Usage: /cd <path> — a directory path is required.');
    // Resolve relative to the CURRENT workspace root (so `/cd ../sibling`
    // works), falling back to absolute paths verbatim. `~` expands to $HOME.
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const expanded = raw === '~' ? home : raw.startsWith('~/') && home ? path.join(home, raw.slice(2)) : raw;
    const resolved = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(this.workspaceRoot, expanded);
    let stat: import('node:fs').Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Path does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }
    // Canonicalise (resolve symlinks) so downstream path checks compare like
    // for like — matches how the constructor's callers hand us a realpath.
    let canonical = resolved;
    try { canonical = fs.realpathSync(resolved); } catch { /* keep resolved */ }
    if (canonical === this.workspaceRoot) return canonical; // no-op
    this.workspaceRoot = canonical;
    // The read-before-edit ledger and authored-commit set are keyed on the old
    // root's absolute paths / HEAD — invalid against the new root.
    this.filesReadThisSession = new Set();
    this.agentAuthoredCommits = new Set();
    // Reset child / worktree carry-over so a later turn doesn't apply an
    // old-root patch or resume a child rooted at the prior workspace.
    this.lastTurnPendingChildIds = [];
    // Re-anchor the system prompt (it embeds the workspace root line).
    this.refreshSystemPrompt();
    return canonical;
  }

  /**
   * Push (or replace) a tagged system message in `chatHistory`. Per-turn
   * directives like the briefing block and the fan-out hint used to be pushed
   * unconditionally — each turn added a fresh copy without removing the prior
   * one, so a 10-turn conversation carried 10 stacked briefings. This helper
   * removes any older entry with the same tag before appending the new one,
   * keeping the model's view of "current memory state" current.
   */
  public replaceTaggedSystemMessage(tag: string, content: string): void {
    const marker = `<!--brainrouter:${tag}-->\n`;
    this.chatHistory = this.chatHistory.filter(
      (msg) => !(msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith(marker)),
    );
    this.chatHistory.push({ role: 'system', content: `${marker}${content}` });
  }

  /**
   * Drop any system message previously installed under `tag`. Used to retract
   * one-off directives once the condition that motivated them no longer
   * holds — e.g. the budget-steering "wrap up gracefully" message must
   * disappear after the user extends the goal's budget, otherwise it keeps
   * telling the model "this is your last turn" for every subsequent turn.
   *
   * Idempotent: calling this with a tag that isn't present is a no-op.
   */
  public removeTaggedSystemMessage(tag: string): void {
    const marker = `<!--brainrouter:${tag}-->\n`;
    this.chatHistory = this.chatHistory.filter(
      (msg) => !(msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith(marker)),
    );
  }

  /**
   * Zero the in-process counters that back `/tokens`. Call this on any
   * conceptual session boundary (`/resume`, `fork`) — otherwise the parent
   * row keeps accumulating across the switch and "this session" no longer
   * matches the displayed sessionKey.
   */
  public resetSessionCounters(): void {
    this.sessionUsage = { promptTokens: 0, completionTokens: 0, calls: 0, turns: 0, cachedTokens: 0, missedTokens: 0 };
    this.repairTotals = { scavenged: 0, truncationsFixed: 0, truncationsUnrecoverable: 0, stormsBroken: 0, turnsWithRepair: 0 };
    this.memoryMetrics = {
      briefingTokensInjected: 0,
      offloadCharsAvoided: 0,
      recallRecordsConsulted: 0,
      compactedToolCharsAvoided: 0,
      childTokensSpent: 0,
    };
    // 0.4.x-4 — per-skill + per-tool accounting is session-scoped too.
    this.usageBySkill = new Map();
    this.toolCallCounts = new Map();
    this.mcpServerCallCounts = new Map(); // CC-UX-E3
    // 9b: session-boundary reset for gated recall.
    this.recallHasFiredThisSession = false;
    this.recallNextTurnIsPostCompaction = false;
    this.turnsSinceLastFullBriefing = 0;
    this.recentToolFailure = undefined;
    // 0.3.9 item 9 — also clear any pinned memory anchor so the new
    // session starts with a fresh PIN on its first briefing.
    this.pinnedAnchorHash = null;
  }

  /**
   * Clear the pinned memory anchor so the next briefing re-pins. Called
   * by the `/refresh-memory` slash command — see
   * `brainrouter-cli/src/cli/commands/memory.ts`. The actual chat
   * history entry will be replaced on the next `injectRecallContext()`
   * call (PIN action) once the new briefing is built.
   */
  public clearPinnedMemoryAnchor(): void {
    this.pinnedAnchorHash = null;
    this.removeTaggedSystemMessage('memory-briefing');
  }

  /** Inspectable getter used by `/briefing` and tests. */
  public hasPinnedMemoryAnchor(): boolean {
    return this.pinnedAnchorHash !== null;
  }

  /** Fork the current chat history into a fresh sessionKey. Returns the new key. */
  public fork(newSessionKey: string): string {
    this.sessionKey = newSessionKey;
    // Replace the system message so workspace/session context is fresh,
    // but keep the user/assistant/tool exchange.
    if (this.chatHistory.length > 0 && this.chatHistory[0].role === 'system') {
      this.chatHistory[0] = this.createSystemMessage();
    } else {
      this.chatHistory = [this.createSystemMessage(), ...this.chatHistory];
    }
    this.resetSessionCounters();
    return this.sessionKey;
  }

  // The bodies of the following methods moved to ./lifecycle.impl.ts (god-file
  // breakdown). Each keeps its exact public/private signature and delegates to
  // the extracted impl with `this` bound, so behavior + call sites are unchanged.
  public async bootstrapSession(callbacks: RunTurnCallbacks): Promise<void> {
    return bootstrapSessionImpl.call(this, callbacks);
  }

  public async ensureInitialized(): Promise<void> {
    return ensureInitializedImpl.call(this);
  }

  public createSystemMessage() {
    return createSystemMessageImpl.call(this);
  }

  public hookEnforceActive(): boolean {
    return hookEnforceActiveImpl.call(this);
  }

  public hookAdvisoryActive(): boolean {
    return hookAdvisoryActiveImpl.call(this);
  }

  public hookNotifyActive(): boolean {
    return hookNotifyActiveImpl.call(this);
  }

  public async runExtensionHooks(
    event: import('../hooks/hooksStore.js').HookEvent,
    ctx: { tool?: string; args?: Record<string, unknown> } = {},
  ): Promise<string | null> {
    return runExtensionHooksImpl.call(this, event, ctx);
  }

  public autoCaptureRequirement(prompt: string, callbacks: RunTurnCallbacks): void {
    return autoCaptureRequirementImpl.call(this, prompt, callbacks);
  }

  public autoSynchronizeRequirementPlanTrack(callbacks: RunTurnCallbacks): void {
    return autoSynchronizeRequirementPlanTrackImpl.call(this, callbacks);
  }

  public autoSynchronizeSprints(callbacks: RunTurnCallbacks): void {
    return autoSynchronizeSprintsImpl.call(this, callbacks);
  }

  public autoReconcileGoalCompletion(callbacks: RunTurnCallbacks): void {
    return autoReconcileGoalCompletionImpl.call(this, callbacks);
  }

  public applyTrackCodeSignalAutomation(args: Record<string, any>, callbacks: RunTurnCallbacks): number {
    return applyTrackCodeSignalAutomationImpl.call(this, args, callbacks);
  }

  public autoLinkDoneTrackItem(item: ReturnType<typeof trackGetWorkItem>, callbacks: RunTurnCallbacks): void {
    return autoLinkDoneTrackItemImpl.call(this, item, callbacks);
  }

  public captureTrackAutomationEvent(input: {
    action: 'code-link-progress' | 'requirement-fulfilled';
    item: NonNullable<ReturnType<typeof trackGetWorkItem>>;
    requirementId?: string;
    codeLink?: { kind: string; ref: string };
    fromStatus?: string;
    toStatus?: string;
  }): void {
    return captureTrackAutomationEventImpl.call(this, input);
  }

  public async injectRecallContext(prompt: string, mcpTools: any[], callbacks: RunTurnCallbacks): Promise<void> {
    return injectRecallContextImpl.call(this, prompt, mcpTools, callbacks);
  }

  /** Inspectable summary of the most recent memory briefing. Used by the `/briefing` slash command. */
  public getLastBriefing(): LastBriefingDetails {
    return {
      ...this.lastBriefingDetails,
      sources: [...this.lastBriefingDetails.sources],
      sourcesPlanned: [...this.lastBriefingDetails.sourcesPlanned],
      skippedSources: [...this.lastBriefingDetails.skippedSources],
      sourceStats: [...this.lastBriefingDetails.sourceStats],
      recordIds: [...this.lastBriefingDetails.recordIds],
      reasons: [...this.lastBriefingDetails.reasons],
      warnings: [...this.lastBriefingDetails.warnings],
    };
  }

  /**
   * Snapshot of the records produced by the most recent pre-turn briefing.
   * `/where` surfaces a few of these to give the user a sense of what the
   * agent is leaning on right now. Returns a shallow copy so callers can't
   * mutate the agent's internal state.
   */
  public getRecalledRecords(): RecalledRecord[] {
    return [...this.recalledRecords];
  }

  /** One-line summary of any new contradiction surfaced after the last capture, or undefined if none. */
  private lastContradictionWarning?: string;
  public takeContradictionWarning(): string | undefined {
    const w = this.lastContradictionWarning;
    this.lastContradictionWarning = undefined;
    return w;
  }

  private async checkContradictions(callbacks?: RunTurnCallbacks): Promise<void> {
    if (!this.enableRecall) return;
    const res = await callMcpTool<any>(this.mcpClient, 'memory_contradictions', { action: 'list' });
    if (res.isError || !res.parsed) return;
    const list = res.parsed?.contradictions ?? res.parsed?.items ?? res.parsed;
    if (!Array.isArray(list) || list.length === 0) return;
    const first = list[0];
    const summary = first?.summary || first?.description || first?.title || JSON.stringify(first).slice(0, 200);
    this.lastContradictionWarning = `${list.length} unresolved contradiction(s). First: ${summary}`;
    callbacks?.onMemoryEvent?.({ kind: 'contradiction', warning: this.lastContradictionWarning });
  }

  public async captureTurn(prompt: string, finalAnswer: string, callbacks?: RunTurnCallbacks): Promise<void> {
    if (this.silent) return;
    if (!finalAnswer) return;
    const timestamp = Date.now();

    try {
      if (this.recalledRecordIds.length > 0) {
        const cited = selectCitedRecordIds(this.recalledRecords, finalAnswer);
        await this.mcpClient.callTool('memory_mark_cited', {
          citedRecordIds: cited,
          allRecalledRecordIds: this.recalledRecordIds,
        });
        if (cited.length > 0) {
          callbacks?.onMemoryEvent?.({ kind: 'citation', recordIds: cited });
        }
      }
    } catch {
      // Citation feedback should not break the user-facing turn.
    }

    try {
      const userContent = redactText(prompt);
      const assistantContent = redactText(finalAnswer);
      const policy = assessCapturePayload(`${userContent}\n${assistantContent}`);
      if (policy.blocked) {
        callbacks?.onMemoryEvent?.({ kind: 'skipped', reason: policy.reason ?? 'capture blocked by policy' });
        return;
      }
      const captureRes = await this.mcpClient.callTool('memory_capture_turn', {
        sessionKey: this.sessionKey,
        activeSkill: this.activeSkill,
        messages: [
          { role: 'user', content: userContent, timestamp },
          { role: 'assistant', content: assistantContent, timestamp: Date.now() },
        ],
      });
      // Parse the structured result so the REPL can tell "wrote 2 sensory + 0
      // cognitive (extractor not running)" apart from "wrote 2 + 3 cognitive
      // — fully captured." Previously the CLI printed 💾 Captured even when
      // the extractor was silently disabled, leaving the user to discover
      // the gap by running SQL against memory.db.
      let parsed: any;
      try {
        const text = extractToolText(captureRes);
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      // Only warn when the LLM call ITSELF failed (status === 'failed').
      // A successful call that returned 0 records is a legitimate "nothing
      // notable to capture" outcome (e.g. a greeting) and should not look
      // like an error to the user. The previous heuristic conflated both
      // and surfaced a misleading warning after every trivial exchange.
      // 'deferred' = extraction was dispatched to the brain's background runner so
      // capture could reply immediately; like 'ok'/'skipped' it is NOT a warning.
      const status: 'ok' | 'failed' | 'skipped' | 'deferred' | undefined = parsed?.cognitiveExtractionStatus;
      const extractionWarning = status === 'failed'
        ? (typeof parsed?.cognitiveExtractionError === 'string'
            ? `extraction failed: ${parsed.cognitiveExtractionError.slice(0, 140)}`
            : 'extraction failed — check MCP server logs and LLM credentials')
        : undefined;
      callbacks?.onMemoryEvent?.({
        kind: 'capture',
        sessionKey: this.sessionKey,
        messageCount: 2,
        sensoryRecorded: typeof parsed?.sensoryRecordedCount === 'number' ? parsed.sensoryRecordedCount : undefined,
        extractionTriggered: typeof parsed?.cognitiveExtractionTriggered === 'boolean' ? parsed.cognitiveExtractionTriggered : undefined,
        extractedCount: typeof parsed?.cognitiveExtractedCount === 'number' ? parsed.cognitiveExtractedCount : undefined,
        extractionWarning,
      });
    } catch {
      // Passive capture is best effort in the CLI.
    }

    await this.checkContradictions(callbacks);
  }

  public recordTranscript(message: any): void {
    try {
      appendTranscriptEntry(this.workspaceRoot, this.sessionKey, message);
    } catch {
      // Transcript persistence should not break the interactive turn.
    }
  }
}

// Tool-result presentation helpers moved to ./toolSummary.ts (god-file
// breakdown). Re-exported here so agent.ts's public surface is unchanged.
export { getToolSummary, getToolPreview } from './support/toolSummary.js';


/**
 * Heuristic for "does this model accept the OpenAI Chat Completions
 * `reasoning_effort` field?". The signal that actually matters is the
 * **model name**, not the endpoint hostname — modern OpenAI-compatible
 * servers (LM Studio 0.3.29+, Ollama, vLLM, OpenRouter, OpenAI itself)
 * all accept the field on /v1/chat/completions for the reasoning-capable
 * model classes below, and silently ignore it for everything else. So a
 * `gpt-oss-20b` served from localhost via LM Studio gets the same
 * treatment as `gpt-5` on `api.openai.com`.
 *
 * The `low|medium|high` values map
 * straight through to the provider field across OpenAI, DeepSeek,
 * LM Studio, Ollama, and OpenRouter's pass-through. Anthropic-native
 * support was removed in 0.3.9; Claude models can still be reached
 * through OpenRouter / Together / other OpenAI-compatible gateways
 * that handle the field translation upstream.
 */

/**
 * 9b: resolve the recall-gating mode for this process. Reads `cli.recallMode`
 * from `~/.config/brainrouter/config.json`. Unset defaults to `gated`. The
 * TypeScript union narrows the surface so a typo can't reach this code path
 * — defensive parsing was retired with the env-var path in 0.3.9.
 */
export function resolveRecallMode(): 'always' | 'gated' | 'off' {
  return resolveRecallModeFromEnv();
}

/**
 * 9b: cheap local heuristic for "the user message names something specific
 * memory might have history on." Counts entity-shaped tokens: proper nouns
 * (capitalized words that aren't sentence-starting), file paths (anything
 * with `/` or `\\` or a `.<ext>` suffix), and identifier-shaped tokens (`camelCase`
 * / `snake_case` / `PascalCase` longer than 4 chars). Crude but the bar is
 * "is recall plausibly worth it?" — false positives waste a recall call,
 * false negatives waste an ask. Tunable threshold via the caller.
 */
export function countEntityTokens(text: string): number {
  return countEntityTokensFromText(text);
}

// Model-name reasoning knowledge now lives in ../provider/models/reasoning.ts
// (the model-name axis, orthogonal to provider id — imported at the top of this
// file). Re-exported here so the existing public surface is unchanged.
export { normalizeModelName };

// LLM transport + provider wire-format layer moved to ./llmTransport.ts
// (god-file breakdown). Re-exported here so agent.ts's public surface is unchanged.
// (ChatCompletionPayload / ResponsesPayload are re-exported up top with the
// payload types.)
export {
  supportsReasoningEffortField,
  activeProviderDef,
  resolveRequestFormat,
  resolveWireEffort,
  minimalReasoningEffort,
  effortForTurnSelection,
  buildChatCompletionPayload,
  buildResponsesPayload,
  stripToolsFromBody,
  isToolsUnsupportedError,
  InterruptError,
  isInterrupt,
  callOpenAI,
  callOpenAIStream,
  type LlmRequestFormat,
  type BuildPayloadOptions,
} from './transport/llmTransport.js';
