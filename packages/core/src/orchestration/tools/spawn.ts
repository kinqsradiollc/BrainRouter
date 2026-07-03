import { Agent } from '../../agent/agent.js';
import fs from 'node:fs';
import { getCliKnobs, loadOrInitConfig } from '../../config/config.js';
import { resolveAgentLlm } from '../../provider/agentModels.js';
import {
  createSession,
  listSessions,
  updateSession,
  type ChildSessionRecord,
} from '../orchestrator.js';
import { buildRolePrompt, resolveRole, type AccessMode } from '../roles.js';
import { countRunningChildren, spawnSlotDecision } from '../spawnSlots.js';
import { findById, listAll, type Tier } from '../agentRegistry.js';
import { buildSystemPrompt, loadWorkspaceInstructionSummary } from '../../prompt/systemPrompt.js';
import { appendTranscriptEntry } from '../../session/transcript/sessionStore.js';
import { callMcpTool, childSessionKey } from '../../mcp/mcpUtils.js';
import { readPreferences } from '../../session/preferences/preferencesStore.js';
import { resolveAutoChainMode, autoChainRoles } from '../autoChain.js';
import { resolveDelegationPolicy, evaluateDelegationGate } from '../delegationPolicy.js';
import { buildParentExecutionContextSnapshot } from '../parentContext.js';
import { enqueueCompletion } from '../../session/completion/completionInbox.js';
import { getOutputContract } from '../outputContracts.js';
import { emitAgentRouteFeedback, emitAgentEvent, agentOutputEvent, type RouteOutcome } from '../../memory/memoryEvents.js';
import { prepareChildWorkspace, removeChildWorktree, isSharedWorktreeOf, sharedWorktreeLaunchCwd, mergeBackLine, worktreePatchFile, type WorktreeHoldReason, type ChildWorkspaceResolution } from '../../worktree/worktreeIsolation.js';
import type { OrchestrationContext } from './context.js';
import { runningChildAgents, runningPromises } from './registry.js';
import {
  clampAccess,
  extractChildPreview,
  parentWaitTimeoutMsFromArgs,
  resolveChildLaunchCwd,
  OFFLOAD_PREVIEW_CHARS,
  OFFLOAD_THRESHOLD_CHARS,
} from './helpers.js';
import { handleWait } from './wait.js';

/**
 * MAS-P2-M6 — best-effort route-feedback emit on child completion.
 * Computes durationMs from the persisted record's startedAt timestamp
 * so the brain can join on real wall-clock spans.
 */
async function emitRouteFeedback(
  ctx: OrchestrationContext,
  args: {
    task: string;
    chosenAgentId: string;
    parentAgentId?: string;
    ownership: string | null;
    outcome: RouteOutcome;
    record: ChildSessionRecord;
    completedAt: string;
    tokenCost?: number;
  },
): Promise<void> {
  const startedMs = Date.parse(args.record.startedAt);
  const completedMs = Date.parse(args.completedAt);
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(completedMs)
      ? Math.max(0, completedMs - startedMs)
      : undefined;
  const emitCtx = { mcpClient: ctx.mcpClient, sessionKey: ctx.parentSessionKey };
  await emitAgentRouteFeedback(emitCtx, {
    task: args.task,
    chosenAgentId: args.chosenAgentId,
    parentAgentId: args.parentAgentId,
    ownership: args.ownership,
    outcome: args.outcome,
    durationMs,
    tokenCost: args.tokenCost,
  });
  // MAS-P6-T1: also capture the delegation-aware `agent_output` event
  // (best-effort; piggybacks the same MCP capture path).
  await emitAgentEvent(
    emitCtx,
    agentOutputEvent({
      agentId: args.chosenAgentId,
      task: args.task,
      outcome: args.outcome,
      durationMs,
      tokenCost: args.tokenCost,
      preview: typeof args.record.finalOutput === 'string' ? args.record.finalOutput : undefined,
    }),
  );
}

export async function handleSpawn(args: any, ctx: OrchestrationContext): Promise<string> {
  // Resolve agent definition via agentId (registry) or role (legacy).
  let role: ReturnType<typeof resolveRole>;
  let childTier: Tier | undefined;
  // MAS-P4-T1: an agent def may scope which MCP tools its children see.
  let childToolScope: { local: string[]; mcp: string[] } | undefined;
  let childDisallowedTools: string[] | undefined;
  // AGENTS-WIZARD: a def may carry a default ownership glob, used when the
  // spawner doesn't pass an explicit one.
  let childDefOwnership: string | null | undefined;

  if (typeof args.agentId === 'string' && args.agentId.trim()) {
    const loaded = findById(args.agentId.trim(), ctx.workspaceRoot);
    if (!loaded) {
      const known = listAll(ctx.workspaceRoot).map((l) => l.def.id).join(', ');
      throw new Error(`Unknown agentId "${args.agentId}". Known agents: ${known}.`);
    }
    role = {
      name: loaded.def.id,
      description: loaded.def.whenToUse,
      defaultAccess: loaded.def.defaultAccess,
      promptOverlay: loaded.def.prompt,
    };
    childTier = loaded.def.tier;
    childToolScope = loaded.def.toolScope;
    childDisallowedTools = loaded.def.disallowedTools;
    childDefOwnership = loaded.def.ownership ?? undefined;
  } else {
    const roleName = String(args.role ?? '');
    if (!roleName.trim()) throw new Error('spawn_agent requires either "agentId" or "role".');
    role = resolveRole(roleName);
    childTier = findById(role.name, ctx.workspaceRoot)?.def.tier;
  }

  const prompt = String(args.prompt ?? '');
  if (!prompt.trim()) throw new Error('spawn_agent requires a non-empty prompt.');

  // P1.2 — spawn hierarchy checks.
  const rawMaxDepth = getCliKnobs().maxSpawnDepth;
  const maxDepth = Number.isFinite(rawMaxDepth) && rawMaxDepth > 0 ? rawMaxDepth : 3;
  const currentDepth = ctx.depth ?? 0;
  const parentTier = ctx.parentTier;

  if (parentTier === 'worker') {
    throw new Error('Tier "worker" cannot delegate — ask the parent agent to spawn instead.');
  }
  if (parentTier === 'reasoning' && childTier && (childTier === 'chat' || childTier === 'reasoning')) {
    throw new Error(`Tier "reasoning" cannot spawn a "${childTier}" agent — only "worker" children are allowed.`);
  }
  if (currentDepth >= maxDepth) {
    throw new Error(`Spawn depth cap reached (${currentDepth}/${maxDepth}). Reduce agent nesting or raise cli.maxSpawnDepth in ~/.config/brainrouter/config.json.`);
  }
  // CODEX-AGENT-LIFECYCLE — spawn slots: cap the number of children THIS parent
  // has running concurrently (breadth) so it can't fan out unbounded agents that
  // exhaust the LLM semaphore and leave orphans drifting. Scoped to the parent's
  // session key (Codex's per-controller slots) and counts `running` only, so an
  // orphan `pending` from a crashed spawn never wedges the cap.
  {
    const mine = listSessions(ctx.workspaceRoot).filter((s) => s.parentSessionKey === ctx.parentSessionKey);
    const running = countRunningChildren(mine);
    const slot = spawnSlotDecision(running, getCliKnobs().maxConcurrentChildren);
    if (!slot.allow) throw new Error(slot.reason);
  }

  const requested = (args.access as AccessMode | undefined) ?? role.defaultAccess;
  const access = clampAccess(ctx.parentAccessMode ?? 'shell', requested);

  // PARITY-Q — soft delegation-prompt nudge. A terse child prompt with no
  // return-format cue tends to come back vague; rather than reject it (the
  // parent already committed to spawning), append ONE role-appropriate line
  // steering the child to a self-contained, evidence-quoting answer. Read-only
  // children are told to report findings only; write/shell children to report
  // what they changed and how they verified. Untouched when the parent already
  // briefed well (long prompt) or stated a return/format cue.
  const hasReturnCue = /\b(return|report back|format|output|provide|summar|list|table|pseudocode|cite|quote|file:line)\b/i.test(prompt);
  const effectivePrompt = (prompt.length < 220 && !hasReturnCue)
    ? `${prompt}\n\n${access === 'read'
        ? 'Return a self-contained answer: lead with the conclusion, then the evidence — quote key `file:line` references. Report findings only; do not modify files.'
        : 'Return a self-contained answer: lead with what you changed and why, then quote the key `file:line` edits and how you verified them (tests/output).'}`
    : prompt;

  // MAS-P4-T2 — supervisor gate. Consult the delegation policy before
  // creating the session. `no-children` denies outright; `ask-*` policies
  // prompt the interactive parent (and fail closed in headless runs).
  const delegationPolicy = resolveDelegationPolicy(readPreferences(ctx.workspaceRoot));
  const rawGate = evaluateDelegationGate({ policy: delegationPolicy, childAccess: access, depth: ctx.depth ?? 0 });
  // Auto-chain follow-ups (the reviewer/verifier the user opted into via
  // `/auto-chain review|verify|both`) are PRE-AUTHORIZED — they must not re-prompt
  // "approve this delegation?" on every worker completion. A hard `deny` policy
  // ("no-children") still blocks them.
  const gate = args.autoChainFollowup === true && rawGate === 'ask' ? 'auto' : rawGate;
  if (gate === 'deny') {
    throw new Error(
      `Delegation is disabled (policy "no-children"). The agent may not spawn child agents. ` +
        `Change it with /delegation-policy auto.`,
    );
  }
  if (gate === 'ask') {
    if (!ctx.confirmDelegation) {
      throw new Error(
        `Delegation policy "${delegationPolicy}" requires approval, but no interactive terminal is attached. ` +
          `Run interactively, or set /delegation-policy auto to spawn non-interactively.`,
      );
    }
    const approved = await ctx.confirmDelegation({ role: role.name, access, prompt: String(args.prompt ?? '') });
    if (!approved) {
      throw new Error(`Spawn of "${role.name}" (${access}) declined under delegation policy "${delegationPolicy}".`);
    }
  }

  const requestedChildLaunchCwd = resolveChildLaunchCwd(ctx, args.workdir);
  const parentWaitTimeoutMs = parentWaitTimeoutMsFromArgs(args);
  const record = createSession(ctx.workspaceRoot, {
    role: role.name,
    prompt,
    parentSessionKey: ctx.parentSessionKey,
    access,
    label: typeof args.label === 'string' ? args.label : undefined,
    tier: childTier,
    depth: currentDepth + 1,
  });
  // BUILD-LOOP P2 (0.4.12) — when the build orchestrator passes an explicit
  // `workspaceRootOverride` (the ONE worktree shared by a build run's
  // implement/verify/review children), the child runs IN that worktree with NO
  // per-child isolation handle — so it never merges back on its own; the build
  // loop owns the shared worktree's lifecycle + the gated merge at the end.
  // The override is honored ONLY when it's a git worktree of the SAME repo as the
  // parent workspace — never an arbitrary path — so a child's writes can't be
  // redirected outside the workspace (ownership + write-validation key off
  // `workspaceRoot`). Anything else falls through to normal per-child isolation.
  const sharedRootOverride = typeof args.workspaceRootOverride === 'string' && args.workspaceRootOverride.trim()
    ? args.workspaceRootOverride.trim()
    : undefined;
  const sharedRootValid = sharedRootOverride ? isSharedWorktreeOf(ctx.workspaceRoot, sharedRootOverride) : false;
  const childWorkspace: ChildWorkspaceResolution = (sharedRootOverride && sharedRootValid)
    ? (() => {
        const root = fs.realpathSync(sharedRootOverride);
        // Map the requested cwd into the shared worktree (fall back to its root).
        return { workspaceRoot: root, launchCwd: sharedWorktreeLaunchCwd(ctx.workspaceRoot, requestedChildLaunchCwd, root), isolated: true };
      })()
    : prepareChildWorkspace({
        parentWorkspaceRoot: ctx.workspaceRoot,
        parentLaunchCwd: requestedChildLaunchCwd,
        childId: record.id,
        access,
        mode: getCliKnobs().childWorkspaceIsolation,
      });
  const childWorkspaceRoot = childWorkspace.workspaceRoot;
  const childLaunchCwd = childWorkspace.launchCwd;
  if (childWorkspace.isolated || childWorkspace.notice) {
    updateSession(ctx.workspaceRoot, record.id, {
      childWorkspaceRoot: childWorkspace.isolated ? childWorkspaceRoot : undefined,
      childLaunchCwd,
      childWorkspaceIsolation: childWorkspace.isolation,
      childWorkspaceNotice: childWorkspace.notice,
    });
  }

  const childKey = childSessionKey(ctx.parentSessionKey, record.id);
  const seededIds: string[] = Array.isArray(args.seedRecordIds)
    ? args.seedRecordIds.filter((id: unknown): id is string => typeof id === 'string').slice(0, 20)
    : [];

  // MAS-P2-M3: build the typed parent-context snapshot from the
  // accessor methods the agent exposes. Skip silently when a piece
  // of state isn't available — partial snapshots are explicitly OK.
  const parentBriefing = ctx.parentBriefingBlock?.();
  const parentRecalledIds = ctx.parentRecalledRecordIds?.() ?? seededIds;
  const parentGoal = ctx.parentGoal?.();
  const parentPlan = ctx.parentPlanText?.();
  const parentExecutionMode = ctx.parentExecutionMode;
  const parentReviewPolicy = ctx.parentReviewPolicy;
  // AGENTS-WIZARD: explicit spawn arg wins; else fall back to the def's
  // declared ownership glob (so a custom write/shell agent stays bounded
  // without the spawner repeating its ownership each time).
  const ownership = typeof args.ownership === 'string' ? args.ownership
    : (typeof childDefOwnership === 'string' && childDefOwnership.trim() !== '' ? childDefOwnership : null);
  const snapshot = buildParentExecutionContextSnapshot({
    parentSessionKey: ctx.parentSessionKey,
    childSessionKey: childKey,
    parentAgentId: role.name,
    accessMode: access,
    trace: ctx.parentTraceId && ctx.parentSpanId
      ? { traceId: ctx.parentTraceId, spanId: ctx.parentSpanId }
      : undefined,
    goal: parentGoal ?? undefined,
    planText: parentPlan ?? undefined,
    recalledRecordIds: parentRecalledIds,
    briefingBlock: parentBriefing ?? undefined,
    visibleTools: ctx.parentVisibleTools?.(),
    reviewPolicy: parentReviewPolicy,
    executionMode: parentExecutionMode,
    workspaceInstructions: loadWorkspaceInstructionSummary(ctx.workspaceRoot),
    ownership,
    outputContract: getOutputContract(role.name)?.id ?? null,
  });
  updateSession(ctx.workspaceRoot, record.id, { parentContext: snapshot });
  appendTranscriptEntry(childWorkspaceRoot, childKey, {
    role: 'system',
    name: 'parent_context',
    content: JSON.stringify(snapshot),
  });

  const basePrompt = buildSystemPrompt({
    workspaceRoot: childWorkspaceRoot,
    launchCwd: childLaunchCwd,
    sessionKey: childKey,
    instructionSummary: loadWorkspaceInstructionSummary(childWorkspaceRoot),
  });
  let systemPromptOverride = buildRolePrompt(role, basePrompt, '');
  if (seededIds.length > 0) {
    systemPromptOverride +=
      `\n\n## Parent-recalled BrainRouter records\n` +
      `The parent agent already recalled these memory record IDs: ${seededIds.join(', ')}. ` +
      `Call memory_recall (or memory_search) with the same intent before doing duplicate exploration, and prefer building on these records over re-deriving them.`;
  }
  // 0.4.x-1: operator overlay — a one-off instruction block (≤4000 chars,
  // same cap as /goal) appended to the role prompt. The escape hatch for a
  // bespoke contractor the five preset roles don't cover. A child with an
  // overlay is marked `synthetic` so /agents and recall can tell it apart
  // from a vanilla role spawn.
  const overlay = typeof args.overlay === 'string' ? args.overlay.trim().slice(0, 4000) : '';
  if (overlay) {
    systemPromptOverride += `\n\n## Operator overlay (one-off instructions for this run)\n${overlay}`;
    updateSession(ctx.workspaceRoot, record.id, { synthetic: true });
  }
  // 0.4.x-5: per-child reasoning-effort override (otherwise inherits /effort).
  const effortOverride =
    args.effort === 'low' || args.effort === 'medium' || args.effort === 'high' ? args.effort : undefined;

  // 0.4.15 — route this child to its ROLE's configured provider/model
  // (config.providers + config.agentModels). Falls back to the parent's LLM
  // (ctx.llmConfig — which already honors any per-session override) when the
  // role has no assignment, so default behavior is unchanged.
  const childLlm = resolveAgentLlm(loadOrInitConfig(), ctx.llmConfig, role.name);
  const childAgent = new Agent(ctx.mcpClient, childLlm, {
    workspaceRoot: childWorkspaceRoot,
    launchCwd: childLaunchCwd,
    sessionKey: childKey,
    // The role overlay is already embedded inside `systemPromptOverride` via
    // buildRolePrompt() above — passing it again as a separate field would
    // append a second copy and waste 1.5–3k tokens per child turn.
    roleOverlay: undefined,
    accessMode: access,
    silent: true,
    forceFleetSandbox: role.forceSandbox || ctx.ancestorFleet, // HONK-H0 — fleet role OR fleet ancestor → locked-down posture

    // Children NEED memory: skipping the briefing makes them amnesiac and the
    // parent LLM eventually learns inline work outperforms fan-out. With recall
    // enabled, children join the same cognitive context as the parent.
    enableRecall: true,
    systemPromptOverride,
    // Inherit the parent's OTEL trace context so spans nest under the
    // dispatching spawn_agent tool span instead of starting a fresh tree.
    parentTraceId: ctx.parentTraceId,
    parentSpanId: ctx.parentSpanId,
    // Propagate tier and depth so grandchildren can enforce hierarchy caps.
    tier: childTier,
    agentDepth: currentDepth + 1,
    // MAS-P3: the ownership glob gates this child's file writes.
    ownership,
    // MAS-P4-T1: the agent def's tool scope limits the child's MCP surface.
    toolScope: childToolScope,
    disallowedTools: childDisallowedTools,
    // 0.4.x-5: per-child reasoning-effort override.
    effortOverride,
    confirmToolApproval: ctx.confirmToolApproval
      ? (info) => ctx.confirmToolApproval!({ childId: record.id, role: role.name, ...info })
      : undefined,
    // DESK-5n — thread the parent's review stance so the child's write/edit/
    // patch gate can honor the user's "Auto mode" (proceed) without asking.
    // ctx types these as plain string; the Agent narrows them.
    parentReviewPolicy: ctx.parentReviewPolicy as 'request' | 'proceed' | undefined,
    parentExecutionMode: ctx.parentExecutionMode as 'planning' | 'fast' | undefined,
  });
  if (ctx.parentAgentId) childAgent.setParentAgentId(ctx.parentAgentId);
  // DESK-6 — register the live handle so a parent Stop can cascade into it.
  runningChildAgents.set(record.id, { agent: childAgent, parentSessionKey: ctx.parentSessionKey });

  updateSession(ctx.workspaceRoot, record.id, { status: 'running' });

  // COMPLETION-FEEDBACK — a DETACHED child (delegate_agent / spawn_agent with
  // wait:false) returns only its id now; its result is reported back to the
  // parent's next turn via the completion inbox. A waited child (task_agent)
  // returns in-turn, so it's acknowledged at wait time instead (no duplicate).
  const reportCompletionToParent = !args.wait;

  const promise = (async () => {
    // CODEX-WORKTREE-MERGEBACK — guards against double cleanup: the success path
    // merges the worktree back BEFORE the completion notice + auto-chain; the
    // `finally` then only runs for the failure/throw path (capture + preserve).
    let worktreeSettled = false;
    try {
      // Track per-tool start times so the paired onChildToolEnd carries a
      // real duration — the REPL renders this on the child's end row.
      const childToolStarts = new Map<string, number>();
      // Synthetic dangling-tool-call recovery: every child must resolve to
      // an explicit result instead of leaving
      // the session running forever when an LLM/MCP call hangs.
      const output = await childAgent.runTurn(effectivePrompt, {
        onStatusUpdate: () => {},
        onToolStart: (tool, args) => {
          childToolStarts.set(tool, Date.now());
          ctx.onChildToolStart?.({
            childId: record.id,
            role: role.name,
            tool,
            args: args ?? {},
          });
        },
        onToolEnd: (tool, result) => {
          const startedAt = childToolStarts.get(tool);
          childToolStarts.delete(tool);
          const durationMs = startedAt ? Date.now() - startedAt : 0;
          ctx.onChildToolEnd?.({
            childId: record.id,
            role: role.name,
            tool,
            ok: result.success,
            summary: result.summary,
            preview: result.preview,
            durationMs,
          });
        },
      });

      // Working-memory offload: when a child returns a sizeable payload, push
      // the full body into the BrainRouter working canvas and keep only a
      // pointer in the session record. This is the main context-saving win
      // for parents synthesizing multiple child outputs.
      //
      // The preview the parent sees was previously `output.slice(0, 800)`,
      // which often hid the actual conclusion — e.g. a 15k-char review
      // report with the headline finding at the BOTTOM. Now we prefer an
      // explicit `## Headline` / `## Summary` / `## TL;DR` section when
      // the child wrote one (the role overlays nudge for this), and fall
      // back to the head-and-tail slice so we capture both the framing
      // and the conclusion.
      let storedOutput = output;
      let workingRef: string | undefined;
      if (output && output.length >= OFFLOAD_THRESHOLD_CHARS) {
        workingRef = await offloadChildOutput(ctx, record.id, role.name, prompt, output);
        if (workingRef) {
          const preview = extractChildPreview(output, OFFLOAD_PREVIEW_CHARS);
          storedOutput =
            `[offloaded to working memory ref=${workingRef}]\n` +
            `Preview (${preview.length} chars of ${output.length}):\n` +
            preview;
        }
      }

      const completedAt = new Date().toISOString();
      // MAS-P4-T3: per-child accounting — chars kept out of the parent's
      // context via offload, and wall-clock spawn→complete.
      const offloadedChars = workingRef ? Math.max(0, output.length - storedOutput.length) : 0;
      const startedMs = record.startedAt ? Date.parse(record.startedAt) : NaN;
      const wallClockMs = Number.isFinite(startedMs) ? Math.max(0, Date.parse(completedAt) - startedMs) : undefined;
      updateSession(ctx.workspaceRoot, record.id, {
        status: 'completed',
        completedAt,
        finalOutput: storedOutput,
        // MAS-READMANIFEST — capture the files this child read so the phase
        // engine can forward an "already mapped" manifest to later phases.
        filesRead: childAgent.filesRead,
        usage: { ...childAgent.sessionUsage, offloadedChars, wallClockMs },
      });
      // MAS-P2-M6: fire-and-forget feedback record. Skipped silently
      // when MCP is offline or memory_capture_turn isn't exposed.
      void emitRouteFeedback(ctx, {
        task: prompt,
        chosenAgentId: role.name,
        parentAgentId: ctx.parentAgentId,
        ownership,
        outcome: 'success',
        record,
        completedAt,
        tokenCost:
          (childAgent.sessionUsage?.promptTokens ?? 0) +
          (childAgent.sessionUsage?.completionTokens ?? 0),
      });
      // Roll the offload savings into the parent's metrics so /tokens can
      // report what didn't have to land back in the parent's context window.
      if (workingRef && output.length > OFFLOAD_PREVIEW_CHARS) {
        ctx.recordOffload?.(output.length - OFFLOAD_PREVIEW_CHARS);
      }
      // FOOTER-TELEMETRY-2 — roll this child's token spend into the parent's
      // in-memory counter so the footer `offload` segment can show it live.
      ctx.recordChildTokens?.(
        (childAgent.sessionUsage?.promptTokens ?? 0) +
        (childAgent.sessionUsage?.completionTokens ?? 0),
      );
      // Tell the REPL the child finished — otherwise the user sees the child's
      // tool calls scroll by and then silence, with no signal that it's safe
      // to ask the parent agent to continue.
      //
      // Surface a SUBSTANTIAL preview instead of the previous 160-char
      // slice that the user couldn't even read because the notice render
      // truncated it to terminal width. Now:
      //   - Short outputs (≤ AGENT_PREVIEW_MAX): show the FULL body so the
      //     user sees findings + recommendations, not just the headline.
      //   - Long outputs (> AGENT_PREVIEW_MAX): use the heading-aware
      //     `extractChildPreview` to grab the Headline / TL;DR / Summary
      //     section (role overlays nudge children to open with one).
      // The REPL renders this in a multi-line `agent-result` scrollback
      // block so the body wraps freely. Configurable via env var for power
      // users who want to cap it tighter on small terminals.
      // CODEX-WORKTREE-MERGEBACK — merge the child's isolated work back onto the
      // parent tree HERE (clean completion), before the completion notice and any
      // auto-chain review/verify. Doing it in `finally` instead would merge AFTER
      // an auto-chained reviewer already read a stale (un-merged) parent tree.
      // Best-effort: a throw must not turn a succeeded child into a failure.
      let worktreeSummary: { changedFiles?: number; applied?: boolean; patchPath?: string; applyError?: string; heldForReview?: boolean } | undefined;
      let mergeLine = '';
      if (childWorkspace.isolation && !worktreeSettled) {
        try {
          // BUILD-LOOP P2.5 — HOLD the child's changes (don't auto-merge) when it's a
          // build fan-out slice (`holdWorktree` → the synthesis gate owns the merge) or
          // when `cli.worktreeMergeReview` is on (the user applies). Either way the work
          // is captured as a recovery patch and surfaced via `/agents diff <id>`.
          const holdReason: WorktreeHoldReason | null =
            args.holdWorktree === true ? 'fanout' : getCliKnobs().worktreeMergeReview === 'on' ? 'review' : null;
          const cleanup = removeChildWorktree(childWorkspace.isolation, {
            applyBack: !holdReason,
            patchFile: worktreePatchFile(ctx.workspaceRoot, record.id),
          });
          worktreeSettled = true;
          applyWorktreeCleanup(ctx.workspaceRoot, record.id, cleanup);
          if (cleanup.changedFiles) {
            worktreeSummary = {
              changedFiles: cleanup.changedFiles,
              applied: cleanup.applied,
              patchPath: cleanup.patchPath,
              applyError: cleanup.applyError,
              heldForReview: !!holdReason,
            };
            mergeLine = mergeBackLine(cleanup, record.id, holdReason);
          }
        } catch (mergeErr: any) {
          console.error(`[BrainRouter] child ${record.id} merge-back threw (isolated):`, mergeErr?.message ?? mergeErr);
        }
      }

      const AGENT_PREVIEW_MAX = Math.max(400, getCliKnobs().agentPreviewChars);
      const previewBody = (output
        ? (output.length <= AGENT_PREVIEW_MAX
            ? output
            : extractChildPreview(output, AGENT_PREVIEW_MAX))
        : (storedOutput ?? '').slice(0, AGENT_PREVIEW_MAX)) + mergeLine;
      ctx.onChildComplete?.({
        childId: record.id,
        role: role.name,
        status: 'completed',
        preview: previewBody,
        worktree: worktreeSummary,
      });
      if (reportCompletionToParent) {
        enqueueCompletion(ctx.parentSessionKey, {
          kind: 'agent', id: record.id, status: 'completed',
          label: role.name, summary: storedOutput, completedAt,
        });
      }

      // Auto-chain (MAS-P4-T4): when a worker finishes, optionally chain a
      // review and/or verify follow-up on its output — closing the "agent
      // shipped, did it actually work?" loop without the user remembering
      // to ask. Only workers chain, and reviewers/verifiers aren't workers,
      // so a follow-up never triggers another follow-up. `autoChain` is the
      // canonical mode; legacy `/auto-review on` resolves to `review`.
      if (role.name === 'worker') {
        const prefs = readPreferences(ctx.workspaceRoot);
        const mode = resolveAutoChainMode(prefs);
        const roles = autoChainRoles(mode, getCliKnobs().autoChainMaxFollowups);
        const followUps: string[] = [];
        for (const followRole of roles) {
          const verb = followRole === 'verifier' ? 'Verify' : 'Review';
          const detail =
            followRole === 'verifier'
              ? 'Run the relevant tests / build and confirm the work is correct.'
              : 'Review the diff for correctness, regressions, and missed requirements.';
          const out = await handleSpawn(
            {
              role: followRole,
              prompt: `Auto-${followRole === 'verifier' ? 'verify' : 'review'} the changes made by worker agent ${record.id}. ${detail}\n\nOriginal task:\n${prompt}\n\nWorker output (or ref):\n${storedOutput}`,
              label: `auto-${followRole}-${record.id}`,
              access: followRole === 'verifier' ? 'shell' : 'read',
              seedRecordIds: seededIds,
              // Pre-authorized by the user's /auto-chain setting → no approval prompt.
              autoChainFollowup: true,
            },
            ctx,
          );
          try {
            const id = JSON.parse(out)?.id;
            if (typeof id === 'string') followUps.push(id);
          } catch {
            /* spawn returned a non-JSON string — skip id capture */
          }
          void verb;
        }
        if (followUps.length > 0) {
          // Record on the worker so wait/summarize can surface the chain,
          // and emit a visible note for the live REPL.
          updateSession(ctx.workspaceRoot, record.id, { autoChainFollowups: roles });
          ctx.onChildComplete?.({
            childId: record.id,
            role: role.name,
            status: 'completed',
            preview: `Follow-up agents: ${roles.join(', ')} (auto-chain: ${mode})`,
          });
        }
      }
    } catch (err: any) {
      // ORCH-FIX — a child failure must stay ISOLATED. Do all failure
      // bookkeeping inside its own try/catch so a throwing callback
      // (onChildComplete / updateSession / emitRouteFeedback) can't turn this
      // into a REJECTED promise → unhandled rejection → process exit.
      try {
        const message = err?.message ?? String(err);
        const syntheticOutput = `ERROR: ${message}`;
        const completedAt = new Date().toISOString();
        updateSession(ctx.workspaceRoot, record.id, {
          status: 'failed',
          completedAt,
          error: message,
          finalOutput: syntheticOutput,
        });
        void emitRouteFeedback(ctx, {
          task: prompt,
          chosenAgentId: role.name,
          parentAgentId: ctx.parentAgentId,
          ownership,
          outcome: 'failure',
          record,
          completedAt,
        });
        ctx.onChildComplete?.({
          childId: record.id,
          role: role.name,
          status: 'failed',
          error: message,
        });
        if (reportCompletionToParent) {
          enqueueCompletion(ctx.parentSessionKey, {
            kind: 'agent', id: record.id, status: 'failed',
            label: role.name, summary: message, completedAt,
          });
        }
      } catch (bookkeepingErr: any) {
        console.error(`[BrainRouter] child ${record.id} failure-bookkeeping threw (isolated):`, bookkeepingErr?.message ?? bookkeepingErr);
      }
    } finally {
      runningPromises.delete(record.id);
      runningChildAgents.delete(record.id); // DESK-6 — handle no longer interruptible
      // CODEX-WORKTREE-CLEANUP — tear down the child's git worktree when it
      // finishes (success or failure). Captures a capped diff into the record
      // first so the child's work isn't silently lost, then removes the
      // worktree + prunes git's admin entry (no more unbounded $TMPDIR growth).
      // CODEX-WORKTREE-MERGEBACK — only reached when the success-path merge-back
      // did NOT run (the child failed/threw, or merge-back itself threw). Capture
      // + PRESERVE the child's work as a recovery patch (no apply — a non-clean
      // child must never auto-mutate the parent tree), then remove the worktree.
      if (childWorkspace.isolation && !worktreeSettled) {
        try {
          const cleanup = removeChildWorktree(childWorkspace.isolation, {
            applyBack: false,
            patchFile: worktreePatchFile(ctx.workspaceRoot, record.id),
          });
          applyWorktreeCleanup(ctx.workspaceRoot, record.id, cleanup);
        } catch (cleanupErr: any) {
          console.error(`[BrainRouter] child ${record.id} worktree cleanup threw:`, cleanupErr?.message ?? cleanupErr);
        }
      }
    }
  })();
  // ORCH-FIX — backstop: a child promise must NEVER reject unhandled (that would
  // hit the global unhandledRejection handler and kill the session). The IIFE
  // already isolates child errors; this guarantees it even if something slips
  // through. handleWait awaits this guarded promise, so a child failure resolves
  // the wait rather than rejecting it.
  runningPromises.set(
    record.id,
    promise.catch((e: any) => {
      console.error(`[BrainRouter] child ${record.id} promise rejected (isolated):`, e?.message ?? e);
    }),
  );

  if (args.wait) {
    return await handleWait({ id: record.id, timeoutMs: args.timeoutMs ?? parentWaitTimeoutMs }, ctx);
  }
  return JSON.stringify({
    id: record.id,
    role: role.name,
    access,
    status: 'running',
    workdir: childLaunchCwd,
    workspaceRoot: childWorkspaceRoot,
    isolatedWorkspace: childWorkspace.isolated,
    isolation: childWorkspace.isolation,
    notice: childWorkspace.notice,
    timeoutMs: parentWaitTimeoutMs,
  }, null, 2);
}

async function offloadChildOutput(
  ctx: OrchestrationContext,
  childId: string,
  role: string,
  prompt: string,
  output: string,
): Promise<string | undefined> {
  const res = await callMcpTool<any>(ctx.mcpClient, 'memory_working_offload', {
    sessionKey: childSessionKey(ctx.parentSessionKey, childId),
    workspacePath: ctx.workspaceRoot,
    payload: output,
    title: `Child ${childId} (${role}) output`,
    summary: prompt.slice(0, 240),
    kind: `child-agent-${role}`,
  });
  if (res.isError) return undefined;
  return res.parsed?.refNodeId ?? res.parsed?.nodeId ?? res.parsed?.ref ?? undefined;
}

// CODEX-WORKTREE-MERGEBACK — persist a worktree-cleanup result onto the child
// record (capped diff + change count + recovery patch path + apply outcome).
// Shared by the success path (merge-back) and the failure/teardown path.
function applyWorktreeCleanup(
  workspaceRoot: string,
  childId: string,
  cleanup: { diff?: string; changedFiles?: number; patchPath?: string; applied?: boolean; applyError?: string },
): void {
  const patch: Partial<ChildSessionRecord> = {};
  if (cleanup.diff) patch.worktreeDiff = cleanup.diff;
  if (typeof cleanup.changedFiles === 'number') patch.worktreeChangedFiles = cleanup.changedFiles;
  if (cleanup.patchPath) patch.worktreePatchPath = cleanup.patchPath;
  if (typeof cleanup.applied === 'boolean') patch.worktreeApplied = cleanup.applied;
  if (cleanup.applyError) patch.worktreeApplyError = cleanup.applyError;
  if (Object.keys(patch).length > 0) {
    try { updateSession(workspaceRoot, childId, patch); } catch { /* record may be closed */ }
  }
}
