// Session / config / context-accounting / history methods, split out of agent.ts
// (god-file breakdown). Byte-identical bodies; each is a free function bound to
// `this: Agent`, and the class keeps thin delegators. `.impl` module (internal
// wiring, not public surface).
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from './agent.js';
import type { LLMConfig } from '../config/config.js';
import { getCliKnobs } from '../config/config.js';
import type { AccessMode } from '../orchestration/registry/roles.js';
import { childAgentsFor } from '../orchestration/tools.js';
import { spawnWorkerThread } from '../orchestration/workers/workerTools.js';
import type { ActionKind, PolicyDecision } from '../exec/execPolicy.js';
import type { PlanState } from '../task/taskStore.js';
import { readPlan } from '../task/taskStore.js';
import { recordPlanDecision, readPlanHistory, linkPlanDecision, planStepSignature } from '../task/planHistoryStore.js';
import { type PrefixComponents, computePrefixComponents, computePrefixFingerprint, accumulatePrefixStability, prefixStabilityRatio } from '../context/contextRegions.js';
import { contextWindowForBudget } from '../context/contextWindow.js';
import { recordFileMutation } from '../storage/fileSnapshotStore.js';
import { shouldReindex, reindexSignature, languageHint, type ReindexGate } from '../util/autoReindex.js';
import { gitChurnSignal } from '../git/gitChurn.js';
import { renderCompactSystemMessage, runCompaction } from '../prompt/compactor.js';
import { runHooks } from '../hooks/hooksStore.js';
import { callMcpTool } from '../mcp/mcpUtils.js';
import { emitAgentEvent } from '../memory/memoryEvents.js';
import { resolveActiveMode } from '../session/sessionModeStore.js';
import { readTranscriptEntries } from '../session/sessionStore.js';
import { estimateChatHistoryTokens } from '../util/tokenEstimate.js';
import { traceEvent } from '../telemetry/tracing.js';
import { sanitizeToolCallPairing } from './toolCallRecovery.js';
import { appendDeveloperPromptLayer } from './llmTransport.js';

export async function compactHistory(this: Agent): Promise<{ summary: string; estimatedTokens: number; durationMs: number; replacedMessages: number } | null> {
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
    const compactSystemMessage = renderCompactSystemMessage(result.summary);
    const systemMessage = this.createSystemMessage();
    const next: any[] = [systemMessage];
    if (!appendDeveloperPromptLayer(systemMessage, compactSystemMessage)) {
      next.push({ role: 'system', content: compactSystemMessage });
    }
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
export function requestInterrupt(this: Agent): void {
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
export function setModel(this: Agent, model: string): void {
    this.llmConfig = { ...this.llmConfig, model };
  }
export function getModel(this: Agent): string {
    return this.llmConfig.model;
  }

  /**
   * 0.4.x-4b (`/context`) — best estimate of the CURRENT context-window fill
   * in tokens. Prefers the provider's last `usage.prompt_tokens` (the truest
   * count); falls back to the content-aware estimate of `chatHistory` for
   * turn 1 / silent runs. This is the exact signal auto-compact triggers on,
   * so `/context` and the auto-compact threshold agree.
   */
export function getCurrentContextTokens(this: Agent): number {
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
export function getPrefixComponents(this: Agent): PrefixComponents {
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
export function recordPrefixStability(this: Agent, messages: readonly unknown[], tools: readonly unknown[]): void {
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
export function getPrefixStability(this: Agent): { stableCalls: number; bustCalls: number; ratio: number; lastLabels: string[] } {
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
export function spawnBackgroundWorker(this: Agent, goal: string): { id: string; status: string; goal: string } {
    const worker = spawnWorkerThread(this.mcpClient, this.llmConfig, {
      workspaceRoot: this.workspaceRoot,
      launchCwd: this.launchCwd,
      role: 'worker',
      goal,
      parentSessionKey: this.sessionKey,
      parentAccessMode: this.accessMode,
      spawnerDepth: this.agentDepth,
      effortOverride: this.effortOverride,
      ancestorFleet: this.forceFleetSandbox, // HONK-H0 — cascade fleet lockdown
    });
    return { id: worker.id, status: worker.status, goal: worker.goal };
  }

  /**
   * 0.4.3 (CLI-8) — session-cumulative tool-call repair telemetry, surfaced by
   * `/context`. Returns a copy so callers can't mutate the running totals.
   */
export function getRepairTotals(this: Agent): { scavenged: number; truncationsFixed: number; truncationsUnrecoverable: number; stormsBroken: number; turnsWithRepair: number } {
    return { ...this.repairTotals };
  }

  /**
   * FOOTER-TELEMETRY-2 — the counters behind the `offload` statusline segment:
   * cumulative child-agent token spend + child-output chars kept out of the
   * parent's context window this session. Both are in-memory, so the footer can
   * read them every render without a disk scan. (See `/tokens` / `/context` for
   * the full per-child breakdown sourced from session usage on disk.)
   */
export function getOffloadTotals(this: Agent): { childTokensSpent: number; offloadCharsAvoided: number; compactedToolCharsAvoided: number } {
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
export function maybeAutoApprovePlan(this: Agent, state: PlanState): void {
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

export function captureFileSnapshot(this: Agent, absPath: string): void {
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
export async function maybeReindexSource(this: Agent, resolved: string, content: string): Promise<string> {
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
export function getLlmConfig(this: Agent): LLMConfig {
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
export function setLLMConfig(this: Agent, next: Partial<LLMConfig>): void {
    this.llmConfig = { ...this.llmConfig, ...next };
  }
export function getLLMConfig(this: Agent): LLMConfig {
    return this.llmConfig;
  }

  /** Runtime access-mode cycle for `/permissions` and Shift+Tab plan-mode toggle. */
export function getAccessMode(this: Agent): AccessMode {
    return this.accessMode;
  }
export function setAccessMode(this: Agent, mode: AccessMode): void {
    this.accessMode = mode;
  }

  /** POLICY-1 — the session's execution-policy audit trail (mutating-tool
   * decisions). Read-only snapshot for observability / tests. */
export function getPolicyAudit(this: Agent): ReadonlyArray<{ tool: string; action: ActionKind; decision: PolicyDecision; reason: string }> {
    return this.policyAudit;
  }

  /**
   * Seed the chat history from a persisted transcript so the user can resume
   * a previous session. The system message is regenerated for the current
   * runtime so workspace/session context is fresh, but the user/assistant/tool
   * messages are kept verbatim.
   */
export function loadHistory(this: Agent, entries: Array<{ role: string; content?: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>): number {
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
