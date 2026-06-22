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
import { NoTTYError, HEADLESS_PROMPTER, type InteractivePrompter } from './prompter.js';
import type { LLMConfig } from '../config/config.js';
import { getCliKnobs } from '../config/config.js';
import { appendTranscriptEntry, isInternalSessionKey, redactText, readTranscriptEntries } from '../session/sessionStore.js';
import { recordFileMutation } from '../storage/fileSnapshotStore.js';
import { isConnectivityError, isRetryableServerError } from '../storage/checkpointStore.js';
import { reconnectBackoffMs, probeConnectivity, parseRetryAfterMs } from '../mcp/reconnect.js';
import { unsynthesizedChildIds, mergePendingChildIds, buildPendingChildStatusHint } from '../util/childResume.js';
import { isChildSynthesisTool, resultHasChildOutput, looksLikeChildSynthesisPunt } from '../util/synthesisGuard.js';
import { sanitizeModelArtifacts } from '../util/outputSanitize.js';
import { buildSystemPrompt, loadWorkspaceInstructionSummary } from '../prompt/systemPrompt.js';
import { formatPlan, readPlan, updatePlan, type PlanState } from '../task/taskStore.js';
import { createRequirement, getRequirement, linkRequirement, listRequirements, updateRequirement } from '../requirement/requirementStore.js';
import { detectRequirementShapedPrompt } from '../requirement/requirementDetector.js';
import { syncRequirementPlanTrack } from '../requirement/planTrackSync.js';
import { reconcileSessionSprints } from '../track/sprintAutomation.js';
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
import { parseTrackQuery } from '../track/query.js';
import { createArtifact, updateArtifact, getArtifact, linkArtifact } from '../artifact/artifactStore.js';
import { isArtifactKind, isArtifactFormat, isCodeLinkKind, isWorkItemType, isWorkItemPriority, type ArtifactKind, type ArtifactFormat, type ArtifactRecord } from '@kinqs/brainrouter-types';
// Auto mode (fast + proceed) has no approval prompt, so the plan history would
// otherwise never record that a plan was acted on. When the agent establishes a
// new plan version under auto mode we record an `actor: 'auto'` approval so the
// history stays complete + consistent with explicit approvals.
import { recordPlanDecision, readPlanHistory, linkPlanDecision, planStepSignature } from '../task/planHistoryStore.js';
import type { AccessMode } from '../orchestration/roles.js';
import {
  executeOrchestrationTool,
  isOrchestrationToolName,
  synthesizeDelegateTools,
  childAgentsFor,
  type OrchestrationContext,
} from '../orchestration/tools.js';
import { getSession } from '../orchestration/orchestrator.js';
import { emitAgentEvent, emitArtifactCapture } from '../memory/memoryEvents.js';
import { listAll as listAgentDefinitions } from '../orchestration/agentRegistry.js';
import { ownershipWriteViolation } from '../orchestration/ownership.js';
// REFAC-APPLY-PATCH-MODULE (0.4.6) — workspace-fs primitives + apply_patch live
// in their own modules now; imported here and re-exported below for back-compat.
import { IGNORED_DIRS, isPathInside, resolveWorkspacePath, matchGlob, globFiles, grepSearch } from './workspaceFs.js';
import { applyPatchEnvelope, assessPatchSafety, parsePatchEnvelope } from './applyPatch.js';
export { isPathInside, resolveWorkspacePath, matchGlob, globFiles } from './workspaceFs.js';
export { applyPatchEnvelope } from './applyPatch.js';
// REFAC-TOOLS-MODULE (0.4.6) — tool specs + name normalization live in agent/tools/.
import { LOCAL_TOOLS } from '../tool/specs.js';
import { normalizeToolName } from '../tool/names.js';
import { registryAllowedTools, hideWorkerToolsFor, WORKER_THREAD_TOOLS } from '../tool/registry.js';
import { localToolExecutor, localToolSpecsFromExecutors } from '../tool/executors.js';
import { assessMcpToolApproval } from './mcpApproval.js';
export { LOCAL_TOOLS } from '../tool/specs.js';
export { normalizeToolName } from '../tool/names.js';
import { applyToolScope, rankAndCapTools } from '../tool/toolBudget.js';
import { buildDefaultSourcePlan, buildMemoryBriefing, describeSourcePlan, selectCitedRecordIds, type RecalledRecord } from '../memory/briefing.js';
import { assessCapturePayload } from '../memory/memoryPolicy.js';
import {
  countEntityTokens as countEntityTokensFromText,
  decideMemoryBriefing,
  resolveRecallMode as resolveRecallModeFromEnv,
  type BriefingDecision,
} from '../memory/briefingTriggers.js';
import { callMcpTool, extractToolText } from '../mcp/mcpUtils.js';
import { applyFederationIdentity } from '../util/federationIdentity.js';
import { acquireLLMSlot } from '../util/llmSemaphore.js';
import { blockGoal, completeGoal, formatGoalBlock, readGoal } from '../goal/goalStore.js';
import { runHooks, parseHookDecision } from '../hooks/hooksStore.js';
import { extensionHookHandlers } from '../extension/registry.js';
import { resolveSandboxConfig, runShell } from '../exec/sandbox.js';
import { buildRunCommandPrompt, isDangerousCommand, resolveRunCommandApproval } from '../exec/dangerousCommand.js';
import { evaluateDestructiveCommand } from '../exec/destructiveCommandGuard.js';
import { gitHeadSha } from '../git/workspaceGit.js';
import { recordDailyUsage } from '../usage/usageHistoryStore.js';
import { isTelemetryEnabled } from '../telemetry/telemetry.js';
import { readPreferences, resolveEffort, type EffortLevel } from '../session/preferencesStore.js';
import { resolveActiveMode } from '../session/sessionModeStore.js';
import { resolveEffortForTurn } from './effortRouting.js';
// 0.3.9 — Anthropic native adapter removed (the /v1/messages path landed in
// 0.3.8 but never delivered enough cache-hit headroom or stability to justify
// the second provider dispatch). Anthropic models can still be reached through
// OpenAI-compatible gateways (OpenRouter, Together, etc.) on the OpenAI path.
import { startSpan, traceEvent } from '../telemetry/tracing.js';
// 0.3.9 item 8 — cache-first context regions. The helper here lets us
// fingerprint the cache-stable slice of every outbound chat request
// without rewriting the legacy runTurn message plumbing.
import { computePrefixFingerprint, computePrefixComponents, accumulatePrefixStability, newPrefixStabilityTally, prefixStabilityRatio, type PrefixComponents, type PrefixStabilityTally } from '../context/contextRegions.js';
import { decideExecutionPolicy, resolveToolPolicy, externalDirectoryDecision, egressDecision, type ActionKind, type PolicyDecision } from '../exec/execPolicy.js';
import { isPathWithinRoots } from '../exec/pathPolicy.js';
import { runPostEditCheck } from '../util/postEditCheck.js';
import { shouldReindex, reindexSignature, languageHint, type ReindexGate } from '../util/autoReindex.js';
import { gitChurnSignal } from '../git/gitChurn.js';
// MAS-P5-T2: progressive result handoff — large tool results become a
// preview + resultRef the model expands via extract_result.
import { ResultCache, makeResultHandoff, formatHandoffForModel, attachCompactedResultHandoff } from '../util/resultHandoff.js';
import { runExtractResult } from '../tool/extractResult.js';
// MAS-P5-T3 part 2: persistent worker threads.
import { readWorkerMeta, readWorkerSummary, closeWorker, canSpawnWorker } from '../worker/workerStore.js';
import { drainCompletions, acknowledgeCompletions, formatCompletionFeedback } from '../session/completionInbox.js';
import { classifyDeferral, buildDeliverableCorrection } from './deliverableCheck.js';
import { classifyDenial, formatDenialResult } from './denialMessage.js';
import { evaluatePermissionRules, primaryArgText } from '../exec/permissionRules.js';
import { shouldNudgeTaskTracking, buildTaskTrackingNudge } from './taskTrackingNudge.js';
import { truncateFullRead } from './readTruncation.js';
import { waitUntilCondition } from '../util/waitUntil.js';
import { startBackgroundShell, readBackgroundOutput } from '../exec/backgroundShell.js';
import { CHAPTER_ENTRY_NAME, chapterEntryContent } from '../session/chapterMarks.js';
import { classifyForVerification, commandWritesFiles, decideVerification, buildVerificationNudge, buildDocsOnlyVerificationNote } from './verificationGate.js';
import { getCurrentWorkflow } from '../workflow/workflowArtifacts.js';
import { advanceRunStep, summarizeRun } from '../workflow/workflowRun.js';
import { spawnWorkerThread, waitWorker } from '../orchestration/workerTools.js';
// PARITY-E3: runtime model fallback on model-not-found.
import { isModelNotFoundError, shouldFallbackModel } from '../provider/modelFallback.js';
// 0.3.9 item 10 — provider-normalised cache-hit accounting.
import { extractCacheStats } from '../util/cacheStats.js';
// 0.3.9 item 11 — tool-call repair pipeline (flatten / scavenge /
// truncation / storm).
import { ToolCallRepair, type RepairReport } from './repair/index.js';
// 0.3.9 token-tally rework: content-aware estimator. The compaction
// threshold itself stays a single `BRAINROUTER_AUTO_COMPACT_TOKENS`
// absolute knob — the model's max context window isn't a good driver
// because hitting 75% of a 1M-context model still costs real money,
// and the user might want to compact much earlier.
import {
  estimateTokens as estimateTokensContentAware,
  estimateChatHistoryTokens,
} from '../util/tokenEstimate.js';
// 0.3.9 item 12 — turn-end tool-result auto-shrink.
import { shrinkOversizedToolResults } from './turnEndShrink.js';
// 0.3.9 item 13 — model-tier self-escalation.
import { currentTier, detectNeedsHigh, nextTier, resolveTierLadder, stripNeedsHigh } from '../provider/tierLadder.js';
import { PROVIDER_REGISTRY, findProviderByEndpoint, isLoopbackEndpoint, LOCAL_PLACEHOLDER_KEY } from '../provider/providers/index.js';
import { DEFAULT_EFFORT_VALUE_MAP } from '../provider/providers/definition.js';
import type { ProviderDefinition } from '../provider/providers/definition.js';
import { normalizeModelName, isReasoningModel, isNonReasoningChatModel, isAlwaysOnReasoner, modelSupportsXhighEffort, isBinaryReasoningModel } from '../provider/models/reasoning.js';
import { isSequenceGuardExempt, buildSequenceSignature } from './repeatGuard.js';
// 0.3.9 item 9 — prefix-pinned memory briefing policy.
import {
  decideAnchorAction,
  hashBriefingContent,
  wrapMidSessionRefresh,
} from '../memory/anchorPin.js';
import { buildHookifyContext, evaluateHookify, listHookifyRules } from '../hooks/hookifyStore.js';
import { renderCompactSystemMessage, runCompaction } from '../prompt/compactor.js';
import { compactToolOutput } from '../prompt/toolCompaction.js';
import { appendVerbositySteering } from '../prompt/verbositySteering.js';
import { buildFanOutHint, shouldSuggestFanOut } from '../prompt/breadthHint.js';
import { buildNextActionMessages, parseNextActionPlan, nextActionDirective, planWantsFanOut, shouldSkipPlanner } from '../prompt/nextAction.js';
import { isParallelSafe, parallelExecutionEnabled } from './toolSafety.js';
import { shouldRunFanOutFollowThroughGuard } from './fanOutFollowThroughGuard.js';
import {
  dedupeToolCalls,
  parseArgumentsOrError,
  synthesizeOrphanResults,
  sanitizeToolCallPairing,
  suggestSimilarToolName,
  looksLikeStalledPreamble,
  looksLikeDeferredToolPromise,
  mentionsImminentToolWork,
} from './toolCallRecovery.js';

const execPromise = promisify(exec);
const DEFAULT_CHILD_DRAIN_TIMEOUT_MS = 30_000;

function parseJsonObject(text: string): any | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectChildIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const ids: string[] = [];
  const maybeRecord = value as Record<string, unknown>;
  if (typeof maybeRecord.id === 'string') ids.push(maybeRecord.id);
  if (Array.isArray(maybeRecord.agents)) {
    for (const entry of maybeRecord.agents) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string') {
        ids.push((entry as Record<string, unknown>).id as string);
      }
    }
  }
  return [...new Set(ids)];
}

function trackChildObservation(
  toolName: string,
  args: any,
  resultText: string,
  spawned: Set<string>,
  waited: Set<string>,
): void {
  if (
    toolName === 'spawn_agent' ||
    toolName === 'spawn_agents' ||
    toolName === 'task_agent' ||
    toolName === 'delegate_agent'
  ) {
    const ids = collectChildIds(parseJsonObject(resultText));
    for (const id of ids) {
      spawned.add(id);
      // task_agent always blocks internally (wraps spawn with wait: true);
      // spawn_agent({ wait: true }) is the legacy form. Both count as
      // already-observed, so the child-drain guardrail doesn't double-wait.
      // delegate_agent is fire-and-forget — must remain unwaited so the
      // guardrail can force a wait_agents call before the parent answers.
      if (toolName === 'task_agent') waited.add(id);
      else if (toolName === 'spawn_agent' && args?.wait) waited.add(id);
    }
    return;
  }

  if (toolName === 'wait_agent') {
    const id = typeof args?.id === 'string' ? args.id : undefined;
    if (id) waited.add(id);
    return;
  }

  if (toolName === 'wait_agents') {
    const ids = Array.isArray(args?.ids) ? args.ids.filter((id: unknown): id is string => typeof id === 'string') : [];
    for (const id of ids) waited.add(id);
  }
}

function parseChildDrainTimeouts(resultText: string): Array<{ id: string; role?: string; status: string; childStatus?: string; summary?: string }> {
  const parsed = parseJsonObject(resultText);
  const agents: unknown[] = Array.isArray(parsed?.agents) ? parsed.agents : [];
  return agents
    .filter((entry: unknown): entry is Record<string, unknown> => {
      return !!entry && typeof entry === 'object' && (entry as Record<string, unknown>).status === 'timeout';
    })
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '(unknown)',
      role: typeof entry.role === 'string' ? entry.role : undefined,
      status: 'timeout',
      childStatus: typeof entry.childStatus === 'string' ? entry.childStatus : undefined,
      summary: typeof entry.summary === 'string' ? entry.summary : undefined,
    }));
}

function formatChildDrainTimeoutAnswer(timeouts: Array<{ id: string; role?: string; childStatus?: string; summary?: string }>): string {
  const lines = [
    `Children still running after the bounded wait (${timeouts.length}):`,
    ...timeouts.map((child) => {
      const role = child.role ? ` role=${child.role}` : '';
      const status = child.childStatus ? ` status=${child.childStatus}` : '';
      const summary = child.summary ? ` — ${child.summary}` : '';
      return `- ${child.id}${role}${status}${summary}`;
    }),
    '',
    'Use `/continue` to drain the pending child output and synthesize the result when it is ready.',
  ];
  return lines.join('\n');
}

function summarizeWaitedChildOutputs(resultText: string): string | undefined {
  const parsed = parseJsonObject(resultText);
  if (!parsed) return undefined;
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [parsed];
  const sections: string[] = [];
  for (const entry of agents) {
    if (!entry || typeof entry !== 'object') continue;
    const child = entry as Record<string, unknown>;
    const id = typeof child.id === 'string' ? child.id : undefined;
    const status = typeof child.status === 'string' ? child.status : undefined;
    const role = typeof child.role === 'string' ? child.role : undefined;
    const output = typeof child.finalOutput === 'string'
      ? child.finalOutput
      : (typeof child.error === 'string' ? `ERROR: ${child.error}` : undefined);
    if (!id || !output) continue;
    sections.push([
      `Child ${id}${role ? ` (${role})` : ''} ${status ? `[${status}]` : ''}`,
      output,
    ].join('\n'));
  }
  if (sections.length === 0) return undefined;
  const body = sections.join('\n\n---\n\n');
  const maxChars = getCliKnobs().childResultSystemChars;
  const clamped = body.length > maxChars
    ? `${body.slice(0, maxChars)}\n...[truncated ${body.length - maxChars} chars; use read_agent_transcript or /agent show <id> for full output]`
    : body;
  return [
    '<system-reminder id="child-results">',
    'Recently waited child-agent outputs are available below. Synthesize these results directly; do not ignore them or continue as if the children are still running.',
    '',
    clamped,
    '</system-reminder>',
  ].join('\n');
}

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

export interface ChatCompletionPayload {
  model: string;
  messages: any[];
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }>;
  tool_choice?: 'auto';
  /**
   * OpenAI Chat Completions reasoning slot — accepted by gpt-5 / o-series.
   * Only set when the user has chosen a non-default `/effort` AND the
   * endpoint+model combo accepts the field (see `supportsReasoningEffortField`).
   * The literal wire value is provider-specific (e.g. `high`, `xhigh`, `max`),
   * resolved by `resolveWireEffort`, so this is a free `string`.
   */
  reasoning_effort?: string;
  /**
   * Nested reasoning-effort form (`reasoning: { effort }`) — the shape LM Studio
   * documents on chat-completions. Emitted alongside / instead of the flat field
   * per the active provider's `effortField`. Same resolved value.
   */
  reasoning?: { effort: string };
}

export interface AgentOptions {
  workspaceRoot: string;
  launchCwd: string;
  sessionKey?: string;
  roleOverlay?: string;
  accessMode?: AccessMode;
  silent?: boolean;
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
  private mcpClient: McpClientWrapper;
  private llmConfig: LLMConfig;
  /** CLI-REINDEX — per-path stat signature of the last reindex, so unchanged
   *  files don't re-ship content to memory_reindex_source on every read. */
  private reindexSignatures = new Map<string, string>();
  /** HEADLESS-EVENTS — per-turn listener for code-index refreshes, set from
   *  RunTurnCallbacks.onCodeIndex at the top of runTurn (executeLocalTool has
   *  no callbacks param, so we bridge through the instance). */
  private codeIndexListener: ((e: { file: string; chunks: number }) => void) | null = null;
  public sessionKey: string;
  /**
   * Federation Stage 3 — the per-process key the `attachFederation`
   * runtime registered against the brain. Used by `/dm` and
   * `/broadcast` so the recipient sees the sender's federation
   * identity (which appears in `/agents --remote`) rather than the
   * agent's per-chat sessionKey (which rotates per `/new`).
   */
  private federationSessionKey: string | null = null;
  public setFederationSessionKey(key: string | null): void {
    this.federationSessionKey = key;
  }
  public getFederationSessionKey(): string | null {
    return this.federationSessionKey;
  }
  public workspaceRoot: string;
  public launchCwd: string;
  private chatHistory: any[] = [];
  /** MAS-P5-T2: per-session cache of full tool results, keyed by resultRef. */
  // MEM-22 — retention is configurable via cli.offloadRetentionMs / cli.offloadMaxEntries.
  private readonly resultCache = new ResultCache(getCliKnobs().offloadRetentionMs, getCliKnobs().offloadMaxEntries);
  /** PARITY-E3: set once we've switched to cli.fallbackModel this turn. */
  private triedModelFallback = false;
  private initialized = false;
  private recalledRecordIds: string[] = [];
  private recalledRecords: RecalledRecord[] = [];
  private lastBriefingSources: string[] = [];
  private lastBriefingDetails: LastBriefingDetails = {
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
  private lastKnownMcpTools?: Array<{ name: string }>;
  /**
   * 0.3.9 item 9 — content hash of the currently pinned memory anchor.
   * `null` means no anchor has been pinned yet this session (or
   * /refresh-memory just cleared it). When set, subsequent briefings
   * either no-op (same hash → STABLE) or append (different hash →
   * APPEND) rather than rewriting the prefix system message.
   */
  private pinnedAnchorHash: string | null = null;
  /**
   * 0.3.9 item 11 — repair pipeline (lazy: instantiated on first use so
   * the allowed-tool-names set reflects the live MCP inventory). Reset
   * at the start of every fresh user turn via `resetStorm()` so a
   * fresh intent doesn't inherit prior repetition state.
   */
  private toolCallRepair: ToolCallRepair | null = null;
  /** 0.3.9 item 11 — last repair report, surfaced via /briefing debug. */
  private lastRepairReport: RepairReport | null = null;
  /**
   * 0.4.3 (CLI-8) — session-cumulative repair telemetry. The per-turn report
   * is reset every intent; these totals persist across the session (reset only
   * by `resetSessionCounters()`) so `/context` can show how often the
   * tool-call repair pipeline had to intervene — a health signal for the
   * model/transport pairing.
   */
  private repairTotals = { scavenged: 0, truncationsFixed: 0, truncationsUnrecoverable: 0, stormsBroken: 0, turnsWithRepair: 0 };
  /** 0.3.9 item 13 — count of NEEDS_HIGH escalations this turn, bounded so a marker loop can't churn. */
  private tierEscalationsThisTurn = 0;
  /**
   * 0.3.9 token-tally rework: most-recent authoritative `prompt_tokens`
   * from the provider's `usage` payload. The compaction trigger prefers
   * this over the content-aware estimator because the provider charged
   * us for exactly this number — no rounding, no JSON-syntax inflation,
   * no language-class bucket guesses. `undefined` on turn 1 and after a
   * successful compaction (the compact log doesn't reflect the prior
   * `prompt_tokens` value).
   */
  private lastSeenPromptTokens: number | undefined;
  /**
   * 0.4.x-3b (`/rewind --files`) — file-restore undo log state. `snapshotsThisTurn`
   * is null at turn start; on the first file mutation of a turn we lazily compute
   * `fileSnapshotTurn` (the user-turn ordinal from the transcript) and capture
   * each touched file's prior content once. See state/fileSnapshotStore.ts.
   */
  private fileSnapshotTurn = 0;
  private snapshotsThisTurn: Set<string> | null = null;
  // CC-P6.4 — resolved paths this agent has READ this session. Gates
  // edit_file / write-overwrite on a prior read so the model can't clobber a
  // file it hasn't seen (Claude Code's read-before-edit contract). Reset by
  // loadHistory / fork / bootstrapSession (see clearSessionState).
  private filesReadThisSession = new Set<string>();
  // WS5 — commits the agent itself created THIS session (process-lifetime, NOT
  // reset per turn). The destructive-command guard allows `git commit --amend`
  // only when HEAD is in this set; a resumed session starts empty, so amending a
  // pre-existing commit is blocked (fail-safe).
  private agentAuthoredCommits = new Set<string>();
  /** MAS-READMANIFEST (B2) — the files this agent has read this session, so the
   *  phase orchestrator can forward a "already mapped" manifest to later phases
   *  (a child reads deltas, not the whole tree cold). */
  public get filesRead(): string[] {
    return [...this.filesReadThisSession];
  }
  // CC-P9.2 — once-per-session task-tracking reminder latch.
  private taskTrackingNudged = false;
  // CC-P6.5 — per-turn verification gate: did the workspace get mutated, and
  // did a build/test/lint run? Reset at the top of each runTurn.
  private mutatedThisTurn = false;
  private verifiedThisTurn = false;
  // Scoping hardening — the actual files written THIS turn (edit-tool paths),
  // so the gate can tell a docs/config-only change from a code change, and an
  // opaque file-writing shell command (path unknown → can't be ruled docs-only).
  private filesWrittenThisTurn: string[] = [];
  private shellWroteThisTurn = false;
  // DESK-2 / CC-P1.5 — cooperative turn interrupt. Set by requestInterrupt()
  // (desktop Stop button / TUI Esc); checked at every LLM-call and tool
  // boundary so a long multi-tool turn stops at the next seam instead of
  // running to completion. Reset at the top of each runTurn.
  private interruptRequested = false;
  // DESK-6 — the per-turn abort controller. requestInterrupt() aborts it, which
  // cancels the in-flight LLM fetch, running shell/MCP tools, and child waits
  // IMMEDIATELY (not at the next cooperative seam). Recreated each turn.
  private turnAbort: AbortController | null = null;
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
  private recallHasFiredThisSession = false;
  private recallNextTurnIsPostCompaction = false;
  private turnsSinceLastFullBriefing = 0;
  private recentToolFailure?: string;
  private roleOverlay?: string;
  private accessMode: AccessMode;
  /** POLICY-1 — audit trail of execution-policy decisions on mutating tools. */
  private policyAudit: Array<{ tool: string; action: ActionKind; decision: PolicyDecision; reason: string }> = [];
  private silent: boolean;
  /**
   * CODEX-SANDBOX-UNATTENDED — captured ONCE at construction so the
   * silent-enforcement decision is stable for the whole session (knobs are
   * load-time config; this also makes the policy immune to mid-turn knob-cache
   * resets, which matters for the concurrent shared-process test runner).
   */
  private readonly sandboxEnforceWhenSilent: boolean;
  private enableRecall: boolean;
  private systemPromptOverride?: string;
  /**
   * Name of the BrainRouter skill currently being executed (e.g. via `/skill`
   * or implicit memetic activation). Threaded into `memory_recall` and
   * `memory_capture_turn` so skill-scoped recall boost, neural-spark
   * prewarming, and per-record `skill_tag` extraction all fire correctly.
   * Null/undefined when no skill is active.
   */
  public activeSkill?: string;
  /**
   * Parent trace context (set by spawn_agent for child agents). When present,
   * the per-turn span uses these as its trace/parent so OTEL viewers can
   * stitch the fan-out tree together. Top-level (REPL) agents leave these
   * undefined and get a fresh trace per turn.
   */
  private parentTraceId?: string;
  private parentSpanId?: string;
  /**
   * Synthetic agent id used in OTEL attributes so child spans can be grouped
   * even without trace links. Equals `agent-<6 random hex>` per Agent
   * instance. Surfaced as the `agent_id` / `parent_agent_id` span attrs.
   */
  public readonly agentId: string = `agent-${Math.random().toString(36).slice(2, 8)}`;
  /** agent_id of the parent (set by spawn_agent for children). */
  private parentAgentId?: string;
  /** Agent tier — forwarded to OrchestrationContext so grandchildren can inherit hierarchy checks. */
  public readonly tier?: 'chat' | 'reasoning' | 'worker';
  /** Spawn-chain depth (0 = direct chat-root child). Forwarded to hierarchy checks. */
  public readonly agentDepth: number;
  /** MAS-P3 ownership glob; file writes outside it are refused. Null = no boundary. */
  private ownership: string | null;
  /** MAS-P4-T1 per-agent tool scope (from the agent def); undefined = no filter. */
  private toolScope?: { local: string[]; mcp: string[] };
  private disallowedTools: string[];
  /** MAS-P4-T1 — MCP tools trimmed by the budget this turn (model-facing names). */
  private lastBudgetHiddenTools = new Set<string>();
  /** 0.4.x-5 — per-child reasoning-effort override; falls back to session /effort. */
  private effortOverride?: EffortLevel;
  private confirmToolApproval?: AgentOptions['confirmToolApproval'];
  private interactionPort?: AgentOptions['interactionPort'];
  // §ADR-003 — injected interactive prompter (default = headless/no-TTY stub).
  private prompter: InteractivePrompter;
  // DESK-5n — parent's review stance, for the silent-child Auto-mode bypass.
  private parentReviewPolicy?: AgentOptions['parentReviewPolicy'];
  private parentExecutionMode?: AgentOptions['parentExecutionMode'];

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

  private async confirmSilentChildToolApproval(info: {
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
  private async confirmRunWorkflowLaunch(args: Record<string, any>): Promise<boolean> {
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
  private async captureArtifactToMemory(record: ArtifactRecord): Promise<void> {
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

  private isModelVisibleMcpTool(tool: any): boolean {
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

  private rawMcpToolName(name: string): string {
    const serverId = this.serverIdFromMcpToolName(name);
    return serverId ? name.slice(`mcp_${serverId}_`.length) : name;
  }

  private serverIdFromMcpToolName(name: string): string | undefined {
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
   * MAS-P4-T1 — the most recent user message text, used to rank MCP tools by
   * relevance when the catalog exceeds the budget. Empty string when there's
   * no user turn yet (the cap then keeps the first N in stable order).
   */
  private latestUserText(): string {
    for (let i = this.chatHistory.length - 1; i >= 0; i--) {
      const m: any = this.chatHistory[i];
      if (m?.role === 'user' && typeof m.content === 'string') return m.content;
    }
    return '';
  }

  private allowedToolsForAccess(): Set<string> {
    // CODEX-TOOL-REGISTRY — the exposure set is GENERATED from the single
    // tool registry (`agent/tools/registry.ts`), which also declares each
    // tool's action kind + parallel-safety. A guard test keeps the registry,
    // the execution policy, and the parallel whitelist from drifting (the
    // class of bug REVIEW-FIX fixed). Read-tier tools (incl. lifecycle +
    // orchestration observers) are always available; write/shell add their
    // tiers on top.
    return registryAllowedTools(this.accessMode);
  }

  async runTurn(prompt: string, callbacks: RunTurnCallbacks, opts?: { hiddenPrompt?: boolean }): Promise<string> {
    if (!this.initialized) {
      await this.bootstrapSession(callbacks);
    }
    this.lastTurnUsage = { promptTokens: 0, completionTokens: 0, calls: 0, cachedTokens: 0, missedTokens: 0 };
    this.lastTurnToolCalls = 0;
    // CC-P6.5 — per-turn verification tracking (mutated workspace? ran a check?).
    this.mutatedThisTurn = false;
    this.verifiedThisTurn = false;
    this.filesWrittenThisTurn = [];
    this.shellWroteThisTurn = false;
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
    const filteredLocalTools = localToolSpecsFromExecutors().filter(
      (t) =>
        allowed.has(t.name) &&
        !MODEL_HIDDEN_TOOLS.has(t.name) &&
        !(hideWorkerTools && WORKER_THREAD_TOOLS.has(t.name)),
    );
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
    if (this.toolScope || this.disallowedTools.length > 0) {
      visibleMcpTools = applyToolScope(visibleMcpTools, {
        allow: this.toolScope?.mcp,
        disallow: this.disallowedTools,
      });
    }
    const toolBudget = getCliKnobs().agentMcpToolBudget;
    if (toolBudget > 0 && visibleMcpTools.length > toolBudget) {
      const taskText = this.latestUserText();
      const { kept, hidden } = rankAndCapTools(visibleMcpTools, taskText, toolBudget);
      for (const t of hidden) {
        this.lastBudgetHiddenTools.add(String(t?.name ?? ''));
      }
      visibleMcpTools = kept;
      callbacks.onStatusUpdate(`Tool budget: showing ${kept.length}/${kept.length + hidden.length} MCP tools (most task-relevant).`);
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
    // Threshold: `BRAINROUTER_AUTO_COMPACT_TOKENS` (default 80_000). Single
    // absolute knob — the model's max context window is NOT used as the
    // driver because (a) hitting 75% of a 1M-context model still costs
    // real money and the user might want to compact much earlier, (b)
    // smaller models with tight windows are better served by a hard
    // ceiling the user explicitly set.
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
      const autoCompactThreshold = getCliKnobs().autoCompactTokens;
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
      for (const r of submitResults) {
        const d = parseHookDecision(r.stdout);
        const denied = d?.decision === 'deny' || (!d && r.exitCode !== 0);
        if (denied) {
          const reason = d?.reason?.trim() || (r.stderr || r.stdout || '').toString().trim() || `Hook ${r.hook.id} blocked this prompt`;
          return `Prompt blocked by user-prompt-submit hook: ${reason}`;
        }
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

    const userMsg = { role: 'user', content: prompt };
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
    // Multi-agent workflows (explorers → wait → architect → wait → write spec
    // → write tasks) can easily eat 10-15 iterations. 20 was too tight and
    // caused workflows to abort mid-architect. Cap defaults to 60 and is
    // overridable via BRAINROUTER_MAX_TOOL_LOOPS for very heavy workflows.
    const maxLoops = Math.max(5, getCliKnobs().maxToolLoops);
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
    const TOOL_SEQUENCE_GUARD_LIMIT = Math.max(3, getCliKnobs().repeatToolSequenceLimit);
    const sequenceGuardExempt = new Set(getCliKnobs().repeatSequenceExemptTools);
    const spawnedChildIdsThisTurn = new Set<string>();
    const waitedChildIdsThisTurn = new Set<string>();
    const buildOrchestrationContext = (): OrchestrationContext => ({
      workspaceRoot: this.workspaceRoot,
      parentSessionKey: this.sessionKey,
      interruptSignal: this.turnAbort?.signal, // DESK-6 — Stop unblocks child waits
      parentAccessMode: this.accessMode,
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
        // per-run effort override (0.4.x-5) uses that instead.
        const selectedEffort = this.effortOverride ?? resolveActiveMode(this.workspaceRoot, this.sessionKey).effort;
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
          shouldFallbackModel(this.llmConfig.model, getCliKnobs().fallbackModel, this.triedModelFallback)
        ) {
          // PARITY-E3: the primary model isn't available at this endpoint.
          // Switch to cli.fallbackModel for the rest of the session and
          // retry ONCE (the triedModelFallback flag prevents a loop).
          const from = this.llmConfig.model;
          const fallback = getCliKnobs().fallbackModel as string;
          this.triedModelFallback = true;
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
        const verificationDecision = decideVerification({
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
            : buildVerificationNudge();
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
            // CC-P3.2 — declarative cli.permissions rules run FIRST: a deny match
            // blocks outright; an allow match downgrades an `ask` below (it never
            // overrides a mode-based deny — rules can't escalate read mode).
            const ruleDecision = evaluatePermissionRules(
              getCliKnobs().permissions, name, primaryArgText(name, args as Record<string, unknown> | null));
            if (ruleDecision === 'deny') {
              throw new Error(`Tool "${name}" denied: matched a cli.permissions deny rule.`);
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
              throw new Error(`Tool "${name}" denied by execution policy: ${policy.reason}.`);
            }
            if (policy.decision === 'ask' && this.silent) {
              throw new Error(`Tool "${name}" requires approval but this session can't prompt (fail-closed): ${policy.reason}.`);
            }
            // POLICY-3 — external-directory gate: a file write whose target
            // escapes the workspace is governed by the profile's
            // `externalDirWrites` mode (deny / ask / allow). Independent of the
            // access-mode decision above.
            if (policy.action === 'file_edit' && typeof args?.path === 'string' && args.path) {
              const target = path.resolve(this.workspaceRoot, args.path);
              const ext = externalDirectoryDecision(target, this.workspaceRoot, getCliKnobs().externalDirWrites, isPathWithinRoots);
              if (ext.decision === 'deny') {
                throw new Error(`Tool "${name}" denied: ${ext.reason}.`);
              }
              if (ext.decision === 'ask' && this.silent) {
                throw new Error(`Tool "${name}" requires approval (external write) but this session can't prompt: ${ext.reason}.`);
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
          if (isOrchestrationToolName(name)) {
            // WF-NO-NEST — a silent/child agent (itself a spawned worker, incl.
            // a workflow PHASE agent) must never launch its own workflow. That
            // recursion is what produced the "lots of workflows" runaway: a
            // build worker called run_workflow → a nested install/verify
            // workflow → token blow-up, with no human to approve it. Phase work
            // is done DIRECTLY (or via plain spawn_agents, depth-capped); only a
            // top-level, user-facing agent may launch a workflow.
            if (name === 'run_workflow' && this.silent) {
              isError = true;
              resultText =
                'run_workflow is not available to a spawned/child agent — nested workflows are blocked ' +
                '(they recurse and run unattended). Do this work directly with the regular tools ' +
                '(read_file, write_file, edit_file, run_command), or use spawn_agents for genuinely ' +
                'independent sub-tasks.';
              summary = 'nested run_workflow blocked';
            } else if (name === 'run_workflow' && !(await this.confirmRunWorkflowLaunch(args))) {
              isError = true;
              resultText =
                'run_workflow declined — the workflow launch was not approved (workflows fan out ' +
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
            const mcpApproval = assessMcpToolApproval(name, mcpToolByName.get(name));
            if (mcpApproval.requiresApproval) {
              if (this.silent) {
                if (!this.confirmToolApproval) {
                  throw new Error(`MCP tool "${name}" requires approval but this silent session has no parent approver: ${mcpApproval.reason}.`);
                }
                const approved = await this.confirmToolApproval({
                  tool: name,
                  arguments: mcpArgs,
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
          runHooks(this.workspaceRoot, 'post-tool', {
            tool: name,
            payload: { args, ok: !isError, summary, resultPreview: resultText.slice(0, 1000) },
          });
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
      finalAnswer =
        `I could not finish before the tool-call loop limit of ${maxLoops} was reached. ` +
        `Use \`/continue\` to pick up where I left off (drain pending children, finish writing artifacts), ` +
        `\`/agents\` to see what's running, or set BRAINROUTER_MAX_TOOL_LOOPS to a higher number.`;
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
          { promptTokens: this.lastTurnUsage.promptTokens, completionTokens: this.lastTurnUsage.completionTokens, calls: this.lastTurnUsage.calls },
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

  private async executeLocalTool(name: string, args: Record<string, any>): Promise<string> {
    const executor = localToolExecutor(name);
    if (executor) {
      return executor.handle({
        args,
        legacyHandle: (toolName, toolArgs) => this.executeLocalToolLegacy(toolName, toolArgs),
      });
    }
    return this.executeLocalToolLegacy(name, args);
  }

  private async executeLocalToolLegacy(name: string, args: Record<string, any>): Promise<string> {
    // Bind path resolution to this agent's workspace, never to process.cwd().
    // The Agent might have been constructed with a workspace different from
    // the launching shell's cwd (e.g. /resume from another dir), and cwd can
    // drift in unexpected ways. Explicit beats implicit here.
    const resolveHere = (p: string, opts: { forWrite?: boolean } = {}) =>
      resolveWorkspacePath(this.workspaceRoot, p, opts);
    switch (name) {
      case 'read_file': {
        const resolved = resolveHere(args.path);
        if (!fs.existsSync(resolved)) {
          throw new Error(`File not found: ${args.path}`);
        }
        const content = fs.readFileSync(resolved, 'utf8');
        this.filesReadThisSession.add(resolved); // CC-P6.4 — read-before-edit ledger
        // CLI-REINDEX — keep the code index fresh on read; fire-and-forget so
        // reads stay snappy, and guarded so a rejection never escapes.
        void this.maybeReindexSource(resolved, content).catch(() => {});
        const startLine = args.startLine ? Number(args.startLine) : 1;
        const endLine = args.endLine ? Number(args.endLine) : undefined;

        if (startLine === 1 && endLine === undefined) {
          // CC-P7.3 — cap an unbounded full-file read so a huge file can't blow
          // the context window; the model gets an explicit reread affordance.
          return truncateFullRead(content, String(args.path)).text;
        }

        const lines = content.split('\n');
        const endIdx = endLine !== undefined ? Math.min(endLine, lines.length) : lines.length;
        const startIdx = Math.max(1, Math.min(startLine, lines.length));
        
        if (startIdx > endIdx) {
          return '';
        }
        
        return lines.slice(startIdx - 1, endIdx).join('\n');
      }
      case 'write_file': {
        const resolved = resolveHere(args.path, { forWrite: true });
        const ownErr = ownershipWriteViolation(this.ownership, this.workspaceRoot, resolved);
        if (ownErr) throw new Error(ownErr);
        // CC-P6.4 — read-before-overwrite. Creating a NEW file is fine, but
        // overwriting an EXISTING one the agent hasn't read this session would
        // blow away content it never saw. Require a read_file first in that case.
        if (fs.existsSync(resolved) && !this.filesReadThisSession.has(resolved)) {
          throw new Error(`Read-before-overwrite: "${args.path}" already exists and you have not read it this session. read_file("${args.path}") first (then write_file replaces it intentionally), or use edit_file for a targeted change.`);
        }
        const parentDenial = await this.confirmSilentChildToolApproval({
          tool: 'write_file',
          path: String(args.path ?? ''),
          summary: `write ${String(args.content ?? '').length} chars`,
          reason: 'silent child agent requested a file write',
        });
        if (parentDenial) return parentDenial;
        // A successful overwrite means the on-disk content is now what the agent
        // wrote — keep the read ledger accurate so a follow-up edit is allowed.
        this.filesReadThisSession.add(resolved);
        this.captureFileSnapshot(resolved); // 0.4.x-3b — undo log for /rewind --files
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolved, args.content, 'utf8');
        const writeNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: resolved, cwd: this.workspaceRoot });
        const reindexNotice = await this.maybeReindexSource(resolved, args.content);
        return `Successfully wrote file: ${args.path}` + writeNotice + reindexNotice;
      }
      case 'edit_file': {
        const resolved = resolveHere(args.path);
        const ownErr = ownershipWriteViolation(this.ownership, this.workspaceRoot, resolved);
        if (ownErr) throw new Error(ownErr);
        if (!fs.existsSync(resolved)) {
          throw new Error(`File not found: ${args.path}`);
        }
        // CC-P6.4 — read-before-edit. Editing a file the agent hasn't read this
        // session risks clobbering content it can't see (stale assumptions,
        // mismatched indentation). Require a read_file first.
        if (!this.filesReadThisSession.has(resolved)) {
          throw new Error(`Read-before-edit: you must read_file("${args.path}") before editing it — you have not read this file this session. Read it first, then edit with targetContent that matches the current contents.`);
        }
        const content = fs.readFileSync(resolved, 'utf8');
        const target = args.targetContent;
        const replacement = args.replacementContent;

        const occurrences = content.split(target).length - 1;
        if (occurrences === 0) {
          throw new Error(`Target content not found in ${args.path}. Ensure targetContent matches exact indentation and newlines.`);
        }
        if (occurrences > 1) {
          throw new Error(`Target content found ${occurrences} times in ${args.path}. Specify more surrounding context to target uniquely.`);
        }

        const updated = content.replace(target, replacement);
        const parentDenial = await this.confirmSilentChildToolApproval({
          tool: 'edit_file',
          path: String(args.path ?? ''),
          summary: `replace ${String(target ?? '').length} chars with ${String(replacement ?? '').length} chars`,
          reason: 'silent child agent requested a file edit',
        });
        if (parentDenial) return parentDenial;
        this.captureFileSnapshot(resolved); // 0.4.x-3b — undo log for /rewind --files
        fs.writeFileSync(resolved, updated, 'utf8');
        const editNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: resolved, cwd: this.workspaceRoot });
        const editReindex = await this.maybeReindexSource(resolved, updated);
        return `Successfully edited ${args.path}` + editNotice + editReindex;
      }
      case 'list_dir': {
        const targetDir = resolveHere(args.path || '.');
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
          throw new Error(`Directory not found: ${args.path || '.'}`);
        }
        const items = fs.readdirSync(targetDir);
        const list = items.map(item => {
          const full = path.join(targetDir, item);
          const stat = fs.statSync(full);
          return {
            name: item,
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.isFile() ? stat.size : undefined
          };
        });
        return JSON.stringify(list, null, 2);
      }
      case 'grep_search': {
        const wsRoot = fs.realpathSync(this.workspaceRoot);
        const root = resolveHere(args.path || '.');
        const query = String(args.query ?? '');
        if (!query) throw new Error('Missing parameter "query" for grep_search.');
        // grepSearch: regex match (not literal `includes`) + accepts a file OR a
        // directory (the old inline version crashed with ENOTDIR on a file path).
        return JSON.stringify(grepSearch(query, root, wsRoot), null, 2);
      }
      case 'glob_files': {
        const pattern = args.pattern;
        if (!pattern) {
          throw new Error('Missing parameter "pattern" for glob_files.');
        }
        const matches = globFiles(pattern, this.workspaceRoot);
        return JSON.stringify(matches, null, 2);
      }
      case 'run_command': {
        const cmd = args.command;
        // CLI-11 — route the shell gate through the unified execution policy
        // (same outcome as the previous `accessMode !== 'shell'` check).
        const shellPolicy = decideExecutionPolicy('shell', this.accessMode);
        if (shellPolicy.decision === 'deny') {
          return `Command execution denied: ${shellPolicy.reason}.`;
        }
        // WS5 — destructive-command guard: BLOCK git/IaC actions the user didn't
        // ask for (reset --hard / checkout -- / clean -f / stash drop, an --amend
        // of a commit we didn't author this session, or an IaC destroy without the
        // stack named). Attended users can override via a confirm; silent/headless
        // agents are refused outright (they can't answer a prompt).
        let destructiveOverride = false;
        {
          const verdict = evaluateDestructiveCommand(cmd, {
            userIntent: this.lastUserPrompt,
            headSha: gitHeadSha(this.workspaceRoot),
            agentAuthoredCommits: this.agentAuthoredCommits,
          });
          if (verdict.decision === 'block') {
            if (this.silent || (!this.interactionPort && !this.prompter)) {
              return `Command blocked (${verdict.rule}): ${verdict.reason}`;
            }
            const approved = this.interactionPort
              ? await this.interactionPort.confirm({ title: 'Run destructive command?', detail: `${cmd}\n\n${verdict.reason}`, dangerous: true, tool: 'run_command' })
              : await this.prompter.askYesNo(`${verdict.reason}\nRun it anyway? (y/N) `, false);
            if (!approved) return `Command blocked (${verdict.rule}): ${verdict.reason}`;
            destructiveOverride = true; // user explicitly authorized — skip the redundant approval below
          }
        }
        // Approval gating routes through the pure resolver in
        // runtime/dangerousCommand.ts. Three outcomes:
        //   • auto-approve: fast mode + safe command (or silent child whose
        //     parent has opted in via fast mode).
        //   • ask: planning mode, OR fast mode but the command matched the
        //     dangerous heuristic (rm -rf, sudo, force-push, …).
        //   • deny-silent: silent child agents can't answer y/N, so safe
        //     commands need parent opt-in (fast mode) and dangerous commands
        //     are always denied.
        const prefs = readPreferences(this.workspaceRoot);
        // Gate from the ACTIVE SESSION's executionMode (session override >
        // workspace pref) so two chats in the same workspace can sit in
        // different modes — a `fast` chat auto-approves safe commands while a
        // `planning` chat still confirms.
        const baseMode = resolveActiveMode(this.workspaceRoot, this.sessionKey);
        // CHILD-EXEC-INHERIT — a silent child runs under its OWN childKey session
        // (orchestration/tools.ts), which carries no `/mode` override, so
        // resolveActiveMode falls back to the WORKSPACE default (often
        // `planning`) even when the PARENT is in fast/YOLO. That made a fast/YOLO
        // parent's workers stall on a parent-approval card for SAFE commands
        // (e.g. `ls`) despite "all permissions on". Mirror DESK-5n (which threads
        // `parentReviewPolicy` for the write/edit/patch gate): a silent child
        // inherits the parent's executionMode so it auto-approves SAFE commands
        // under fast/YOLO. The dangerous-command floor is UNCHANGED —
        // resolveRunCommandApproval still returns 'deny-silent' for dangerous
        // commands, which gates/denies below.
        const activeMode = this.silent && this.parentExecutionMode
          ? { ...baseMode, executionMode: this.parentExecutionMode }
          : baseMode;
        // 0.3.9 — pass `goalActive` so the resolver can auto-approve
        // SAFE commands when a /goal is active. Without this, the very
        // first run_command of a goal-mode session blocks the auto-
        // continuation on the askYesNo prompt, defeating the purpose of
        // "type a goal, walk away". Dangerous commands still ask.
        const goalForApproval = readGoal(this.workspaceRoot, this.sessionKey);
        const goalIsActive = !!(goalForApproval?.text && goalForApproval.status === 'active');
        const approval = destructiveOverride
          ? ('auto-approve' as const) // user already authorized the destructive command above — don't double-prompt
          : resolveRunCommandApproval(activeMode, cmd, { silent: this.silent, goalActive: goalIsActive, allowlist: getCliKnobs().commandAllowlist });
        let parentApproved = false;
        if (approval === 'deny-silent') {
          const dangerous = isDangerousCommand(cmd);
          if (this.confirmToolApproval) {
            const approved = await this.confirmToolApproval({
              tool: 'run_command',
              command: cmd,
              dangerous,
              reason: dangerous
                ? 'dangerous command requested by a silent child agent'
                : 'silent child agent shell command requires parent approval',
            });
            if (!approved) return 'Command execution rejected by parent approval.';
            parentApproved = true;
          } else if (dangerous) {
            return (
              `Command execution denied: dangerous command in a silent child agent. ` +
              `Silent children can't answer the y/N prompt, so destructive commands ` +
              `(rm -rf, sudo, force-push, …) are refused regardless of /mode. ` +
              `Have a parent agent run this command, or split it into a safer ` +
              `equivalent.`
            );
          } else {
            return (
              `Command execution denied: silent child agents may not run shell ` +
              `without parent opt-in. Switch the session to \`/mode fast\` (or set ` +
              `the legacy \`autoApproveShell\` pref) to let silent children run ` +
              `safe commands, or have a parent agent run this command.`
            );
          }
        }
        if (approval === 'auto-approve' || parentApproved) {
          const tag = this.silent
            ? (parentApproved ? 'Parent-approved (silent child)' : 'Auto-approved (silent child)')
            : goalIsActive && activeMode.executionMode !== 'fast'
              ? 'Auto-approved (/goal active)'
              : 'Auto-approved';
          console.log(chalk.gray(`▶  ${tag}: ${chalk.cyan(cmd)}`));
        } else {
          // approval === 'ask' — interactive y/N. Use the parent REPL's
          // readline interface; spinning up an inquirer prompt opens a second
          // readline against the same stdin and dumps a stray "line" event
          // back into the parent rl when it exits, which used to surface as
          // the bogus "A previous turn is still running" warning.
          //
          // The question we hand to `askYesNo` ALWAYS includes the command
          // itself. The legacy split — print command via `console.log`, then
          // ask "Allow execution? (y/N)" — works in the readline path because
          // both land on the same stream, but the Ink overlay (`runInkYesNo`)
          // only sees the question string. Without the command embedded here
          // the modal renders "Allow execution? (y/N)" with no context, and
          // the user has to take it on faith. Embedding the command keeps
          // both surfaces honest. (Fix flagged on 2026-05-27.)
          const dangerous = isDangerousCommand(cmd);
          // Legacy console.log kept so the readline path also has a visible
          // record above the prompt; the Ink path renders the same content
          // inside the modal title via the helper's structured string.
          // No leading `\n` — patchConsole already inserts a row boundary
          // when promoting this above the Ink frame, and adding our own
          // newline pushes the frame down an extra row every approval,
          // contributing to the "frame keeps growing / viewport scrolls
          // up" feel in main-screen mode. (0.3.9 — 2026-05-27)
          console.log(`${chalk.yellow('⚠️  Command execution request:')} ${chalk.cyan(cmd)}${dangerous ? chalk.red(' (potentially destructive)') : ''}`);
          const question = buildRunCommandPrompt(cmd);
          const approved = this.interactionPort
            ? await this.interactionPort.confirm({ title: 'Run shell command?', detail: cmd, dangerous, tool: 'run_command' })
            : await this.prompter.askYesNo(question, false);
          if (!approved) {
            return 'Command execution rejected by user.';
          }
        }

        // CC-P11.1 — background run: same approval gating as foreground (we are
        // past it here), but detach instead of blocking the turn. v1 runs
        // unsandboxed, so it is refused while cli.sandbox=on.
        if (args.background === true) {
          // CODEX-SANDBOX-UNATTENDED — background runs are unsandboxed (v1), so
          // they are refused whenever the sandbox is active: either the user
          // turned it on, or this is a silent/unattended agent where the
          // sandbox is enforced regardless of the global knob.
          const sandboxActive =
            getCliKnobs().sandbox === 'on' || (this.silent && this.sandboxEnforceWhenSilent);
          if (sandboxActive) {
            return 'Background run_command is not supported while the sandbox is active (v1) — run it foreground or disable the sandbox.';
          }
          const bg = startBackgroundShell({ command: cmd, cwd: this.launchCwd, workspaceRoot: this.workspaceRoot });
          return JSON.stringify({
            id: bg.id,
            status: bg.status,
            logPath: bg.logPath,
            note: 'Detached. Poll with task_output({ id }) — pass back nextOffset as fromByte to read incrementally. The turn is NOT blocked.',
          });
        }
        const sandboxConfig = resolveSandboxConfig(
          this.workspaceRoot,
          { readPaths: prefs.sandboxReadPaths, writePaths: prefs.sandboxWritePaths },
          { silent: this.silent, enforceWhenSilent: this.sandboxEnforceWhenSilent },
        );
        const result = await runShell(cmd, sandboxConfig, undefined, this.turnAbort?.signal);
        // WS5 — remember commits WE authored this session, so a later
        // `git commit --amend` of one of them is allowed (vs. amending a
        // pre-existing/user commit, which the guard blocks).
        if (result.exitCode === 0 && /\bgit\b[^|;&]*\bcommit\b/i.test(cmd)) {
          const head = gitHeadSha(this.workspaceRoot);
          if (head) this.agentAuthoredCommits.add(head);
        }
        const enforcedTag = sandboxConfig.enforcedUnattended ? ' (enforced: unattended)' : '';
        const sandboxBadge = result.sandboxed
          ? `[sandboxed via ${result.sandboxTool}${enforcedTag}] `
          : sandboxConfig.enabled
            ? `[sandbox requested but unavailable${enforcedTag}] `
            : '';
        const notice = result.notice ? `${result.notice}\n` : '';
        return `${notice}${sandboxBadge}Exit Code: ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
      }
      case 'fetch_url': {
        const url = args.url;
        // POLICY-3 — per-host egress allowlist (empty = unrestricted).
        const egress = egressDecision(url, getCliKnobs().egressAllowlist);
        if (egress.decision === 'deny') {
          return `fetch_url blocked by egress policy: ${egress.reason}.`;
        }
        try {
          // DESK-6 — abort on Stop OR a 30s ceiling (this fetch had neither).
          const fetchUrlSignal = AbortSignal.any([
            AbortSignal.timeout(30_000),
            ...(this.turnAbort?.signal ? [this.turnAbort.signal] : []),
          ]);
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; BrainRouterCLI/0.3.8)'
            },
            signal: fetchUrlSignal,
          });
          if (!res.ok) {
            throw new Error(`Failed to fetch URL: ${res.status} ${res.statusText}`);
          }
          const text = await res.text();
          if (url.includes('.html') || text.includes('<html') || text.includes('<!DOCTYPE html')) {
            const cleanText = text
              .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
              .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            return cleanText.slice(0, 15000);
          }
          return text.slice(0, 15000);
        } catch (err: any) {
          return `Failed to fetch URL ${url}: ${err.message}`;
        }
      }
      case 'web_search': {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('web_search requires a non-empty query.');
        const maxResults = Math.max(1, Math.min(10, Number(args.maxResults ?? 5)));
        return await runWebSearch(query, maxResults);
      }
      case 'lsp': {
        // CLI-19 — semantic navigation via a language server.
        const action = String(args.action ?? '').trim() as 'definition' | 'references' | 'hover' | 'symbols';
        if (!['definition', 'references', 'hover', 'symbols'].includes(action)) {
          throw new Error('lsp: action must be definition | references | hover | symbols.');
        }
        if (!args.file) throw new Error('lsp requires a `file`.');
        const resolved = resolveHere(String(args.file));
        const { runLspQuery } = await import('../lsp/manager.js');
        return await runLspQuery({
          action,
          file: resolved,
          line: args.line != null ? Number(args.line) : undefined,
          character: args.character != null ? Number(args.character) : undefined,
          cwd: this.workspaceRoot,
          servers: getCliKnobs().lspServers,
        });
      }
      case 'extract_result': {
        const resultRef = String(args.resultRef ?? '').trim();
        if (!resultRef) throw new Error('extract_result requires a resultRef.');
        const out = runExtractResult(
          {
            resultRef,
            query: typeof args.query === 'string' ? args.query : undefined,
            maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
          },
          this.resultCache,
        );
        return out.returned;
      }
      case 'spawn_worker_thread': {
        if (!canSpawnWorker(this.agentDepth)) {
          throw new Error('Workers cannot spawn workers (MAX_WORKER_DEPTH=1).');
        }
        const goal = String(args.goal ?? '').trim();
        if (!goal) throw new Error('spawn_worker_thread requires a goal.');
        const worker = spawnWorkerThread(this.mcpClient, this.llmConfig, {
          workspaceRoot: this.workspaceRoot,
          launchCwd: this.launchCwd,
          role: String(args.role ?? 'worker'),
          goal,
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          ownership: typeof args.ownership === 'string' ? args.ownership : (this.ownership ?? null),
          parentSessionKey: this.sessionKey,
          parentAccessMode: this.accessMode,
          spawnerDepth: this.agentDepth,
          effortOverride: this.effortOverride,
        });
        return JSON.stringify({ id: worker.id, status: worker.status, goal: worker.goal });
      }
      case 'wait_worker': {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('wait_worker requires an id.');
        const meta = await waitWorker(this.workspaceRoot, id, typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined);
        if (!meta) return JSON.stringify({ id, found: false });
        // Terminal → delivered in-turn; drop any pending next-turn feedback.
        // A timeout leaves status 'running', so its completion still reports later.
        if (meta.status !== 'running') acknowledgeCompletions(this.sessionKey, [id]);
        return JSON.stringify({ id, status: meta.status, summary: readWorkerSummary(this.workspaceRoot, id) ?? null });
      }
      case 'read_worker_summary': {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('read_worker_summary requires an id.');
        const meta = readWorkerMeta(this.workspaceRoot, id);
        if (!meta) return `No worker "${id}".`;
        return readWorkerSummary(this.workspaceRoot, id) ?? `Worker ${id} (${meta.status}) has no summary yet.`;
      }
      case 'close_worker': {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('close_worker requires an id.');
        const meta = closeWorker(this.workspaceRoot, id);
        return JSON.stringify({ id, status: meta?.status ?? 'unknown', closed: !!meta });
      }
      case 'mark_chapter': {
        // CC-P12.3 — persist a chapter marker into the session transcript.
        const title = String(args.title ?? '').trim();
        if (!title) throw new Error('mark_chapter requires a non-empty title.');
        if (title.length > 60) throw new Error('mark_chapter title must be under 60 chars.');
        const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : undefined;
        const marker = { role: 'system', name: CHAPTER_ENTRY_NAME, content: chapterEntryContent(title, summary) };
        this.recordTranscript(marker);
        return JSON.stringify({ marked: true, title, note: 'Chapter recorded — the user can browse with /chapters.' });
      }
      case 'task_output': {
        // CC-P11.1 — incremental output of a background run_command.
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('task_output requires an id (from run_command background:true).');
        const fromByte = typeof args.fromByte === 'number' && args.fromByte >= 0 ? Math.floor(args.fromByte) : 0;
        const out = readBackgroundOutput(id, fromByte);
        if (!out) return JSON.stringify({ id, found: false, note: 'Unknown background run (it dies with the CLI process).' });
        return JSON.stringify(out);
      }
      case 'wait_until': {
        // CC-P11.2 — block until a workspace file condition holds (or timeout).
        const condition = String(args.condition ?? '');
        if (condition !== 'file_exists' && condition !== 'file_contains') {
          throw new Error('wait_until requires condition "file_exists" or "file_contains".');
        }
        const watchPath = String(args.path ?? '').trim();
        if (!watchPath) throw new Error('wait_until requires a path.');
        if (condition === 'file_contains' && !String(args.text ?? '').trim()) {
          throw new Error('wait_until with file_contains requires `text`.');
        }
        const resolvedWatch = resolveHere(watchPath);
        const result = await waitUntilCondition({
          condition,
          resolvedPath: resolvedWatch,
          text: typeof args.text === 'string' ? args.text : undefined,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          pollMs: typeof args.pollMs === 'number' ? args.pollMs : undefined,
        });
        return JSON.stringify({ ...result, condition, path: watchPath });
      }
      case 'apply_patch': {
        const patch = String(args.patch ?? '');
        if (!patch.trim()) throw new Error('apply_patch requires a non-empty patch.');
        const ops = parsePatchEnvelope(patch);
        const safety = assessPatchSafety(ops);
        const parentDenial = await this.confirmSilentChildToolApproval({
          tool: 'apply_patch',
          summary: `${safety.adds} add, ${safety.updates} update, ${safety.deletes} delete, ${safety.renames} rename`,
          reason: safety.touchesVcs
            ? 'silent child agent requested a patch touching VCS metadata'
            : 'silent child agent requested a patch',
          dangerous: safety.touchesVcs || safety.deletes > 0,
        });
        if (parentDenial) return parentDenial;
        // 0.4.x-3b — capture each target file's prior content before the patch
        // applies (undo log for /rewind --files). Parse the envelope's file
        // headers (`*** Add/Update/Delete File: <path>`).
        for (const m of patch.matchAll(/^\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+)\s*$/gm)) {
          const p = m[1].trim();
          if (p) { try { this.captureFileSnapshot(path.resolve(this.workspaceRoot, p)); } catch { /* noop */ } }
        }
        {
          const result = applyPatchEnvelope(patch, this.workspaceRoot, this.ownership);
          const firstFile = patch.match(/^\*\*\*\s+(?:Add|Update) File:\s*(.+)\s*$/m)?.[1]?.trim();
          const checkFile = firstFile ? path.resolve(this.workspaceRoot, firstFile) : this.workspaceRoot;
          const patchNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: checkFile, cwd: this.workspaceRoot });
          let patchReindex = '';
          if (firstFile) {
            try { patchReindex = await this.maybeReindexSource(checkFile, fs.readFileSync(checkFile, 'utf8')); } catch { /* file may have been deleted */ }
          }
          return result + patchNotice + patchReindex;
        }
      }
      case 'update_plan': {
        const state = updatePlan(this.workspaceRoot, {
          explanation: args.explanation,
          plan: args.plan,
        }, this.sessionKey);
        // Auto mode has no approval prompt — record an auto-approval into the
        // plan history when this establishes a new plan version.
        this.maybeAutoApprovePlan(state);
        return formatPlan(state);
      }
      case 'track_query': {
        const action = String(args.action ?? 'list');
        if (action === 'board') {
          const project = trackGetProject(this.workspaceRoot) ?? trackEnsureProject(this.workspaceRoot);
          const items = trackListWorkItems(this.workspaceRoot);
          const columns = project.workflowStates.map((s) => ({
            state: s.name, id: s.id,
            items: items.filter((w) => w.status === s.id).map((w) => ({ key: w.key, type: w.type, title: w.title, priority: w.priority, assignee: w.assignee })),
          }));
          return JSON.stringify({ project: { key: project.key, name: project.name }, columns }, null, 2);
        }
        if (action === 'get') {
          const item = trackGetWorkItem(this.workspaceRoot, String(args.key ?? ''));
          return item ? JSON.stringify(item, null, 2) : `No work item "${args.key}".`;
        }
        if (action === 'sprints') {
          return JSON.stringify(trackListSprints(this.workspaceRoot), null, 2);
        }
        if (action === 'sprint-detail') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          return JSON.stringify({ sprint, items: trackListWorkItems(this.workspaceRoot, { sprintId }) }, null, 2);
        }
        if (action === 'velocity') {
          const sprintId = typeof args.sprintId === 'string' ? args.sprintId : undefined;
          if (sprintId) {
            const velocity = trackSprintVelocity(this.workspaceRoot, sprintId);
            return velocity === undefined ? `No sprint "${sprintId}".` : JSON.stringify({ sprintId, velocity });
          }
          return JSON.stringify(trackListSprints(this.workspaceRoot).map((sprint) => ({
            sprintId: sprint.id,
            velocity: trackSprintVelocity(this.workspaceRoot, sprint.id) ?? 0,
          })), null, 2);
        }
        const items = trackListWorkItems(this.workspaceRoot, {
          status: typeof args.status === 'string' ? args.status : undefined,
          type: isWorkItemType(args.type) ? args.type : undefined,
          assignee: typeof args.assignee === 'string' ? args.assignee : undefined,
          text: typeof args.text === 'string' ? args.text : undefined,
        });
        return JSON.stringify(items.map((w) => ({ key: w.key, type: w.type, status: w.status, statusCategory: w.statusCategory, priority: w.priority, title: w.title, assignee: w.assignee })), null, 2);
      }
      case 'track_update': {
        const action = String(args.action ?? '');
        if (action === 'create') {
          const item = trackCreateWorkItem(this.workspaceRoot, {
            title: String(args.title ?? 'Untitled'),
            type: isWorkItemType(args.type) ? args.type : 'task',
            status: typeof args.status === 'string' ? args.status : undefined,
            priority: isWorkItemPriority(args.priority) ? args.priority : undefined,
            sessionKey: this.sessionKey, actor: 'agent',
          });
          return `Created ${item.key} [${item.status}]: ${item.title}`;
        }
        if (action === 'transition') {
          try {
            const item = trackTransitionWorkItem(this.workspaceRoot, String(args.key ?? ''), String(args.toStatus ?? ''), 'agent');
            return item ? `${item.key} → ${item.status}` : `No work item "${args.key}".`;
          } catch (e) { return (e as Error).message; }
        }
        if (action === 'comment') {
          const item = trackAddComment(this.workspaceRoot, String(args.key ?? ''), 'agent', String(args.body ?? ''));
          return item ? `Commented on ${item.key}.` : `No work item "${args.key}".`;
        }
        if (action === 'link') {
          const item = trackLinkWorkItem(this.workspaceRoot, String(args.key ?? ''), {
            codeLinks: Array.isArray(args.codeLinks) ? (args.codeLinks as Array<{ kind: 'branch' | 'commit' | 'pull-request' | 'file'; ref: string }>) : undefined,
            linkedMemoryIds: Array.isArray(args.linkedMemoryIds) ? (args.linkedMemoryIds as string[]) : undefined,
            links: typeof args.blocks === 'string' ? [{ type: 'blocks', targetId: args.blocks }] : undefined,
          });
          return item ? `Linked ${item.key}.` : `No work item "${args.key}".`;
        }
        if (action === 'assign-sprint') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          const item = trackUpdateWorkItem(this.workspaceRoot, String(args.key ?? ''), { sprintId }, 'agent');
          return item ? `Assigned ${item.key} to ${sprint.name}.` : `No work item "${args.key}".`;
        }
        if (action === 'sprint-create') {
          const name = String(args.name ?? '').trim();
          if (!name) return 'sprint-create requires a name.';
          const sprint = trackCreateSprint(this.workspaceRoot, {
            name,
            goal: typeof args.goal === 'string' ? args.goal : undefined,
          });
          return `Created ${sprint.name} (${sprint.id}).`;
        }
        if (action === 'batch-transition') {
          const query = String(args.query ?? '').trim();
          if (!query) return 'batch-transition requires a query.';
          const parsed = parseTrackQuery(query);
          if (!parsed.ok) return `Bad query: ${parsed.error}`;
          const toStatus = String(args.toStatus ?? '');
          const project = trackGetProject(this.workspaceRoot) ?? trackEnsureProject(this.workspaceRoot);
          if (!project.workflowStates.some((state) => state.id === toStatus)) {
            return `Unknown workflow state "${toStatus}". Valid: ${project.workflowStates.map((state) => state.id).join(', ')}`;
          }
          const items = trackListWorkItems(this.workspaceRoot, { query }).filter((item) => item.status !== toStatus);
          for (const item of items) trackTransitionWorkItem(this.workspaceRoot, item.key, toStatus, 'agent');
          return `Transitioned ${items.length} work item${items.length === 1 ? '' : 's'} to ${toStatus}.`;
        }
        if (action === 'sprint-start') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          if (args.capacity !== undefined && (typeof args.capacity !== 'number' || !Number.isFinite(args.capacity) || args.capacity < 0)) {
            return 'Sprint capacity must be a non-negative number.';
          }
          try {
            trackSetSprintState(this.workspaceRoot, sprintId, 'active');
          } catch (error) {
            return (error as Error).message;
          }
          const updated = trackUpdateSprint(this.workspaceRoot, sprintId, {
            startDate: sprint.startDate ?? new Date().toISOString(),
            ...(typeof args.capacity === 'number' ? { capacity: args.capacity } : {}),
          })!;
          return `Started ${updated.name}.`;
        }
        if (action === 'sprint-complete') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          const velocity = trackSprintVelocity(this.workspaceRoot, sprintId)!;
          trackUpdateSprint(this.workspaceRoot, sprintId, { velocity });
          trackSetSprintState(this.workspaceRoot, sprintId, 'completed');
          return `Completed ${sprint.name} (velocity: ${velocity}).`;
        }
        return `Unknown track_update action "${action}". Use create · transition · comment · link · sprint-create · assign-sprint · batch-transition · sprint-start · sprint-complete.`;
      }
      case 'artifact_write': {
        // §AV-4 — in-band artifact authoring. With `id` it grows an EXISTING
        // artifact (a new version, editedBy 'agent') — this is how a later turn
        // or a sub-agent targets the same artifact across sessions. Without `id`
        // it creates one. Content edits are versioned by the store (§AV-1).
        const content = typeof args.content === 'string' ? args.content : '';
        if (!content.trim() && !args.id) {
          throw new Error('artifact_write: `content` is required when creating a new artifact.');
        }
        const format: ArtifactFormat = isArtifactFormat(args.format) ? args.format : 'markdown';
        const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : '';
        if (id) {
          if (!getArtifact(this.workspaceRoot, id)) throw new Error(`artifact_write: no artifact "${id}" to update.`);
          const patch: Record<string, unknown> = { content, format };
          if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
          if (typeof args.summary === 'string') patch.summary = args.summary;
          if (typeof args.language === 'string' && args.language.trim()) patch.language = args.language.trim();
          const updated = updateArtifact(this.workspaceRoot, id, patch, { editedBy: 'agent', note: typeof args.note === 'string' ? args.note : undefined });
          if (!updated) throw new Error(`artifact_write: failed to update "${id}".`);
          await this.captureArtifactToMemory(updated);
          return `Updated artifact ${updated.id} → v${updated.currentVersion} (${updated.kind}, ${updated.format}): ${updated.title}`;
        }
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        if (!title) throw new Error('artifact_write: `title` is required when creating a new artifact.');
        const kind: ArtifactKind = isArtifactKind(args.kind) ? args.kind : 'markdown-report';
        const created = createArtifact(this.workspaceRoot, {
          kind, title, format, content,
          language: typeof args.language === 'string' ? args.language : undefined,
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          sessionKey: this.sessionKey,
          editedBy: 'agent',
        });
        await this.captureArtifactToMemory(created);
        return `Created artifact ${created.id} (v1, ${created.kind}, ${created.format}): ${created.title}. Update it later with artifact_write({ id: "${created.id}", content }).`;
      }
      case 'workflow_progress': {
        const slug = getCurrentWorkflow(this.workspaceRoot, this.sessionKey);
        if (!slug) {
          return 'No active workflow — nothing to track. (Bind one with /review, /simplify, /feature-dev, /spec, or /implement-plan.)';
        }
        const step = String(args.step ?? '').trim();
        const status = String(args.status ?? '').trim() as 'running' | 'done' | 'failed' | 'skipped';
        if (!step) throw new Error('workflow_progress requires a non-empty `step` id.');
        if (!['running', 'done', 'failed', 'skipped'].includes(status)) {
          throw new Error(`workflow_progress: status must be running|done|failed|skipped (got "${status}").`);
        }
        const run = advanceRunStep(this.workspaceRoot, slug, step, status, {
          note: args.note ? String(args.note) : undefined,
          sessionKey: this.sessionKey,
          pid: process.pid,
        });
        const { done, total } = summarizeRun(run);
        return `Workflow "${slug}": step "${step}" → ${status} (${done}/${total} done, run ${run.status}).`;
      }
      case 'ask_user_choice': {
        // PARITY — accept either the single-question fields or a batched
        // `questions[]` array (asked in turn, answers returned together). The
        // single form keeps its `{answer}` shape; batched returns `{answers}`.
        const rawQuestions: any[] = Array.isArray(args.questions) && args.questions.length
          ? args.questions
          : [{ question: args.question, header: args.header, options: args.options, multiSelect: args.multiSelect }];
        const specs = rawQuestions.map((rq, qi) => {
          const where = rawQuestions.length > 1 ? ` (question ${qi + 1})` : '';
          const q = String(rq?.question ?? '').trim();
          const h = String(rq?.header ?? '').trim();
          const rawOptions: any[] = Array.isArray(rq?.options) ? rq.options : [];
          if (!q) throw new Error(`ask_user_choice requires a non-empty \`question\`${where}.`);
          if (!h) throw new Error(`ask_user_choice requires a non-empty \`header\`${where}.`);
          if (rawOptions.length < 2 || rawOptions.length > 4) {
            throw new Error(`ask_user_choice requires 2–4 options${where}; received ${rawOptions.length}.`);
          }
          const options = rawOptions.map((o, i) => {
            const label = String(o?.label ?? '').trim();
            const description = String(o?.description ?? '').trim();
            if (!label) throw new Error(`ask_user_choice option ${i + 1}${where} is missing "label".`);
            if (!description) throw new Error(`ask_user_choice option ${i + 1}${where} is missing "description".`);
            return { label, description };
          });
          return { question: q, header: h, options, multiSelect: !!rq?.multiSelect };
        });
        const batched = specs.length > 1;
        // Back-compat aliases for the guard/trace code below (single-question).
        const question = specs[0].question;
        const options = specs[0].options;
        // Silent child agents have no parent stdin/REPL bridge, so the
        // helper's TTY check would error anyway — but giving a clearer message
        // up front saves the LLM an iteration.
        if (this.silent) {
          throw new NoTTYError(
            'ask_user_choice is not available to silent child agents. Decide the answer yourself, ' +
            'state which option you picked and why, and return that as your final answer to the parent.',
          );
        }
        // Autonomy bypass. The picker is suppressed in two cases:
        //
        //   1. /yolo on (executionMode=fast AND reviewPolicy=proceed) —
        //      the user has explicitly opted out of in-turn prompts.
        //   2. /goal active — the user has typed a goal and the auto-
        //      continuation loop is running; blocking on a picker
        //      stalls the whole reason /goal exists. The model decides
        //      itself and states which option in its reply.
        //
        // Both refusal messages use NoTTYError so the existing model
        // contract ("fall back to deciding yourself") fires verbatim.
        // A trace event records which axis triggered the bypass.
        const yoloPrefs = resolveActiveMode(this.workspaceRoot, this.sessionKey);
        const yoloOn = yoloPrefs.executionMode === 'fast' && yoloPrefs.reviewPolicy === 'proceed';
        const goalForPicker = readGoal(this.workspaceRoot, this.sessionKey);
        const goalActiveForPicker = !!(goalForPicker?.text && goalForPicker.status === 'active');
        if (yoloOn || goalActiveForPicker) {
          const reason = yoloOn && goalActiveForPicker ? 'yolo+goal' : yoloOn ? 'yolo' : 'goal';
          traceEvent('ask_user_choice.bypass', {
            reason,
            question,
            optionLabels: options.map((o) => o.label),
          });
          const triggerNote = yoloOn
            ? '/yolo (executionMode=fast + reviewPolicy=proceed)'
            : `the active /goal "${goalForPicker!.text.slice(0, 80)}${goalForPicker!.text.length > 80 ? '…' : ''}"`;
          throw new NoTTYError(
            `ask_user_choice was suppressed by ${triggerNote}. ` +
            'The user has explicitly opted out of in-turn prompts — pick the option you would pick, ' +
            'state which one you picked and why in your reply, and keep going. ' +
            (yoloOn
              ? 'Toggle off with /yolo off if you actually need to ask.'
              : 'Stop the goal with /goal pause or /goal clear if you actually need to ask.'),
          );
        }
        // Eager TTY check so we fail without disturbing the screen. askChoice
        // also checks (defense-in-depth for direct callers), but doing it here
        // means the LLM gets a clean error before the picker tries to render.
        // DESK-3 — UI dialog path: no TTY needed when an interaction port is
        // attached. A dismissed dialog mirrors the NoTTY contract verbatim.
        // Ask ONE spec, returning the chosen label(s). Same gates for every
        // spec — the DESK-3 UI dialog path when a port is attached, else the
        // TTY picker.
        const askOne = async (spec: { question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }): Promise<string | string[]> => {
          if (this.interactionPort) {
            const labels = await this.interactionPort.choice({
              question: spec.question, header: spec.header, options: spec.options, multiSelect: spec.multiSelect,
            });
            if (!labels || labels.length === 0) {
              throw new NoTTYError(
                'The user dismissed the choice dialog. ' +
                'Fall back to deciding yourself and state which option you picked and why.',
              );
            }
            return spec.multiSelect ? labels : labels[0];
          }
          if (!this.prompter.getActiveReadline() || !process.stdin.isTTY) {
            throw new NoTTYError(
              'ask_user_choice requires an interactive TTY. ' +
              'Fall back to deciding yourself and state which option you picked and why.',
            );
          }
          // header is rendered by the picker itself (chip line at the top of
          // the frame), so we just thread it through opts.
          return await this.prompter.askChoice(spec.question, spec.options, { multiSelect: spec.multiSelect, header: spec.header });
        };

        if (!batched) {
          return JSON.stringify({ answer: await askOne(specs[0]) });
        }
        // Batched: ask each in turn, key answers by header (fallback question).
        const answers: Record<string, string | string[]> = {};
        for (const spec of specs) {
          answers[spec.header || spec.question] = await askOne(spec);
        }
        return JSON.stringify({ answers });
      }
      case 'goal_complete': {
        const proof = String(args.proof ?? '').trim();
        if (!proof) throw new Error('goal_complete requires a non-empty proof.');
        // Plan-honesty guard: refuse to mark the goal complete while the
        // active plan still has pending / in_progress items. The model
        // built that plan as its own contract — declaring done while items
        // remain open is misleading (this is the exact bug the user hit
        // when /goal analyze fired with 3 of 4 plan items still ☐). The
        // model must either finish the work, explicitly mark dropped
        // items completed via update_plan (creating an audit trail), or
        // switch to goal_blocked.
        const plan = readPlan(this.workspaceRoot, this.sessionKey);
        const open = plan.items.filter((i) => i.status !== 'completed');
        if (open.length > 0) {
          const open_summary = open
            .map((i) => `  - [${i.status === 'in_progress' ? '⏳' : '☐'}] ${i.step}`)
            .join('\n');
          throw new Error(
            `goal_complete refused: the active plan still has ${open.length} incomplete item(s):\n${open_summary}\n\n` +
            `Do ONE of:\n` +
            `  1. Finish the remaining work, then call update_plan to mark those items completed.\n` +
            `  2. If you decided to drop them, call update_plan FIRST and mark them completed with a brief explanation (the plan is your honest record — leaving items pending while declaring done is misleading).\n` +
            `  3. Call goal_blocked instead if no defensible path remains.\n\n` +
            `Then retry goal_complete in the same response as the user-visible prose summary.`
          );
        }
        const goal = completeGoal(this.workspaceRoot, this.sessionKey, proof);
        if (!goal) return 'No active goal to complete.';
        this.lastGoalTransition = 'complete';
        return `Goal marked complete. Proof: ${proof}`;
      }
      case 'goal_blocked': {
        const reason = String(args.reason ?? '').trim();
        if (!reason) throw new Error('goal_blocked requires a non-empty reason.');
        const needed = String(args.needed ?? '').trim();
        const note = needed ? `${reason} (needed: ${needed})` : reason;
        const goal = blockGoal(this.workspaceRoot, this.sessionKey, note);
        if (!goal) return 'No active goal to block.';
        this.lastGoalTransition = 'blocked';
        return `Goal marked blocked. Reason: ${note}`;
      }
      default:
        throw new Error(`Unknown local tool: ${name}`);
    }
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
  public async compactHistory(): Promise<{ summary: string; estimatedTokens: number; durationMs: number; replacedMessages: number } | null> {
    if (this.chatHistory.length < 4) return null;
    // CC-P4.2 — advisory pre-compact hook (notify/log; cannot block).
    if (this.hookAdvisoryActive()) { try { runHooks(this.workspaceRoot, 'pre-compact', { payload: { messages: this.chatHistory.length } }); } catch { /* advisory */ } }
    const before = this.chatHistory.length;
    const userMessages = this.chatHistory.filter((m) => m.role === 'user');
    const lastUserMessage = userMessages.length > 0 ? String(userMessages[userMessages.length - 1].content ?? '') : undefined;
    const result = await runCompaction(this.llmConfig, {
      messages: this.chatHistory.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        name: m.name,
      })),
      workspaceRoot: this.workspaceRoot,
      lastUserMessage,
    });
    const next: any[] = [this.createSystemMessage(), { role: 'system', content: renderCompactSystemMessage(result.summary) }];
    if (lastUserMessage) next.push({ role: 'user', content: lastUserMessage });
    this.chatHistory = next;
    this.initialized = true;
    // 9b: compaction just dropped the prior briefing as collateral —
    // force the next turn through the full recall path even in gated
    // mode so the model isn't blind to what was load-bearing.
    this.recallNextTurnIsPostCompaction = true;
    return { ...result, replacedMessages: before };
  }

  /**
   * DESK-2 / CC-P1.5 — request a cooperative stop of the running turn. Safe to
   * call from any callback or IPC handler; the turn unwinds at the next
   * LLM-call or tool boundary with a clean "interrupted" answer.
   */
  public requestInterrupt(): void {
    this.interruptRequested = true;
    // DESK-6 — abort the in-flight LLM fetch / shell child / MCP call / child
    // waits NOW, so Stop unwinds in well under a second instead of waiting out
    // the whole model response (up to llmTimeoutMs) or a long tool.
    this.turnAbort?.abort();
    // DESK-6 — cascade to any in-flight delegated children of THIS session so a
    // Stop winds the whole tree down, not just the parent (scoped by sessionKey
    // so sibling sessions are untouched).
    try {
      for (const child of childAgentsFor(this.sessionKey)) child.requestInterrupt();
    } catch { /* orchestration module not loaded / no children */ }
  }

  /** Runtime model switch. Used by `/model` slash command. */
  public setModel(model: string): void {
    this.llmConfig = { ...this.llmConfig, model };
  }
  public getModel(): string {
    return this.llmConfig.model;
  }

  /**
   * 0.4.x-4b (`/context`) — best estimate of the CURRENT context-window fill
   * in tokens. Prefers the provider's last `usage.prompt_tokens` (the truest
   * count); falls back to the content-aware estimate of `chatHistory` for
   * turn 1 / silent runs. This is the exact signal auto-compact triggers on,
   * so `/context` and the auto-compact threshold agree.
   */
  public getCurrentContextTokens(): number {
    return this.lastSeenPromptTokens !== undefined && this.lastSeenPromptTokens > 0
      ? this.lastSeenPromptTokens
      : estimateChatHistoryTokens(this.chatHistory as any);
  }

  /**
   * CLI-5 — read-only snapshot of the cache-stable prefix's components (system
   * message + pinned memory anchors) from the live chat history. Tool-list
   * fingerprinting is omitted here (the per-turn tool set isn't retained on the
   * agent); `/context prefix` diffs this across invocations for drift labels.
   */
  public getPrefixComponents(): PrefixComponents {
    return computePrefixComponents(this.chatHistory as any, []);
  }

  /**
   * WS0 — record one logical LLM call's cache-stable prefix into the session
   * stability tally and emit drift telemetry. Called once per call (in
   * `invokeLlmResilient`, before the retry loop, so retries don't double-count).
   * The prefix slice (system message + pinned anchors + tool list) is what the
   * provider prefix-caches; the per-attempt tool-call-pairing sanitize only
   * touches the append region, so deriving it from `this.chatHistory` here is
   * equivalent to the sanitized request. Pure observability — wrapped so a
   * tally/telemetry failure can never break a turn.
   */
  private recordPrefixStability(messages: readonly unknown[], tools: readonly unknown[]): void {
    try {
      const curr = computePrefixComponents(messages as any, tools as any);
      const drift = accumulatePrefixStability(this.prefixStability, this.prevPrefixComponents, curr);
      this.prevPrefixComponents = curr;
      this.lastTurnUsage.lastPrefixFingerprint = computePrefixFingerprint(messages as any, tools as any);
      traceEvent('llm_call.prefix_drift', {
        model: this.llmConfig.model,
        changed: drift.changed,
        labels: drift.labels,
        stableCalls: this.prefixStability.stableCalls,
        bustCalls: this.prefixStability.bustCalls,
      });
    } catch {
      /* observability only — never let prefix accounting break a turn */
    }
  }

  /** WS0 — session prefix-cache stability summary (for `/tokens` + the usage view). */
  public getPrefixStability(): { stableCalls: number; bustCalls: number; ratio: number; lastLabels: string[] } {
    return {
      stableCalls: this.prefixStability.stableCalls,
      bustCalls: this.prefixStability.bustCalls,
      ratio: prefixStabilityRatio(this.prefixStability),
      lastLabels: this.prefixStability.lastLabels,
    };
  }

  /**
   * CLI-4 — `/bg`: run a prompt as a DETACHED background worker. Reuses the
   * proven worker-thread infra (a separate in-process Agent + on-disk
   * transcript/status), so there's no concurrency hazard with the foreground
   * turn's chat history. Manage via `/workers` (list / attach / close) or `/ps`.
   */
  public spawnBackgroundWorker(goal: string): { id: string; status: string; goal: string } {
    const worker = spawnWorkerThread(this.mcpClient, this.llmConfig, {
      workspaceRoot: this.workspaceRoot,
      launchCwd: this.launchCwd,
      role: 'worker',
      goal,
      parentSessionKey: this.sessionKey,
      parentAccessMode: this.accessMode,
      spawnerDepth: this.agentDepth,
      effortOverride: this.effortOverride,
    });
    return { id: worker.id, status: worker.status, goal: worker.goal };
  }

  /**
   * 0.4.3 (CLI-8) — session-cumulative tool-call repair telemetry, surfaced by
   * `/context`. Returns a copy so callers can't mutate the running totals.
   */
  public getRepairTotals(): { scavenged: number; truncationsFixed: number; truncationsUnrecoverable: number; stormsBroken: number; turnsWithRepair: number } {
    return { ...this.repairTotals };
  }

  /**
   * FOOTER-TELEMETRY-2 — the counters behind the `offload` statusline segment:
   * cumulative child-agent token spend + child-output chars kept out of the
   * parent's context window this session. Both are in-memory, so the footer can
   * read them every render without a disk scan. (See `/tokens` / `/context` for
   * the full per-child breakdown sourced from session usage on disk.)
   */
  public getOffloadTotals(): { childTokensSpent: number; offloadCharsAvoided: number; compactedToolCharsAvoided: number } {
    return {
      childTokensSpent: this.memoryMetrics.childTokensSpent,
      offloadCharsAvoided: this.memoryMetrics.offloadCharsAvoided,
      compactedToolCharsAvoided: this.memoryMetrics.compactedToolCharsAvoided,
    };
  }

  /**
   * 0.4.x-3b (`/rewind --files`) — record a file's prior content the first time
   * it's mutated this turn, tagged with the user-turn ordinal. Lazily computes
   * the ordinal from the transcript on the turn's first capture (the user
   * message is already recorded by then). Best-effort: never throws into a tool.
   */
  /**
   * Auto mode (executionMode=fast + reviewPolicy=proceed) skips the plan
   * approval prompt — the agent just proceeds. Without this the plan history
   * would have NO record that the plan was acted on. So when the agent
   * establishes a new plan VERSION under auto mode, record an `actor: 'auto'`
   * approval (snapshotting the plan, captured to memory like an explicit
   * approval), deduped by step-signature so it fires once per version — not on
   * every status tick. Main-session only (silent child agents are internal).
   * Best-effort: it never throws into the tool path.
   */
  private maybeAutoApprovePlan(state: PlanState): void {
    try {
      if (this.silent) return;                       // child agents: internal, no user-facing history
      if (!state.items.length) return;               // no plan to approve
      const mode = resolveActiveMode(this.workspaceRoot, this.sessionKey);
      if (mode.executionMode !== 'fast' || mode.reviewPolicy !== 'proceed') return; // not auto mode
      const history = readPlanHistory(this.workspaceRoot, this.sessionKey);
      const latest = history.length ? history[history.length - 1] : undefined;
      // Already recorded this exact plan version (any verdict) → don't duplicate.
      if (latest && planStepSignature(latest.planSnapshot) === planStepSignature(state.items)) return;
      const decision = recordPlanDecision(this.workspaceRoot, this.sessionKey, {
        verdict: 'approved',
        actor: 'auto',
        planSnapshot: state.items,
        explanation: state.explanation,
        requirementId: state.requirementId,
      });
      // Capture to memory like the explicit approvals (fire-and-forget — never
      // block update_plan on an MCP round-trip).
      void emitAgentEvent(
        { mcpClient: this.mcpClient, sessionKey: this.sessionKey },
        {
          kind: 'agent_output',
          summary: `Plan auto-approved (auto mode) (${decision.id}) — ${state.items.length} item(s)`,
          payload: { planDecisionId: decision.id, verdict: 'approved', actor: 'auto', itemCount: state.items.length, requirementId: state.requirementId },
        },
      ).then((memoryId) => {
        if (memoryId) { try { linkPlanDecision(this.workspaceRoot, this.sessionKey, decision.id, memoryId); } catch { /* advisory */ } }
      }).catch(() => { /* advisory */ });
    } catch { /* advisory — auto-approval must never break update_plan */ }
  }

  private captureFileSnapshot(absPath: string): void {
    try {
      const rel = path.relative(this.workspaceRoot, absPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return; // outside workspace
      if (this.snapshotsThisTurn === null) {
        // First mutation of the turn — resolve the turn ordinal once.
        const users = readTranscriptEntries(this.workspaceRoot, this.sessionKey, Number.MAX_SAFE_INTEGER)
          .filter((e) => e.role === 'user').length;
        this.fileSnapshotTurn = users;
        this.snapshotsThisTurn = new Set();
      }
      if (this.snapshotsThisTurn.has(rel)) return; // only the turn's first touch
      this.snapshotsThisTurn.add(rel);
      const priorContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null;
      recordFileMutation(this.workspaceRoot, this.sessionKey, { turn: this.fileSnapshotTurn, path: rel, priorContent });
    } catch {
      /* snapshotting must never break a tool call */
    }
  }

  /**
   * CLI-REINDEX (0.4.5) — keep the brain's code index fresh from the file
   * read/edit paths. Stat-gated (skips unchanged files), offline-safe, and
   * scoped to code files. Returns a short notice when a reindex actually
   * happened (empty string otherwise — including every skip/error path), so
   * callers can append it without branching. Never throws: index upkeep must
   * not break a file operation.
   */
  private async maybeReindexSource(resolved: string, content: string): Promise<string> {
    try {
      const connected = typeof (this.mcpClient as any).isConnected === 'function'
        ? !!(this.mcpClient as any).isConnected()
        : true;
      let signature: string;
      try {
        const st = fs.statSync(resolved);
        signature = reindexSignature({ size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        return ''; // file gone (e.g. a delete) — nothing to index
      }
      const gate: ReindexGate = {
        enabled: getCliKnobs().autoReindex,
        connected,
        filePath: resolved,
        signature,
        lastSignature: this.reindexSignatures.get(resolved),
      };
      if (!shouldReindex(gate)) return '';
      // B7 (MEM-CHURN) — capture the file's recent git churn at index time so the
      // brain can decay memories anchored to volatile files faster. Best-effort;
      // null (non-git / untracked) is omitted so the brain leaves decay unchanged.
      const churn = gitChurnSignal(this.workspaceRoot, resolved);
      const res = await callMcpTool<{ status?: string; chunks?: number; staleMarked?: boolean }>(
        this.mcpClient,
        'memory_reindex_source',
        {
          file: resolved,
          content,
          language: languageHint(resolved),
          commitCount90d: churn.commitCount90d ?? undefined,
          lastCommitDate: churn.lastCommitDate ?? undefined,
        },
      );
      // Leave the signature unrecorded on failure so it retries on the next
      // touch; only mark it once the brain confirms it saw this content.
      if (res.isError) return '';
      this.reindexSignatures.set(resolved, signature);
      if (res.parsed?.status === 'reindexed') {
        const chunks = typeof res.parsed.chunks === 'number' ? res.parsed.chunks : 0;
        // HEADLESS-EVENTS — emit a code_index event for headless consumers.
        try { this.codeIndexListener?.({ file: resolved, chunks }); } catch { /* listener must not break a file op */ }
        return `\n[code index refreshed: ${chunks} chunk${chunks === 1 ? '' : 's'}]`;
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * 0.3.9 item 13 — read-only snapshot of the active LLM config for
   * slash commands that need the provider id (e.g. `/tier`).
   */
  public getLlmConfig(): LLMConfig {
    return { ...this.llmConfig };
  }

  /**
   * Runtime LLM config swap — `/config` calls this after persisting
   * provider / apiKey / endpoint changes so the LIVE agent picks up the
   * new values without a CLI restart. Pre-0.3.10 only `setModel` existed,
   * so changing the API key or endpoint via /config updated the on-disk
   * config but the running agent kept using the stale values from
   * construction time — users had to restart the CLI for changes to
   * take effect.
   *
   * Merges with the current llmConfig so callers can pass partial
   * updates (e.g. just the endpoint).
   */
  public setLLMConfig(next: Partial<LLMConfig>): void {
    this.llmConfig = { ...this.llmConfig, ...next };
  }
  public getLLMConfig(): LLMConfig {
    return this.llmConfig;
  }

  /** Runtime access-mode cycle for `/permissions` and Shift+Tab plan-mode toggle. */
  public getAccessMode(): AccessMode {
    return this.accessMode;
  }
  public setAccessMode(mode: AccessMode): void {
    this.accessMode = mode;
  }

  /** POLICY-1 — the session's execution-policy audit trail (mutating-tool
   * decisions). Read-only snapshot for observability / tests. */
  public getPolicyAudit(): ReadonlyArray<{ tool: string; action: ActionKind; decision: PolicyDecision; reason: string }> {
    return this.policyAudit;
  }

  /**
   * Seed the chat history from a persisted transcript so the user can resume
   * a previous session. The system message is regenerated for the current
   * runtime so workspace/session context is fresh, but the user/assistant/tool
   * messages are kept verbatim.
   */
  public loadHistory(entries: Array<{ role: string; content?: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>): number {
    const replay = entries
      .filter((e) => e.role === 'user' || e.role === 'assistant' || e.role === 'tool')
      .map((e) => {
        const msg: any = { role: e.role, content: typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? '') };
        if (e.name) msg.name = e.name;
        if (e.tool_call_id) msg.tool_call_id = e.tool_call_id;
        if (e.tool_calls) msg.tool_calls = e.tool_calls;
        return msg;
      });
    // The transcript is replayed VERBATIM, so a prior turn that died after
    // emitting an assistant `tool_calls` but before its `tool` results were
    // persisted leaves an orphaned call. Sending that on the next turn fails
    // every request with `400 ... tool call result does not follow tool call
    // (2013)` — bricking the resumed session. Repair the pairing once on load.
    this.chatHistory = [this.createSystemMessage(), ...sanitizeToolCallPairing(replay)];
    this.initialized = true;
    // DESK-5t — the resumed history is a DIFFERENT session; the prior
    // session's last prompt count no longer describes this context. Reset so
    // getCurrentContextTokens() estimates the freshly-loaded history (the
    // context ring then reflects THIS session immediately, before any turn).
    this.lastSeenPromptTokens = undefined;
    this.filesReadThisSession.clear(); // CC-P6.4 — replayed reads aren't fresh reads
    // 9b: a freshly-loaded history is a session boundary; reset gated
    // recall state so the next turn refreshes the briefing.
    this.recallHasFiredThisSession = false;
    this.recallNextTurnIsPostCompaction = false;
    return replay.length;
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
  private prevPrefixComponents: PrefixComponents | null = null;

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

  /** Last assistant message of the most recent turn — used by `/copy`. */
  public lastAnswer = '';

  /** Last user prompt (post-mention-expansion). Used by `/continue` to resume after a loop-limit abort. */
  public lastUserPrompt = '';

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

  private async bootstrapSession(callbacks: RunTurnCallbacks): Promise<void> {
    if (this.silent) {
      this.chatHistory = [this.createSystemMessage()];
      this.initialized = true;
      return;
    }
    callbacks.onStatusUpdate('Resolving BrainRouter session...');
    const resolved = await callMcpTool<{ sessionKey?: string }>(this.mcpClient, 'memory_resolve_session', {
      workspacePath: this.workspaceRoot,
      suggestedKey: this.sessionKey,
    });
    if (!resolved.isError && resolved.parsed?.sessionKey) {
      this.sessionKey = resolved.parsed.sessionKey;
    }
    // If resolution failed (missing tool, network), keep the deterministic session key we already have.

    this.chatHistory = [this.createSystemMessage()];
    this.initialized = true;
  }

  /**
   * Public, callback-free wrapper around bootstrapSession for slash commands
   * that mutate per-session state (notably `/goal`) BEFORE any runTurn has
   * fired. Without this, the FIRST `/goal` of a session writes goal.json
   * under the deterministic fallback sessionKey ("brainrouter-cli:<path>")
   * because bootstrap hasn't happened yet, but every subsequent runTurn
   * reads from the MCP-resolved UUID sessionKey — split-brain that left
   * the agent reading a stale goal from a different directory.
   *
   * Idempotent: returns immediately if already initialized. Tolerates
   * missing MCP — falls back to the deterministic key the same way
   * bootstrapSession does.
   */
  public async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    // Stub the callbacks bootstrapSession expects — no UI plumbing needed
    // for the eager-init path; the status line is for runTurn's spinner.
    await this.bootstrapSession({
      onStatusUpdate: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
    });
  }

  private createSystemMessage() {
    const prefs = readPreferences(this.workspaceRoot);
    const activeMode = resolveActiveMode(this.workspaceRoot, this.sessionKey);
    // 10b: pass the connected MCP tool inventory so `buildSystemPrompt`
    // can omit the BrainRouter memory section when the brain is offline.
    // The cached `lastKnownMcpTools` is populated by every successful
    // `listTools()` (see `runTurn` and `bootstrapSession`); when no tools
    // have been seen yet, leave it undefined — `buildSystemPrompt` treats
    // that as "assume brain online" for back-compat.
    const connectedMcpTools = this.lastKnownMcpTools?.map((t) => t.name);
    const base = this.systemPromptOverride ?? buildSystemPrompt({
      workspaceRoot: this.workspaceRoot,
      launchCwd: this.launchCwd,
      sessionKey: this.sessionKey,
      instructionSummary: loadWorkspaceInstructionSummary(this.workspaceRoot),
      personality: prefs.personality,
      activeSkill: this.activeSkill,
      // Planning/fast framing + review-policy framing reflect the ACTIVE
      // SESSION's stance (session override > workspace pref) so each chat's
      // system prompt matches its own mode. `effortOverride` (a per-run
      // child override) still wins when set.
      executionMode: activeMode.executionMode,
      reviewPolicy: activeMode.reviewPolicy,
      effort: this.effortOverride ?? activeMode.effort,
      connectedMcpTools,
      // Drive `modelFamilyOverlay`: weaker / OS / free-tier models
      // (Nemotron, Kimi, Llama, Qwen, Mistral, gpt-oss, DeepSeek, …)
      // pick up an aggressive Beast-mode reinforcement block; strong
      // families (claude-*, gpt-4/5, o-series, gemini-2.5) get no overlay.
      model: this.llmConfig.model,
    });
    const parts = [base];
    if (this.roleOverlay) parts.push(this.roleOverlay);
    // Goal text used to be appended here AND re-pushed as a per-turn
    // `goal-anchor` tagged system message (runTurn around line 680), which
    // meant the whole goal block landed in the prompt twice every turn.
    // 9d removed the duplicate; the per-turn anchor is the single owner
    // of goal state (text, status, budget, contract reminders, and the
    // final-budget wrap-up directive). `runTurn` re-injects it via
    // `formatGoalBlock` immediately before the user message is appended,
    // so even first-turn-after-`/resume` sees the goal.
    return {
      role: 'system',
      content: appendVerbositySteering(parts.join('\n\n'), getCliKnobs().verbositySteeringLevel),
    };
  }

  /** Create one draft requirement from a high-confidence user implementation request. */
  /**
   * BLOCKING hook events (pre-tool, user-prompt-submit) run for silent /
   * unattended agents too when `cli.hooks.enforceWhenSilent` (default on), so a
   * deny hook enforces policy on deep workers, headless, and cloud runs — not
   * just the interactive session. Cheap when no hooks are defined (no exec).
   */
  private hookEnforceActive(): boolean {
    const h = getCliKnobs().hooks;
    return h.enabled && (!this.silent || h.enforceWhenSilent);
  }

  /** ADVISORY hook events (pre/post-turn, post-tool, pre-compact) stay interactive-only. */
  private hookAdvisoryActive(): boolean {
    return getCliKnobs().hooks.enabled && !this.silent;
  }

  /**
   * EXTENSION-HOOKS — run the typed in-process handlers an extension registered
   * for `event` (the code analogue of shell hooks). For deny events (pre-tool /
   * user-prompt-submit) it returns the deny reason if any handler refuses; for
   * advisory events the result is ignored. A throwing handler never blocks.
   */
  private async runExtensionHooks(
    event: import('../hooks/hooksStore.js').HookEvent,
    ctx: { tool?: string; args?: Record<string, unknown> } = {},
  ): Promise<string | null> {
    const handlers = extensionHookHandlers(event);
    for (const h of handlers) {
      if (h.match && ctx.tool && !ctx.tool.includes(h.match)) continue;
      try {
        const r = await h.handle({ event, tool: ctx.tool, args: ctx.args, workspaceRoot: this.workspaceRoot });
        if (r === 'deny') return `Blocked by an extension ${event} hook`;
      } catch { /* a throwing handler is ignored, never blocks the call */ }
    }
    return null;
  }

  private autoCaptureRequirement(prompt: string, callbacks: RunTurnCallbacks): void {
    const automation = getCliKnobs().automation;
    if (this.silent || !automation.enabled || !automation.requirements.enabled) return;

    const openRequirements = listRequirements(this.workspaceRoot)
      .filter((record) => record.status !== 'done' && record.status !== 'archived')
      .map(({ title, acceptanceCriteria, status }) => ({ title, acceptanceCriteria, status }));
    const detection = detectRequirementShapedPrompt(prompt, {
      autoCreateThreshold: automation.requirements.autoCreateThreshold,
      lowActThreshold: automation.requirements.lowActThreshold,
      openRequirements,
    });
    if (detection.candidate && detection.input) {
      callbacks.onNotice?.({ level: 'info', message: `Requirement candidate detected: ${detection.input.title}` });
      return;
    }
    if (!detection.detected || !detection.input) return;

    // Tiered autonomy. Default ("propose"): capture as `draft` and surface a
    // one-click promote — the plan/Track cascade only runs once it's `ready`.
    // Autopilot (opt-in): a confident detection with concrete criteria is
    // created `ready` so the cascade runs unattended.
    const autopilot = automation.requirements.autopilot
      && detection.input.acceptanceCriteria.length >= 1
      && detection.confidence >= automation.requirements.autoCreateThreshold;
    const record = createRequirement(this.workspaceRoot, {
      ...detection.input,
      status: autopilot ? 'ready' : 'draft',
      sessionKey: this.sessionKey,
      origin: 'auto',
    });
    if (autopilot) {
      callbacks.onStatusUpdate(`Captured requirement ${record.id} (ready — planning + tracking it).`);
    } else {
      callbacks.onStatusUpdate(`Captured requirement ${record.id} as draft — promote with /requirement promote ${record.id} (or "Plan & track" in the Requirements panel) to plan + Track it.`);
      callbacks.onNotice?.({ level: 'info', message: `Requirement draft "${record.title}" — promote it to plan + Track (/requirement promote ${record.id}).` });
    }
    const provenance = { actor: 'agent', reason: autopilot ? 'auto-detect:autopilot' : 'auto-detect:draft' };
    void emitAgentEvent(
      { mcpClient: this.mcpClient, sessionKey: this.sessionKey },
      {
        kind: 'agent_output',
        summary: `Requirement ${record.id}: ${record.title} [${record.status}] (auto-detect)`,
        payload: {
          requirementId: record.id,
          title: record.title,
          status: record.status,
          acceptanceCriteria: record.acceptanceCriteria,
          provenance,
        },
      },
    ).then((memoryId) => {
      if (!memoryId) return;
      updateRequirement(this.workspaceRoot, record.id, { sourceEventId: memoryId });
      linkRequirement(this.workspaceRoot, record.id, { memoryId });
    }).catch(() => {});
  }

  /** Apply the bounded requirement → plan → Track reconciliation for this turn. */
  private autoSynchronizeRequirementPlanTrack(callbacks: RunTurnCallbacks): void {
    if (this.silent || this.agentDepth > 0) return;
    const { actions } = syncRequirementPlanTrack(this.workspaceRoot, this.sessionKey);
    if (actions.length === 0) return;

    callbacks.onStatusUpdate(`Automation: synchronized ${actions.length} Requirement → Plan → Track action${actions.length === 1 ? '' : 's'}.`);
    for (const action of actions) {
      const requirement = getRequirement(this.workspaceRoot, action.requirementId);
      const provenance = {
        sourceEventId: requirement?.sourceEventId,
        linkedMemoryIds: requirement?.linkedMemoryIds,
        actor: 'agent',
        reason: 'plan-track-sync',
      };
      void emitAgentEvent(
        { mcpClient: this.mcpClient, sessionKey: this.sessionKey },
        {
          kind: 'agent_output',
          summary: `Requirement automation ${action.kind}: ${action.title}`,
          payload: { ...action, provenance },
        },
      ).then((memoryId) => {
        if (!memoryId) return;
        linkRequirement(this.workspaceRoot, action.requirementId, { memoryId });
        if ('workItemId' in action) {
          trackLinkWorkItem(this.workspaceRoot, action.workItemId, { linkedMemoryIds: [memoryId] });
        }
      }).catch(() => {});
    }
  }

  /**
   * Sprint lifecycle automation. Default ("propose"): only SUGGEST create /
   * complete via a one-line notice — a human makes the irreversible org call.
   * Autopilot (opt-in, cli.automation.sprints.autopilot): auto-create a future
   * sprint + assign ready items + complete a done one (never auto-START).
   */
  private autoSynchronizeSprints(callbacks: RunTurnCallbacks): void {
    if (this.silent || this.agentDepth > 0) return;
    const options = getCliKnobs().automation.sprints;
    const actions = reconcileSessionSprints(this.workspaceRoot, {
      sessionKey: this.sessionKey,
      minItems: options.minItems,
      respectCapacity: options.respectCapacity,
      propose: !options.autopilot,
    });
    if (actions.length === 0) return;

    for (const action of actions) {
      // Propose-only suggestions mutate nothing — just nudge the human.
      if (action.kind === 'sprint-suggested') {
        callbacks.onNotice?.({ level: 'info', message: `${action.count} ready work item${action.count === 1 ? '' : 's'} aren't in a sprint — start one with /track sprint create.` });
        continue;
      }
      if (action.kind === 'sprint-complete-suggested') {
        callbacks.onNotice?.({ level: 'info', message: `Sprint "${action.sprintName}" is all done — complete it with /track sprint complete ${action.sprintId}.` });
        continue;
      }
      callbacks.onStatusUpdate(`Automation: sprint ${action.kind}.`);
      const workItems = 'workItemId' in action
        ? [trackGetWorkItem(this.workspaceRoot, action.workItemId)].filter(Boolean)
        : action.kind === 'sprint-completed'
          ? trackListWorkItems(this.workspaceRoot, { sprintId: action.sprintId })
          : [];
      const requirementIds = new Set<string>();
      for (const item of workItems) if (item?.requirementId) requirementIds.add(item.requirementId);
      const firstRequirement = [...requirementIds]
        .map((id) => getRequirement(this.workspaceRoot, id))
        .find(Boolean);
      const provenance = {
        sourceEventId: firstRequirement?.sourceEventId,
        linkedMemoryIds: firstRequirement?.linkedMemoryIds,
        actor: 'agent',
        reason: 'sprint-automation',
      };
      const actionLabel = action.kind === 'work-item-assigned'
        ? action.workItemKey
        : action.sprintName;
      void emitAgentEvent(
        { mcpClient: this.mcpClient, sessionKey: this.sessionKey },
        {
          kind: 'agent_output',
          summary: `Sprint automation ${action.kind}: ${actionLabel}`,
          payload: { ...action, provenance },
        },
      ).then((memoryId) => {
        if (!memoryId) return;
        for (const item of workItems) {
          if (item) trackLinkWorkItem(this.workspaceRoot, item.id, { linkedMemoryIds: [memoryId] });
        }
        for (const requirementId of requirementIds) {
          linkRequirement(this.workspaceRoot, requirementId, { memoryId });
        }
      }).catch(() => {});
    }
  }

  /** Mark the requirement anchored to a successfully completed goal as fulfilled. */
  private autoReconcileGoalCompletion(callbacks: RunTurnCallbacks): void {
    if (this.silent || this.agentDepth > 0) return;
    const automation = getCliKnobs().automation;
    if (!automation.enabled) return;
    if (readGoal(this.workspaceRoot, this.sessionKey)?.status !== 'complete') return;
    const requirementId = readPlan(this.workspaceRoot, this.sessionKey).requirementId;
    if (!requirementId) return;
    const requirement = getRequirement(this.workspaceRoot, requirementId);
    if (!requirement || requirement.status === 'done') return;

    const completed = updateRequirement(this.workspaceRoot, requirement.id, { status: 'done' });
    if (!completed) return;
    callbacks.onStatusUpdate(`Automation: marked requirement ${completed.id} done from the completed goal.`);
    const provenance = {
      sourceEventId: completed.sourceEventId,
      linkedMemoryIds: completed.linkedMemoryIds,
      actor: 'agent',
      reason: 'goal-complete-reconcile',
    };
    void emitAgentEvent(
      { mcpClient: this.mcpClient, sessionKey: this.sessionKey },
      {
        kind: 'agent_output',
        summary: `Requirement completed from goal: ${completed.title}`,
        payload: { requirementId: completed.id, status: completed.status, provenance },
      },
    ).then((memoryId) => {
      if (memoryId) linkRequirement(this.workspaceRoot, completed.id, { memoryId });
    }).catch(() => {});
  }

  /** Apply opt-in code-link transitions after a successful Track tool mutation. */
  private applyTrackCodeSignalAutomation(args: Record<string, any>, callbacks: RunTurnCallbacks): number {
    if (this.silent || this.agentDepth > 0) return 0;
    const automation = getCliKnobs().automation;
    if (!automation.enabled || !automation.sync.enabled) return 0;

    const action = String(args.action ?? '');
    if (action === 'transition') {
      const item = trackGetWorkItem(this.workspaceRoot, String(args.key ?? ''));
      if (item?.statusCategory === 'done' && String(args.toStatus ?? '') === item.status) {
        this.autoLinkDoneTrackItem(item, callbacks);
      }
      return 0;
    }
    if (action !== 'link' || !Array.isArray(args.codeLinks)) return 0;

    const project = trackGetProject(this.workspaceRoot) ?? trackEnsureProject(this.workspaceRoot);
    const inProgress = project.workflowStates.find((state) => state.id === 'in-progress')
      ?? project.workflowStates.find((state) => state.category === 'in-progress');
    const review = project.workflowStates.find((state) => state.id === 'in-review') ?? inProgress;
    if (!inProgress || !review) return 0;

    let advanced = 0;
    for (const codeLink of args.codeLinks) {
      if (!codeLink || !isCodeLinkKind(codeLink.kind) || typeof codeLink.ref !== 'string' || !codeLink.ref.trim()) continue;
      const target = codeLink.kind === 'pull-request' ? review : inProgress;
      for (const item of trackFindWorkItemsByCodeLink(this.workspaceRoot, { kind: codeLink.kind, ref: codeLink.ref })) {
        if (item.statusCategory === 'done' || item.status === target.id) continue;
        if (codeLink.kind !== 'pull-request' && item.statusCategory !== 'todo') continue;
        const moved = trackTransitionWorkItem(this.workspaceRoot, item.id, target.id, 'agent');
        if (!moved) continue;
        advanced += 1;
        this.captureTrackAutomationEvent({
          action: 'code-link-progress',
          item: moved,
          requirementId: moved.requirementId,
          codeLink: { kind: codeLink.kind, ref: codeLink.ref },
          fromStatus: item.status,
          toStatus: moved.status,
        });
      }
    }
    if (advanced > 0) callbacks.onStatusUpdate(`Automation: advanced ${advanced} Track item${advanced === 1 ? '' : 's'} from linked code evidence.`);
    return advanced;
  }

  /** Back-link a completed Track item once, retaining the requirement lifecycle for Phase 5. */
  private autoLinkDoneTrackItem(item: ReturnType<typeof trackGetWorkItem>, callbacks: RunTurnCallbacks): void {
    if (!item?.requirementId) return;
    const requirement = getRequirement(this.workspaceRoot, item.requirementId);
    if (!requirement || requirement.taskIds.includes(item.id)) return;
    linkRequirement(this.workspaceRoot, requirement.id, { taskId: item.id });
    callbacks.onStatusUpdate(`Automation: linked completed ${item.key} to requirement ${requirement.id}.`);
    this.captureTrackAutomationEvent({ action: 'requirement-fulfilled', item, requirementId: requirement.id });
  }

  private captureTrackAutomationEvent(input: {
    action: 'code-link-progress' | 'requirement-fulfilled';
    item: NonNullable<ReturnType<typeof trackGetWorkItem>>;
    requirementId?: string;
    codeLink?: { kind: string; ref: string };
    fromStatus?: string;
    toStatus?: string;
  }): void {
    const requirement = input.requirementId
      ? getRequirement(this.workspaceRoot, input.requirementId)
      : undefined;
    const provenance = {
      sourceEventId: requirement?.sourceEventId,
      linkedMemoryIds: requirement?.linkedMemoryIds,
      actor: 'agent',
      reason: input.action,
    };
    void emitAgentEvent(
      { mcpClient: this.mcpClient, sessionKey: this.sessionKey },
      {
        kind: 'agent_output',
        summary: `Track automation ${input.action}: ${input.item.key}`,
        payload: {
          action: input.action,
          workItemId: input.item.id,
          workItemKey: input.item.key,
          requirementId: input.requirementId,
          codeLink: input.codeLink,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          provenance,
        },
      },
    ).then((memoryId) => {
      if (!memoryId) return;
      trackLinkWorkItem(this.workspaceRoot, input.item.id, { linkedMemoryIds: [memoryId] });
      if (input.requirementId) linkRequirement(this.workspaceRoot, input.requirementId, { memoryId });
    }).catch(() => {});
  }

  private async injectRecallContext(prompt: string, mcpTools: any[], callbacks: RunTurnCallbacks): Promise<void> {
    const resetBriefing = (details: Partial<LastBriefingDetails>) => {
      this.recalledRecords = [];
      this.recalledRecordIds = [];
      this.lastBriefingSources = [];
      this.lastBriefingDetails = {
        decision: details.decision ?? 'none',
        reasons: details.reasons ?? [],
        sources: [],
        sourcesPlanned: details.sourcesPlanned ?? [],
        skippedSources: details.skippedSources ?? [],
        sourceStats: [],
        recordIds: [],
        recordCount: 0,
        tokensInjected: 0,
        charsSaved: details.charsSaved ?? 0,
        warnings: details.warnings ?? [],
      };
    };

    if (!this.enableRecall) {
      resetBriefing({ decision: 'skip', reasons: [this.silent ? 'silent agent (child)' : 'recall disabled'] });
      callbacks.onMemoryEvent?.({ kind: 'skipped', reason: this.silent ? 'silent agent (child)' : 'recall disabled' });
      return;
    }

    // 9b: gate recall instead of firing unconditionally every turn. Pre-9b
    // every turn paid ~3-10K tokens for a fresh briefing even when the user
    // message was "thanks" or "/help". The new default `gated` mode fires
    // recall only when it's likely to pay off:
    //   - turn 1 of the session (no prior briefing)
    //   - the turn immediately after auto-compaction (the model just lost
    //     context — give it back what was load-bearing)
    //   - when the user message names ≥2 entity-shaped tokens (proper
    //     nouns, file paths, identifiers) suggesting they're asking about
    //     something specific that memory might have history on
    // The env knob `BRAINROUTER_RECALL_MODE=always|gated|off` lets users
    // preserve pre-9b behaviour or kill recall entirely for benchmarking.
    const recallMode = resolveRecallModeFromEnv();
    if (recallMode === 'off') {
      resetBriefing({ decision: 'skip', reasons: ['recallMode=off'] });
      callbacks.onMemoryEvent?.({ kind: 'skipped', reason: 'recallMode=off' });
      return;
    }

    const activeGoal = readGoal(this.workspaceRoot, this.sessionKey);
    const hasActiveGoal = !!(activeGoal?.text && activeGoal.status === 'active');
    const personaPref = readPreferences(this.workspaceRoot).personaAnchorEnabled;
    const sourcePlan = buildDefaultSourcePlan(prompt, hasActiveGoal, {
      personaAnchorConfig: getCliKnobs().personaAnchor,
      personaAnchorPreference: personaPref,
    });
    const sourcesPlannedNames = describeSourcePlan(sourcePlan);
    const decision = decideMemoryBriefing({
      prompt,
      recallMode,
      recallHasFiredThisSession: this.recallHasFiredThisSession,
      postCompaction: this.recallNextTurnIsPostCompaction,
      hasActiveGoal,
      recentToolFailure: this.recentToolFailure,
      turnsSinceLastFullBriefing: this.turnsSinceLastFullBriefing,
    });

    if (recallMode === 'gated') {
      if (decision.action !== 'fire') {
        // Skip the full briefing — emit a lightweight system-reminder so
        // the model knows it can pull memory itself if it needs to. The
        // reminder is tagged so the next turn replaces it cleanly.
        this.replaceTaggedSystemMessage(
          'memory-hint',
          [
            '## Memory available (gated mode)',
            `Auto-briefing decision: ${decision.action}. Reasons: ${decision.reasons.join(', ')}.`,
            'Call `memory_recall` / `memory_search` / `memory_file_history` yourself if you need history on a specific entity, file, or decision.',
          ].join('\n'),
        );
        this.turnsSinceLastFullBriefing += 1;
        resetBriefing({
          decision: decision.action,
          reasons: decision.reasons,
          sourcesPlanned: sourcesPlannedNames,
        });
        callbacks.onMemoryEvent?.({ kind: 'skipped', reason: decision.reasons.join(', ') || 'gated (no trigger)' });
        return;
      }
      // Reset the post-compaction flag now that we're firing because of it.
      this.recallNextTurnIsPostCompaction = false;
    }

    // Either `recallMode === 'always'` (preserves pre-9b behaviour) or
    // we hit a gated trigger — fire the full briefing.
    callbacks.onStatusUpdate('Briefing from BrainRouter memory...');
    // 9d: skip `memory_task_state` in the briefing when a goal-anchor is
    // already carrying the current objective — avoids re-injecting the
    // "what we're doing now" context twice. The anchor is set immediately
    // before this call in `runTurn` (around line 680), so reading the goal
    // here resolves to the same record the anchor used.
    const briefing = await buildMemoryBriefing({
      mcpClient: this.mcpClient,
      mcpTools,
      sessionKey: this.sessionKey,
      workspaceRoot: this.workspaceRoot,
      query: prompt,
      activeSkill: this.activeSkill,
      hasActiveGoal,
      maxCharsPerSource: decision.budget.maxCharsPerSource,
      sourcePlan,
    });

    this.recalledRecords = briefing.recalledRecords;
    this.recalledRecordIds = briefing.recalledRecordIds;
    this.lastBriefingSources = briefing.sourcesQueried;
    this.recallHasFiredThisSession = true;
    this.turnsSinceLastFullBriefing = 0;
    this.recentToolFailure = undefined;
    // Drop any prior lightweight hint now that the full briefing is live.
    this.removeTaggedSystemMessage('memory-hint');

    const tokensInjected = briefing.block ? Agent.estimateTokens(briefing.block) : 0;
    this.lastBriefingDetails = {
      decision: 'fire',
      reasons: decision.reasons,
      sources: briefing.sourcesQueried,
      sourcesPlanned: briefing.sourcesPlanned,
      skippedSources: briefing.skippedSources,
      sourceStats: briefing.sourceStats,
      recordIds: briefing.recalledRecordIds,
      recordCount: briefing.recalledRecordIds.length,
      tokensInjected,
      charsSaved: this.memoryMetrics.compactedToolCharsAvoided,
      warnings: briefing.warnings,
      blockExcerpt: briefing.block ? briefing.block.slice(0, 500) : undefined,
    };

    if (briefing.block) {
      // 0.3.9 item 9 — route the briefing through the anchor-pin policy.
      // When pinning is enabled (default), the *first* briefing of the
      // session lands in the tagged system slot (cache-stable). Subsequent
      // turns that produce identical content are a no-op; turns with new
      // content append a "mid-session refresh" message instead of
      // rewriting the prefix, preserving the provider's prefix cache.
      const newHash = hashBriefingContent(briefing.block);
      const anchorDecision = decideAnchorAction({
        newContentHash: newHash,
        pinnedHash: this.pinnedAnchorHash,
        envSetting: getCliKnobs().prefixMemoryAnchors,
      });
      switch (anchorDecision.action) {
        case 'PIN':
          this.replaceTaggedSystemMessage('memory-briefing', briefing.block);
          this.pinnedAnchorHash = anchorDecision.nextPinnedHash;
          break;
        case 'STABLE':
          // Pinned content is still authoritative — do not touch the
          // chat history. This is the cache-hit-preserving branch.
          break;
        case 'APPEND':
          this.chatHistory.push({
            role: 'system',
            content: wrapMidSessionRefresh(briefing.block),
          });
          break;
        case 'LEGACY':
        default:
          this.replaceTaggedSystemMessage('memory-briefing', briefing.block);
          break;
      }
      callbacks.onStatusUpdate(
        `Memory briefing loaded: ${briefing.sourcesQueried.join(', ')} (${briefing.recalledRecordIds.length} records).`,
      );
      this.memoryMetrics.briefingTokensInjected += tokensInjected;
      this.memoryMetrics.recallRecordsConsulted += briefing.recalledRecordIds.length;
    }
    callbacks.onMemoryEvent?.({
      kind: 'briefing',
      sources: briefing.sourcesQueried,
      recordCount: briefing.recalledRecordIds.length,
      // Surface the actual records (id / type / priority / content preview) so the
      // UI can show the user exactly WHAT memory was injected this turn — bounded
      // so the event payload stays small even on a wide recall.
      records: this.recalledRecords.slice(0, 30).map((r) => ({
        id: r.recordId,
        type: r.type,
        priority: r.priority,
        source: r.source,
        score: r.score,
        content: typeof r.content === 'string'
          ? (r.content.length > 600 ? `${r.content.slice(0, 600)}…` : r.content)
          : undefined,
      })),
    });
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

  private async captureTurn(prompt: string, finalAnswer: string, callbacks?: RunTurnCallbacks): Promise<void> {
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

  private recordTranscript(message: any): void {
    try {
      appendTranscriptEntry(this.workspaceRoot, this.sessionKey, message);
    } catch {
      // Transcript persistence should not break the interactive turn.
    }
  }
}

/**
 * Run a web search via DuckDuckGo's Instant Answer API. No API key required.
 *
 * This is a thin, dependency-free default. For production-grade results, users
 * can configure an upstream search provider (Brave / Tavily / SerpAPI) and
 * point `BRAINROUTER_WEB_SEARCH_ENDPOINT` at it — when set, we POST the query
 * and expect `{ results: [{title, url, snippet}] }`.
 */
async function runWebSearch(query: string, maxResults: number): Promise<string> {
  const customEndpoint = getCliKnobs().webSearchEndpoint?.trim();
  if (customEndpoint) {
    try {
      const res = await fetch(customEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxResults }),
      });
      if (res.ok) {
        const body = await res.json() as any;
        if (Array.isArray(body?.results)) {
          return JSON.stringify(body.results.slice(0, maxResults), null, 2);
        }
      }
    } catch {
      // fall through to DuckDuckGo fallback
    }
  }

  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'BrainRouterCLI/0.3.8' } });
    if (!res.ok) {
      return `web_search failed: DuckDuckGo returned ${res.status} ${res.statusText}.`;
    }
    const data = await res.json() as any;
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    if (data?.AbstractURL && data?.AbstractText) {
      results.push({ title: data.Heading ?? query, url: data.AbstractURL, snippet: data.AbstractText });
    }
    const topics = Array.isArray(data?.RelatedTopics) ? data.RelatedTopics : [];
    for (const t of topics) {
      if (results.length >= maxResults) break;
      if (t.FirstURL && t.Text) {
        results.push({ title: t.Text.split(' - ')[0] ?? t.Text, url: t.FirstURL, snippet: t.Text });
      } else if (Array.isArray(t?.Topics)) {
        for (const inner of t.Topics) {
          if (results.length >= maxResults) break;
          if (inner.FirstURL && inner.Text) {
            results.push({ title: inner.Text.split(' - ')[0] ?? inner.Text, url: inner.FirstURL, snippet: inner.Text });
          }
        }
      }
    }
    if (results.length === 0) {
      return `web_search returned no results for "${query}". DuckDuckGo Instant Answer is best for factual queries; configure BRAINROUTER_WEB_SEARCH_ENDPOINT for a full search backend.`;
    }
    return JSON.stringify(results.slice(0, maxResults), null, 2);
  } catch (err: any) {
    return `web_search failed: ${err?.message ?? err}`;
  }
}

/**
 * Apply a Begin/End-envelope patch:
 *
 *   *** Begin Patch
 *   *** Update File: path/relative/to/workspace
 *   @@ optional context anchor
 *   -old line
 *   +new line
 *    unchanged line
 *   *** Add File: another/path
 *   +line 1
 *   +line 2
 *   *** Delete File: third/path
 *   *** End Patch
 *
 * Returns a JSON summary of operations performed; throws on a malformed envelope
 * or when an Update fails to match its context block uniquely.
 */
export function getToolSummary(name: string, args: Record<string, any>, result: string): string {
  switch (name) {
    case 'read_file': {
      const lines = result.split('\n').length;
      return `read ${lines} lines (${result.length} characters) from ${args.path}`;
    }
    case 'write_file':
      return `wrote to ${args.path}`;
    case 'edit_file':
      return `edited ${args.path}`;
    case 'list_dir':
      try {
        const items = JSON.parse(result);
        return `listed ${items.length} items in ${args.path || '.'}`;
      } catch {
        return `listed directory ${args.path || '.'}`;
      }
    case 'grep_search':
      try {
        const matches = JSON.parse(result);
        return `found ${matches.length} matches for "${args.query}"`;
      } catch {
        return `searched for "${args.query}"`;
      }
    case 'glob_files':
      try {
        const matched = JSON.parse(result);
        return `found ${matched.length} files matching "${args.pattern}"`;
      } catch {
        return `searched pattern "${args.pattern}"`;
      }
    case 'run_command': {
      // Surface the COMMAND itself — that's the meaningful, scannable part. The
      // ✓/✕ status indicator + the output preview already convey the outcome, so
      // we only append the exit code when it's non-zero (a failure worth seeing).
      const cmd = typeof args.command === 'string' ? args.command.trim().split('\n')[0].slice(0, 160) : '';
      if (result.includes('rejected by user')) return cmd ? `rejected: ${cmd}` : 'execution rejected by user';
      const code = result.match(/Exit Code: (\d+)/)?.[1] ?? '0';
      if (!cmd) return `exited with code ${code}`;
      return code === '0' ? cmd : `${cmd} — exit ${code}`;
    }
    case 'fetch_url':
      if (result.startsWith('Failed')) {
        return 'failed web fetch';
      }
      return `fetched content from ${args.url}`;
    case 'web_search':
      try { return `${JSON.parse(result).length} web results for "${args.query}"`; } catch { return `searched web for "${args.query}"`; }
    case 'apply_patch':
      try { return `applied ${JSON.parse(result).applied.length} file ops`; } catch { return 'applied patch'; }
    case 'update_plan':
      return 'updated durable plan';
    case 'spawn_agent':
      return `spawned ${args.role} agent`;
    case 'list_agents':
      try { return `${JSON.parse(result).length} child sessions`; } catch { return 'listed agents'; }
    case 'wait_agent':
      try { const p = JSON.parse(result); return `agent ${p.id} ${p.status}`; } catch { return 'waited'; }
    case 'read_agent_transcript':
      try { return `${JSON.parse(result).entries?.length || 0} transcript entries`; } catch { return 'read transcript'; }
    case 'close_agent':
      return `closed agent ${args.id}`;
    default:
      return `${name} executed`;
  }
}

/**
 * Optional inline preview for inspection-style tools. The REPL renders this
 * indented below the one-line summary so the user can SEE the result even if
 * the LLM forgets to echo it in its reply. Limited to a handful of tools where
 * the result is concise and the user's intent is almost always "show me this":
 * `list_dir`, `grep_search`, `glob_files`. Other tools (read_file, run_command)
 * fire too often as internal exploration steps — previewing them would flood
 * the terminal. Returns undefined when no useful preview is available.
 */
export function getToolPreview(name: string, args: Record<string, any>, result: string): string | undefined {
  switch (name) {
    case 'list_dir': {
      try {
        const items = JSON.parse(result) as Array<{ name: string; type: string; size?: number }>;
        if (!Array.isArray(items)) return undefined;
        if (items.length === 0) return '(empty directory)';
        const MAX = 30;
        const sliced = items.slice(0, MAX);
        const lines = sliced.map((it) => {
          const tag = it.type === 'directory' ? '📁' : '📄';
          const size = it.type === 'file' && typeof it.size === 'number' ? ` (${formatBytes(it.size)})` : '';
          return `${tag} ${it.name}${size}`;
        });
        if (items.length > MAX) lines.push(`…and ${items.length - MAX} more`);
        return lines.join('\n');
      } catch {
        return undefined;
      }
    }
    case 'grep_search': {
      try {
        const matches = JSON.parse(result) as Array<{ path: string; line: number; text: string }>;
        if (!Array.isArray(matches)) return undefined;
        if (matches.length === 0) return '(no matches)';
        const MAX = 10;
        const sliced = matches.slice(0, MAX);
        const lines = sliced.map((m) => `${m.path}:${m.line}  ${m.text.slice(0, 120)}`);
        if (matches.length > MAX) lines.push(`…and ${matches.length - MAX} more`);
        return lines.join('\n');
      } catch {
        return undefined;
      }
    }
    case 'glob_files': {
      try {
        const paths = JSON.parse(result) as string[];
        if (!Array.isArray(paths)) return undefined;
        if (paths.length === 0) return '(no matches)';
        const MAX = 20;
        const sliced = paths.slice(0, MAX);
        const lines = sliced.map((p) => p);
        if (paths.length > MAX) lines.push(`…and ${paths.length - MAX} more`);
        return lines.join('\n');
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Internal marker lines used by Agent.replaceTaggedSystemMessage to dedupe
// per-turn system messages (briefing, fan-out hint). Strip them before the
// payload reaches the LLM so the model doesn't see the bookkeeping.
const TAG_MARKER_RE = /^<!--brainrouter:[a-z0-9-]+-->\n/;

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

/** Whether the active model accepts the reasoning_effort field — a config-shaped
 *  wrapper over `isReasoningModel`. Non-reasoning chat variants like
 *  `gpt-5-chat-latest` are excluded: OpenAI ERRORS (not ignores) when they
 *  receive the field. */
export function supportsReasoningEffortField(config: LLMConfig): boolean {
  return isReasoningModel(config.model);
}

/**
 * The active provider's definition. Resolved ENDPOINT-FIRST, then by id:
 *
 *   1. If `config.endpoint` matches a built-in provider's endpoint, use THAT —
 *      this is the real backend, and it's authoritative for wire behaviour
 *      (effort map, tier ladder, locality). It's how DeepSeek (a hidden,
 *      `pickerVisible:false` provider reached as `provider:'openai'` +
 *      `endpoint:'https://api.deepseek.com/v1'`) gets its own effort map
 *      (`xhigh→max`) + ladder instead of silently inheriting OpenAI's.
 *   2. Otherwise fall back to the stored `config.provider` id.
 *
 * Returns undefined for an unknown id + unmatched endpoint (a genuinely custom
 * endpoint) — treated as the OpenAI-compatible default downstream.
 */
export function activeProviderDef(config: LLMConfig): ProviderDefinition | undefined {
  return findProviderByEndpoint(config.endpoint) ?? PROVIDER_REGISTRY.get((config.provider ?? '').toLowerCase());
}

/**
 * Decide the literal `reasoning_effort` wire value (or null to omit) for the
 * active provider + model. Mechanism + accepted values differ per provider AND
 * per model, so this layers the two axes (provider id → wire mechanism, model
 * name → capability) instead of one global transform:
 *   1. effort unset or the CLI default 'medium' → omit (the prompt overlay is
 *      also empty at medium, so wire + prompt agree).
 *   2. provider's reasoningEffort mode is not 'param' → omit (LM Studio's
 *      chat-completions ignores the field; others may reject it).
 *   3. always-on reasoners (DeepSeek `deepseek-reasoner`) and non-reasoning
 *      `*-chat` variants (OpenAI/gateways ERROR on those) → omit, on EVERY
 *      provider.
 *   4. MODEL gate: 'reasoning-only' providers (OpenAI, which errors on a
 *      non-reasoning model) only send for detected reasoning models; every other
 *      OpenAI-compatible provider defaults to 'any' (accept-and-ignore), so the
 *      field works for reasoning models we have no name pattern for.
 *   5. map the EffortLevel through the provider's effortValueMap (default OpenAI
 *      map: low→low, high→high, xhigh→high). `null` in the map = omit on purpose.
 *   6. model-aware `xhigh`: the default caps xhigh→high, but models that natively
 *      accept `xhigh` (gpt-5.1-codex-max, gpt-5.2+, gpt-5.4/5.5) keep it — don't
 *      silently degrade them. Providers that map xhigh to their own token
 *      (deepseek `max`, opencode `xhigh`) are untouched.
 */
export function resolveWireEffort(config: LLMConfig, effort: EffortLevel | undefined): string | null {
  if (!effort || effort === 'medium') return null;
  const def = activeProviderDef(config);
  if ((def?.reasoningEffort ?? 'param') !== 'param') return null;
  const model = normalizeModelName(config.model);
  if (isAlwaysOnReasoner(model)) return null;       // reasons by default, rejects the field
  if (isNonReasoningChatModel(model)) return null;  // *-chat — OpenAI/gateways error on it
  // OpenAI errors on a non-reasoning model, so it gates by the reasoning-model
  // allowlist; every other OpenAI-compatible provider sends for ANY model (the
  // server ignores it when N/A) so effort works for unlisted reasoning models.
  if ((def?.effortModelGate ?? 'any') === 'reasoning-only' && !isReasoningModel(model)) return null;
  // Binary on/off model (advertises only `on`/`off` via /models): collapse any
  // graded request to `on` — sending `low`/`high` would be rejected and the
  // endpoint would fall back to `on` anyway (and warn). `medium` already
  // returned null above, so it omits the field and the model uses its default.
  if (isBinaryReasoningModel(model)) return 'on';
  const map = def?.effortValueMap ?? DEFAULT_EFFORT_VALUE_MAP;
  const mapped = map[effort];
  if (mapped === null) return null;             // explicit omit for this level
  let wire = mapped ?? (effort === 'xhigh' ? 'high' : effort); // undefined → conservative default
  if (effort === 'xhigh' && wire === 'high' && modelSupportsXhighEffort(model)) {
    wire = 'xhigh';                             // capable model — pass xhigh through, don't degrade
  }
  return wire;
}

export interface BuildPayloadOptions {
  /** Reasoning-depth preference, when provider supports it. `medium` is a no-op. */
  effort?: EffortLevel;
  /** DESK-6 — abort the in-flight request the instant the user presses Stop. */
  signal?: AbortSignal;
}

export function buildChatCompletionPayload(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions = {},
): ChatCompletionPayload {
  const stripTag = (content: any) =>
    typeof content === 'string' && TAG_MARKER_RE.test(content)
      ? content.replace(TAG_MARKER_RE, '')
      : content;
  const mappedMessages = messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.tool_call_id,
        name: m.name,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      };
    }
    if (m.role === 'assistant') {
      const out: any = { role: 'assistant', content: m.content || null };
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      return out;
    }
    return {
      role: m.role,
      content: stripTag(m.content),
    };
  });

  const body: ChatCompletionPayload = {
    model: config.model,
    messages: mappedMessages,
  };

  if (tools.length > 0) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} }
      }
    }));
    body.tool_choice = 'auto';
  }

  // Forward reasoning_effort PROVIDER-AWARELY (see resolveWireEffort): only for
  // reasoning models on providers that accept the field, mapping the CLI level to
  // the provider's accepted wire value (e.g. opencode keeps `xhigh`, DeepSeek-v4
  // maps it to `max`, OpenAI/Ollama downgrade to `high`). `medium` is the CLI
  // default and is always omitted. The wire SHAPE is provider-specific too: most
  // take the flat `reasoning_effort`; LM Studio documents the nested
  // `reasoning: { effort }` form, so we honour `effortField` ('both' sends both).
  const wireEffort = resolveWireEffort(config, options.effort);
  if (wireEffort !== null) {
    const shape = activeProviderDef(config)?.effortField ?? 'flat';
    if (shape === 'flat' || shape === 'both') body.reasoning_effort = wireEffort;
    if (shape === 'nested' || shape === 'both') body.reasoning = { effort: wireEffort };
  }

  // Cut-off fix — BrainRouter normally sends NO max_tokens (the provider uses
  // its own default, which on some endpoints — e.g. certain fast/cheap models —
  // is a low completion cap that truncates long answers mid-sentence). When the
  // user sets `cli.maxOutputTokens`, forward it so they can lift that cap.
  const maxOutput = getCliKnobs().maxOutputTokens;
  if (typeof maxOutput === 'number' && maxOutput > 0) {
    (body as ChatCompletionPayload & { max_tokens?: number }).max_tokens = Math.floor(maxOutput);
  }

  return body;
}

/**
 * DESK-6 — sentinel thrown when an in-flight LLM call is aborted because the
 * USER pressed Stop (not a timeout / connectivity blip). The resilient loop
 * must NOT reconnect on this (a Stop is deliberate), and the turn unwinds with
 * the clean "interrupted" answer. Kept distinct from the timeout error, whose
 * message intentionally matches CONNECTIVITY_RE so genuine timeouts still retry.
 */
export class InterruptError extends Error {
  readonly isInterrupt = true;
  constructor(message = 'Interrupted by user') { super(message); this.name = 'InterruptError'; }
}
export function isInterrupt(err: any): boolean {
  return !!err && (err.name === 'InterruptError' || err.isInterrupt === true);
}
/** A delay that resolves early (no throw) the instant `signal` aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function callOpenAI(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions = {},
) {
  // Normalize the endpoint to a base URL (everything UP TO `/chat/completions`
  // exclusive). Earlier callers stored the full chat-completions URL in
  // `config.endpoint` (e.g. "https://api.openai.com/v1/chat/completions")
  // because the in-terminal wizard's provider catalog wrote the full path.
  // We then re-append `/chat/completions` below, producing a duplicate
  // `/chat/completions/chat/completions` and a 404. Strip the suffix
  // defensively so both shapes (full URL or base URL) work.
  const rawEndpoint = config.endpoint || 'https://api.openai.com/v1';
  const endpoint = rawEndpoint.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  // Key resolution is CONFIG-DRIVEN, not env-driven: BrainRouter reads the key
  // from config.apiKey (the config knob). Standard provider env vars are imported
  // into config ONCE at load time (config.ts → backfillApiKeyFromEnv), so we never
  // re-read process.env here — that also stops an OPENAI_API_KEY present in the
  // shell from being sent as a Bearer to a NON-OpenAI endpoint. A provider with a
  // public/anonymous tier (opencode "public") supplies a last-resort key; a local
  // server accepts a throwaway bearer. Locality comes from the provider's `local`
  // flag first, then a loopback-endpoint check (covers a custom local gateway).
  const def = activeProviderDef(config);
  let apiKey = config.apiKey || '';
  const isLocal = (def?.local ?? false) || isLoopbackEndpoint(endpoint);
  if (!apiKey && !isLocal && def?.defaultApiKey) apiKey = def.defaultApiKey;
  if (!apiKey && !isLocal) {
    throw new Error('LLM API key is required — set it in your BrainRouter config (the key is read from config, not the environment).');
  }
  if (!apiKey && isLocal) {
    apiKey = LOCAL_PLACEHOLDER_KEY;
  }

  const body = buildChatCompletionPayload(config, messages, tools, options);

  // 0.3.9 item 8 — emit the cache-stable prefix fingerprint for this
  // request. When tracing is disabled this resolves to a no-op
  // (traceEvent short-circuits on missing BRAINROUTER_TRACE_LOG). When
  // it's on, downstream items can correlate the fingerprint against
  // the provider's cache_hit telemetry (item 10) to confirm the prefix
  // is staying byte-stable across turns.
  const prefixFingerprint = computePrefixFingerprint(messages, tools);
  traceEvent('llm_call.prefix_fingerprint', {
    model: config.model,
    endpoint,
    prefixFingerprint,
    promptMessages: body.messages.length,
    toolCount: body.tools?.length ?? 0,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const timeoutMs = getCliKnobs().llmTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // DESK-6 — abort on EITHER the timeout OR the user's Stop signal; the catch
  // disambiguates so a Stop never masquerades as a (retryable) timeout.
  const fetchSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

  // Gate every chat LLM call through the process-wide semaphore. This
  // prevents a fan-out of N parallel children from firing N simultaneous
  // requests at the backend — the same condition that was unloading the
  // local LM Studio model. The MCP child has its own matching semaphore;
  // both consume the BRAINROUTER_LLM_MAX_CONCURRENT budget on the same
  // backend instance.
  const release = await acquireLLMSlot();
  let res: Response;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: fetchSignal,
    });
  } catch (err: any) {
    release();
    if (err?.name === 'AbortError') {
      if (options.signal?.aborted) throw new InterruptError();
      throw new Error(`LLM request timed out after ${timeoutMs}ms. Check that ${endpoint} is running and that model "${config.model}" can answer chat/completions requests with tools enabled.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  // Release once the headers are back; reading the body is local work that
  // doesn't need to block other LLM callers from starting.
  release();

  if (!res.ok) {
    const errText = await res.text();
    // RECONNECT — attach the structured status + any `Retry-After` so the resilient
    // loop classifies it (429/5xx → reconnect) and honors the server's backoff.
    const apiErr: any = new Error(`OpenAI API error: ${res.status} ${res.statusText} - ${errText}`);
    apiErr.status = res.status;
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    if (retryAfterMs !== undefined) apiErr.retryAfterMs = retryAfterMs;
    throw apiErr;
  }

  const data = await res.json() as any;

  // Defensive response-shape parsing. Some endpoints (LM Studio with certain
  // models, OpenRouter on specific upstream errors, local vLLM under load,
  // gpt-oss reasoning models with a non-standard envelope) return a 200 OK
  // with NO `choices` array — they smuggle the failure into the body as
  // `{error: ...}` or change the schema entirely. Unguarded `data.choices[0]`
  // then crashes with "Cannot read properties of undefined" and the user
  // has no idea what the upstream actually sent. Surface the body in the
  // error so they can spot the actual problem (wrong model name, OOM,
  // content-filter refusal, etc.).
  if (data && typeof data === 'object' && data.error) {
    const errMsg = typeof data.error === 'string'
      ? data.error
      : (data.error.message ?? JSON.stringify(data.error).slice(0, 400));
    throw new Error(`LLM endpoint returned an error envelope (HTTP 200): ${errMsg}`);
  }
  if (!Array.isArray(data?.choices) || data.choices.length === 0) {
    throw new Error(
      `LLM endpoint returned no choices. ` +
      `Model "${config.model}" at ${endpoint} may not support chat/completions, ` +
      `may need a different request shape (reasoning/harmony format?), or be misconfigured. ` +
      `Response body: ${JSON.stringify(data).slice(0, 600)}`,
    );
  }
  const choice = data.choices[0];
  if (!choice?.message) {
    // Streaming-style frames have `delta` instead of `message` — accept both
    // so a partially-misconfigured endpoint at least surfaces what it sent.
    const delta = choice?.delta;
    if (delta && typeof delta === 'object') {
      return {
        content: delta.content || '',
        toolCalls: delta.tool_calls,
        usage: data.usage,
        finishReason: choice?.finish_reason,
      };
    }
    throw new Error(`OpenAI-compatible endpoint returned an invalid chat completion response: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  return {
    // Some reasoning models put the visible answer in `message.content` and
    // chain-of-thought in `message.reasoning_content` / `reasoning`. We use
    // content (the canonical user-visible field) but tolerate it being null
    // when there are tool_calls but no prose.
    content: choice.message.content ?? '',
    toolCalls: choice.message.tool_calls,
    usage: data.usage,
    // `length` ⇒ the provider truncated the reply at its token cap (the cut-off
    // symptom). Surfaced as a notice → "raise cli.maxOutputTokens".
    finishReason: choice.finish_reason,
  };
}

/**
 * Streaming variant of `callOpenAI`. Returns the same shape after the
 * stream completes, but invokes `handlers.onTextDelta` / `onReasoningDelta`
 * as SSE frames arrive so the UI can paint live.
 *
 * Supports OpenAI-flavored SSE: lines starting with `data: ` followed by
 * either `[DONE]` or a JSON frame `{ choices: [{ delta: {...} }], ... }`.
 * Tool-call deltas accumulate by `index` (the standard OpenAI shape) so
 * we end with a fully-assembled `tool_calls` array compatible with the
 * existing non-streaming code path.
 *
 * Falls back to throwing on non-SSE bodies — callers must wrap in
 * try/catch and retry with the non-streaming `callOpenAI` if needed.
 */
export async function callOpenAIStream(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions = {},
  handlers: {
    onTextDelta?: (text: string) => void;
    onReasoningDelta?: (text: string) => void;
  } = {},
) {
  const rawEndpoint = config.endpoint || 'https://api.openai.com/v1';
  const endpoint = rawEndpoint.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  // Key resolution is CONFIG-DRIVEN, not env-driven: BrainRouter reads the key
  // from config.apiKey (the config knob). Standard provider env vars are imported
  // into config ONCE at load time (config.ts → backfillApiKeyFromEnv), so we never
  // re-read process.env here — that also stops an OPENAI_API_KEY present in the
  // shell from being sent as a Bearer to a NON-OpenAI endpoint. A provider with a
  // public/anonymous tier (opencode "public") supplies a last-resort key; a local
  // server accepts a throwaway bearer. Locality comes from the provider's `local`
  // flag first, then a loopback-endpoint check (covers a custom local gateway).
  const def = activeProviderDef(config);
  let apiKey = config.apiKey || '';
  const isLocal = (def?.local ?? false) || isLoopbackEndpoint(endpoint);
  if (!apiKey && !isLocal && def?.defaultApiKey) apiKey = def.defaultApiKey;
  if (!apiKey && !isLocal) {
    throw new Error('LLM API key is required — set it in your BrainRouter config (the key is read from config, not the environment).');
  }
  if (!apiKey && isLocal) {
    apiKey = LOCAL_PLACEHOLDER_KEY;
  }

  const body: any = buildChatCompletionPayload(config, messages, tools, options);
  body.stream = true;
  body.stream_options = { include_usage: true };

  // 0.3.9 item 8 — fingerprint the cache-stable prefix for this stream
  // call too. Item 10 will correlate this with the SSE-final usage row
  // when the provider exposes a `cached_tokens` field.
  const streamPrefixFingerprint = computePrefixFingerprint(messages, tools);
  traceEvent('llm_call.prefix_fingerprint', {
    model: config.model,
    endpoint,
    prefixFingerprint: streamPrefixFingerprint,
    promptMessages: body.messages.length,
    toolCount: body.tools?.length ?? 0,
    stream: true,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const timeoutMs = getCliKnobs().llmTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // DESK-6 — abort on timeout OR the user's Stop; disambiguate in the catch.
  const fetchSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

  const release = await acquireLLMSlot();
  let res: Response;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: fetchSignal,
    });
  } catch (err: any) {
    release();
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      if (options.signal?.aborted) throw new InterruptError();
      throw new Error(`LLM stream request timed out after ${timeoutMs}ms.`);
    }
    throw err;
  }

  if (!res.ok || !res.body) {
    release();
    clearTimeout(timeout);
    const errText = res.body ? await res.text() : '';
    throw new Error(`OpenAI API error (stream): ${res.status} ${res.statusText} - ${errText}`);
  }

  // Accumulators that match the non-streaming response shape.
  let content = '';
  let reasoning = '';
  const toolCallsByIndex = new Map<number, { id?: string; type?: string; function: { name: string; arguments: string } }>();
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  // `length` ⇒ the provider truncated the stream at its token cap. The last
  // non-empty finish_reason in the stream wins.
  let finishReason: string | undefined;

  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      // DESK-6 — bail the instant the user presses Stop, even mid-stream: stop
      // reading the SSE and stop firing deltas. (The fetch abort also rejects
      // reader.read(), but this is the prompt, deterministic exit.)
      if (options.signal?.aborted) { try { await reader.cancel(); } catch { /* already closed */ } throw new InterruptError(); }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines (`\n\n`). Some servers
      // (LM Studio in particular) emit `\r\n\r\n` — normalize.
      let sepIdx: number;
      while ((sepIdx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx).replace(/^\r?\n\r?\n/, '');
        for (const rawLine of frame.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let frameJson: any;
          try { frameJson = JSON.parse(payload); } catch { continue; }
          if (frameJson?.usage) {
            usage = {
              prompt_tokens: frameJson.usage.prompt_tokens,
              completion_tokens: frameJson.usage.completion_tokens,
            };
          }
          const choice = frameJson?.choices?.[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            content += delta.content;
            handlers.onTextDelta?.(delta.content);
          }
          // Reasoning frames (xAI/OpenRouter use `reasoning`, others use `reasoning_content`)
          const r = (typeof delta.reasoning === 'string' ? delta.reasoning : undefined)
            ?? (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined);
          if (r && r.length > 0) {
            reasoning += r;
            handlers.onReasoningDelta?.(r);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              const acc = toolCallsByIndex.get(idx) ?? { function: { name: '', arguments: '' } };
              if (tc.id) acc.id = tc.id;
              if (tc.type) acc.type = tc.type;
              // Concatenate (some providers fragment the name across frames;
              // the OpenAI-standard "name only in first frame" still works
              // because subsequent frames omit the field).
              if (tc.function?.name) acc.function.name += tc.function.name;
              if (typeof tc.function?.arguments === 'string') acc.function.arguments += tc.function.arguments;
              toolCallsByIndex.set(idx, acc);
            }
          }
        }
      }
    }
  } finally {
    release();
    clearTimeout(timeout);
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id, type: v.type ?? 'function', function: v.function }))
    .filter((tc) => tc.function.name); // drop incomplete entries

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    finishReason,
    reasoning: reasoning || undefined,
  };
}
