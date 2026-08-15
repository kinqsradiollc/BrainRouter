/**
 * One-turn CLI lifecycle and callback bridge. Checkpoints and peer receipts
 * follow actual turn outcomes; title and expiry callbacks are generation-bound
 * so a completed old turn cannot mutate the active logical session.
 */
import { getCliKnobs } from '@kinqs/brainrouter-core/config';
import { getSessionMeta, readPreferences } from '@kinqs/brainrouter-core/session';
import { runHooks, applyMessageDisplayHooks } from '@kinqs/brainrouter-core/hooks';
import { beginTurnCheckpoint, endTurnCheckpoint, queueOfflinePrompt, isConnectivityError } from '@kinqs/brainrouter-core/storage';
import { shouldAutoExtractSkill, buildSessionSummary } from '../../../runtime/commands/autoSkill.js';
import { callMcpTool } from '@kinqs/brainrouter-core/mcp';
import { toolPairKey } from '../../../runtime/observability/toolPairing.js';
import { expandMentions } from '../../../memory/mentions.js';
import { formatToolCall } from '../text/toolFormat.js';
import type { RunAgentTurnOptions } from '../../commands/_context.js';
import type { RunChatContext } from './context.js';
import {
  forgetExpiredPeerMessageForAgent,
  markApprovedPeerMessageApplied,
} from '../../../runtime/federation/peerMessageAdmission.js';

/**
 * Run a single agent turn through the Ink chat REPL. Mirrors
 * cli/repl.ts:runAgentTurn but pushes events through the Ink scrollback
 * controller instead of console.log + ora spinner. Owns the full per-turn
 * event wiring (streaming deltas, tool start/end pairing, child-fleet
 * tracking, batch-spawn detection) plus the post-turn surface behaviours
 * (goal continuation, child auto-resume, skill extraction, queue drain).
 */
export function installTurnRunner(ctx: RunChatContext): void {
  const { agent, mcpClient } = ctx;
  const isQuiet = () => ctx.isQuiet();

  ctx.runChatTurn = async (
    rawInput: string,
    options: RunAgentTurnOptions = {},
  ): Promise<void> => {
    if (!ctx.controller) return;
    const controller = ctx.controller;
    const turnAgent = options.agent ?? agent;
    const ephemeral = options.ephemeral === true;
    const turnSessionKey = turnAgent.sessionKey;
    if (ctx.isProcessing) {
      controller.push.notice('A previous turn is still running.');
      return;
    }
    // A fresh turn supersedes any armed auto-resume watch.
    ctx.cancelChildResume();
    ctx.isProcessing = true;
    if (!ephemeral) void ctx.federation?.updateRegistration({ state: 'working' });
    ctx.clearIdleHint();
    // CLI-21 — crash checkpoint: record the in-flight prompt before the turn so
    // a mid-turn crash can be recovered on the next launch. Cleared in finally.
    if (!ephemeral) {
      beginTurnCheckpoint(turnAgent.workspaceRoot, turnAgent.sessionKey, rawInput, new Date().toISOString());
    }
    let turnToolCalls = 0; // MEM-33b — multi-step signal for auto skill extraction

    const { expanded, mentions } = expandMentions(rawInput, turnAgent.workspaceRoot);
    if (mentions.length > 0 && !isQuiet()) {
      controller.push.notice(`📎 Attached ${mentions.length} file${mentions.length === 1 ? '' : 's'}: ${mentions.map((m) => m.token).join(', ')}`);
    }

    const startedAt = Date.now();
    controller.push.setPhase('turn-running');
    controller.push.setStatus('Agent starting...');

    let parentDone = false;
    const tickStatus = (status: string) => {
      if (parentDone) return;
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const u = turnAgent.lastTurnUsage;
      const tokens = u.calls > 0 ? `  ${u.promptTokens.toLocaleString()}↑ ${u.completionTokens.toLocaleString()}↓` : '';
      // When children are alive — typically because the parent is in a
      // wait_agent / wait_agents / R1 guardrail auto-drain — append a
      // compact "running children" row so the parent never looks frozen.
      // Compact tail in the status line ("· 3 parallel"); the pinned
      // child-fleet scrollback row carries the full per-agent detail so
      // we don't need to cram every name in here.
      const n = runningChildren.size;
      const childrenRow = n > 0 ? `  · ${n} parallel` : '';
      controller!.push.setStatus(`${status}  ${elapsed}s${tokens}${childrenRow}`);
    };

    // Per-tool start time + args — agent.runTurn fires onToolStart with
    // full args but onToolEnd only sees name + result, so we stash the
    // args here so the end-of-call scrollback row can render the
    // formatted call (`Read(src/foo.ts)`) instead of just the bare name.
    // The map key is the LLM tool_call id when present (so parallel same-name calls
    // pair to their OWN start row), falling back to the tool name when a provider
    // omits ids. See runtime/observability/toolPairing.ts (toolPairKey).
    const toolStartTimes = new Map<string, number>();
    const toolArgsSnapshot = new Map<string, Record<string, any>>();
    // In-flight LOCAL tool calls, so a parallel batch shows ALL of them running
    // at once instead of the status line being overwritten by whichever
    // onToolStart fired last. Mirrors the child-fleet row treatment below —
    // parallelism is the point, so surface it. Labels are the formatted calls
    // (`Read(README.md)`); same-label parallel calls are tracked as duplicates.
    const inFlightToolLabels: string[] = [];
    const renderInFlightStatus = () => {
      if (isQuiet()) return;
      if (inFlightToolLabels.length === 0) { tickStatus('Thinking'); return; }
      if (inFlightToolLabels.length === 1) { controller!.push.setStatus(inFlightToolLabels[0]); return; }
      const shown = inFlightToolLabels.slice(0, 4).join(', ');
      const more = inFlightToolLabels.length > 4 ? ` +${inFlightToolLabels.length - 4} more` : '';
      controller!.push.setStatus(`${inFlightToolLabels.length} tools running in parallel: ${shown}${more}`);
    };
    // Stash child tool args between onChildToolStart and onChildToolEnd so the
    // end row can render `Read(foo.ts)` instead of just `read_file`. Keyed by
    // `${childId}:${tool}` so two children running the same tool don't collide.
    const childToolArgs = new Map<string, Record<string, any>>();
    // Currently-running children for the compact "running children" status row.
    // Maintained from onChildToolStart / onChildComplete (the only signals the
    // REPL gets about child lifecycle that don't require re-reading sessions).
    const runningChildren = new Map<string, { role: string; tool?: string }>();
    // Debounce pushes of the child-fleet row update so a burst of N
    // onChildToolStart events (which all fire within milliseconds when
    // spawn_agents launches a batch) coalesces into ONE render. Without
    // this, the row flips through "1 running" → "2 running" → "3 running"
    // in quick succession and the user sees flicker instead of "3 parallel".
    let fleetFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFleetFlush = () => {
      if (fleetFlushTimer) return;
      fleetFlushTimer = setTimeout(() => {
        fleetFlushTimer = null;
        const snapshot = [...runningChildren.entries()].map(([childId, info]) => ({
          childId, role: info.role, tool: info.tool,
        }));
        controller!.push.setChildFleet(snapshot);
      }, 50);
    };
    // Batch-spawn detection — when 2+ NEW children appear within a short
    // window, emit a single "🚀 Spawned N agents in parallel: …" notice
    // instead of N individual "▶ X running" lines.
    const pendingSpawns: Array<{ childId: string; role: string }> = [];
    const profileStageStates = new Map<string, string>();
    let pendingSpawnTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPendingSpawns = () => {
      pendingSpawnTimer = null;
      if (pendingSpawns.length === 0) return;
      controller!.push.spawnBatch(pendingSpawns.slice());
      pendingSpawns.length = 0;
    };
    const enqueueSpawnNotice = (childId: string, role: string) => {
      pendingSpawns.push({ childId, role });
      if (pendingSpawnTimer) clearTimeout(pendingSpawnTimer);
      pendingSpawnTimer = setTimeout(flushPendingSpawns, 120);
    };
    try {
      const answer = await turnAgent.runTurn(expanded, {
        onSessionTitle: (event) => {
          // Title generation completes asynchronously after first-turn
          // persistence. Publish immediately, but never let a late callback
          // rename a participant that /resume or /new has already rebound.
          if (ephemeral || turnAgent !== agent) return;
          if (agent.sessionKey !== turnSessionKey) return;
          if (agent.getFederationSessionKey() !== turnSessionKey) return;
          if (ctx.federation?.sessionKey !== turnSessionKey) return;
          void ctx.federation.updateRegistration({
            title: event.title,
            titleSource: event.source,
          });
        },
        onStatusUpdate: tickStatus,
        onSteerApplied: (input, receipt) => {
          if (input.source === 'peer-session') {
            markApprovedPeerMessageApplied(turnAgent, turnSessionKey, input.id);
            void ctx.federation?.transitionInbound(input.id, 'applied');
          }
          controller!.push.notice(
            `${input.source === 'peer-session' ? 'Peer message applied at a safe boundary' : 'Steer received'} · ${receipt.id.slice(0, 8)} · awaiting classification`,
            'info',
          );
        },
        onSteerExpired: (input) => {
          forgetExpiredPeerMessageForAgent(turnAgent, input.id);
          void ctx.federation?.transitionInbound(
            input.id,
            'expired',
            'Message expired before recipient safe-boundary application.',
          );
          controller!.push.notice(
            `Peer message expired before safe-boundary application · ${input.id.slice(0, 8)}`,
            'warn',
          );
        },
        onSteerReceipt: (receipt) => {
          const classification = receipt.classification?.replace('_', ' ') ?? 'pending';
          const revision = receipt.resultingRevision
            ? ` · plan r${receipt.resultingRevision}`
            : '';
          controller!.push.notice(
            `Steer ${receipt.status} · ${classification}${revision}`,
            receipt.status === 'needs_user' || receipt.status === 'rejected' ? 'warn' : 'info',
          );
        },
        // TIER A live streaming hooks. The agent calls these as SSE
        // frames arrive so the chat shows text character-by-character.
        // assistantDeltaEnd() clears the transient
        // row; the final scrollback entry is pushed below.
        onAssistantTurnStart: () => {
          controller!.push.assistantDeltaStart();
        },
        onAssistantDelta: (chunk) => {
          controller!.push.assistantDelta(chunk);
        },
        onAssistantTurnEnd: () => {
          controller!.push.assistantDeltaEnd();
        },
        onReasoningDelta: (chunk) => {
          controller!.push.reasoningDelta(chunk);
        },
        onCompactionEvent: (event) => {
          controller!.push.compaction(event);
          tickStatus('Thinking');
        },
        onToolStart: (name, args, callId) => {
          // Surface the in-flight tool via the spinner status line — the
          // scrollback entry is pushed at onToolEnd so each tool call is
          // a single block (header + result), not two rows.
          turnToolCalls++;
          const key = toolPairKey(name, callId);
          toolStartTimes.set(key, Date.now());
          toolArgsSnapshot.set(key, args ?? {});
          // Track this call as in-flight and render the WHOLE set, so a
          // parallel batch shows "4 tools running in parallel: …" rather than
          // the last call clobbering the status line.
          inFlightToolLabels.push(formatToolCall(name, args));
          renderInFlightStatus();
        },
        onToolEnd: (name, result, callId) => {
          // Quiet mode hides successes (the prose response covers them).
          if (isQuiet() && result.success) {
            tickStatus('Thinking');
            return;
          }
          const key = toolPairKey(name, callId);
          const startedAt = toolStartTimes.get(key);
          const args = toolArgsSnapshot.get(key);
          toolStartTimes.delete(key);
          toolArgsSnapshot.delete(key);
          const durationMs = startedAt ? Date.now() - startedAt : undefined;
          const header = formatToolCall(name, args);
          // Drop this call from the in-flight set, then refresh the status so a
          // parallel batch visibly counts down (4 running → 3 → … → Thinking)
          // instead of jumping straight to idle while siblings are still going.
          const fi = inFlightToolLabels.indexOf(header);
          if (fi >= 0) inFlightToolLabels.splice(fi, 1);
          controller!.push.tool(header, result.success, {
            preview: !isQuiet() ? result.preview : undefined,
            durationMs,
          });
          renderInFlightStatus();
        },
        onPlanUpdate: (items, explanation, state) => {
          // Explanation rides on the plan entry itself (renders as a dim-italic
          // line above the checklist) rather than as a separate memory event,
          // so the explanation visually anchors to the plan it describes.
          controller!.push.plan(items, explanation, state);
          tickStatus('Thinking');
        },
        onProfileStageUpdate: (event) => {
          if (event.phase === 'resolved') {
            controller!.push.notice(
              `Profile plan · ${event.profileId} / ${event.strategyId} · ${event.selectionSource}`,
            );
          }
          if (event.phase !== 'terminated') {
            for (const stage of event.stages) {
              const signature = `${stage.state}:${stage.activeSkillId ?? ''}`;
              if (event.phase === 'updated' && profileStageStates.get(stage.id) !== signature) {
                const owner = stage.executor === 'role' ? ` · ${stage.roleId}` : '';
                const skill = stage.activeSkillId ? ` · skill ${stage.activeSkillId}` : '';
                controller!.push.notice(`Profile stage · ${stage.id} · ${stage.state}${owner}${skill}`);
              }
              profileStageStates.set(stage.id, signature);
            }
          }
          tickStatus('Thinking');
        },
        onChildToolStart: (event) => {
          const key = `${event.childId}:${event.tool}`;
          childToolArgs.set(key, event.args ?? {});
          const prior = runningChildren.get(event.childId);
          runningChildren.set(event.childId, { role: event.role, tool: event.tool });
          // Update the pinned child-fleet scrollback row (debounced) so
          // ALL running children are visible at once. Multi-agent
          // parallelism is the point — the old transient setStatus only
          // showed the most recent event.
          scheduleFleetFlush();
          // First-tool notice: queue the child for the batch-spawn
          // detector. If 2+ NEW children appear within the debounce
          // window they collapse into a single "🚀 Spawned N agents in
          // parallel: …" notice; a single late arrival still renders
          // as one line.
          if (!prior && !isQuiet()) {
            enqueueSpawnNotice(event.childId, event.role);
          }
          // Surface the new child in the footer ("· N working") even if the
          // parent is in the middle of a tool batch — getRunningChildCount
          // reads session-store status so the count is authoritative.
          ctx.refreshFooter();
          // FLEET-SIDEBAR — push the live running set into the sidebar's
          // Sub-agents section NOW, and keep the 3s ticker alive during the
          // turn. Without this the sidebar only refreshed post-turn, so
          // task_agent / spawn_agents children that spawn AND finish inside the
          // parent turn never appeared as running.
          ctx.refreshBackgroundTasks();
          ctx.ensureChildRefreshTimer();
        },
        onChildToolEnd: (event) => {
          const key = `${event.childId}:${event.tool}`;
          const args = childToolArgs.get(key);
          childToolArgs.delete(key);
          // Tool finished — null out the tool field so the fleet row
          // stops showing a stale tool name, and re-flush so the user
          // sees the live transition (running Read → running Bash, etc.).
          const cur = runningChildren.get(event.childId);
          if (cur) runningChildren.set(event.childId, { role: cur.role, tool: undefined });
          scheduleFleetFlush();
          const idShort = event.childId.slice(0, 8);
          const idLabel = event.childId.startsWith('agent-') ? event.childId.slice(0, 14) : 'agent-' + idShort;
          const inner = formatToolCall(event.tool, args);
          const header = `[${idLabel} ${event.role}] ${inner}`;
          // Quiet-mode rule (carried from R1): hide noisy success previews,
          // but still print the paired row so the user has a visible signal
          // that the child made progress.
          controller!.push.tool(header, event.ok, {
            preview: !isQuiet() ? event.preview : undefined,
            durationMs: event.durationMs,
          });
          tickStatus('Thinking');
        },
        onChildComplete: (event) => {
          runningChildren.delete(event.childId);
          scheduleFleetFlush();
          const ok = event.status === 'completed';
          // Multi-line block so the agent's full headline/summary survives
          // instead of being clipped to terminal width. Falls back to the
          // shared interruption summary or error when the child did not finish.
          const body = ok
            ? (event.preview ?? '')
            : event.status === 'interrupted'
              ? (event.summary ?? 'agent interrupted')
              : (event.error ?? 'agent failed without an error message');
          controller!.push.agentResult({
            childId: event.childId,
            role: event.role,
            status: event.status,
            body,
          });
          tickStatus('Thinking');
          // Decrement the footer "· N working" pill as soon as a child
          // settles — without this it'd stay stuck at the pre-completion
          // number until the next user input refreshes the footer.
          ctx.refreshFooter();
          // FLEET-SIDEBAR — keep the sidebar's Sub-agents section in sync as
          // children settle (mirror of the footer refresh above).
          ctx.refreshBackgroundTasks();
          // MAR-2 — this completed child may be the last one the main agent was
          // waiting on; deliver its result now rather than only on the poll tick.
          ctx.maybeResumeOnChildComplete();
        },
        onMemoryEvent: (event) => {
          if (isQuiet() && event.kind !== 'contradiction') return;
          let line: string | undefined;
          let level: 'info' | 'warn' = 'info';
          if (event.kind === 'briefing') {
            const src = event.sources.length > 0 ? event.sources.join(', ') : '(none)';
            line = `🧠 Briefing: ${event.recordCount} record${event.recordCount === 1 ? '' : 's'} from ${src}`;
          } else if (event.kind === 'capture') {
            const sensory = event.sensoryRecorded ?? event.messageCount;
            const extracted = event.extractedCount;
            const triggered = event.extractionTriggered;
            const sk = event.sessionKey;
            if (event.extractionWarning) {
              line = `💾 Captured ${sensory} sensory msg(s) in ${sk} — ⚠️ ${event.extractionWarning}`;
              level = 'warn';
            } else if (triggered && typeof extracted === 'number') {
              line = extracted > 0
                ? `💾 Captured ${sensory} msg(s) → ${extracted} cognitive record(s) extracted (${sk})`
                : `💾 Captured ${sensory} msg(s) → no new memories worth promoting (${sk})`;
            } else if (triggered === false) {
              line = `💾 Captured ${sensory} msg(s) → sensory buffer (${sk})`;
            } else {
              line = `💾 Captured ${sensory} msg(s) → memory (${sk})`;
            }
          } else if (event.kind === 'citation' && event.recordIds.length > 0) {
            line = `📌 Reinforced ${event.recordIds.length} record${event.recordIds.length === 1 ? '' : 's'}: ${event.recordIds.slice(0, 3).join(', ')}${event.recordIds.length > 3 ? '…' : ''}`;
          } else if (event.kind === 'contradiction') {
            line = `⚠️ Memory contradiction: ${event.warning.slice(0, 140)}`;
            level = 'warn';
          }
          if (line) controller!.push.memory(level, line);
          tickStatus('Thinking');
        },
        // §truncation — a persistent provider-truncation notice rendered as a
        // durable system row (not a transient status line).
        onNotice: (notice) => {
          if (notice?.message) controller!.push.memory(notice.level ?? 'info', `✂️ ${notice.message}`);
        },
      }, options.executionIntent ? { executionIntent: options.executionIntent } : undefined);

      parentDone = true;
      // Flush any pending batch-spawn notice + final fleet snapshot so
      // the last bits of state aren't stranded behind a 50ms / 120ms
      // debounce when the turn finishes faster than that.
      if (pendingSpawnTimer) {
        clearTimeout(pendingSpawnTimer);
        flushPendingSpawns();
      }
      if (fleetFlushTimer) {
        clearTimeout(fleetFlushTimer);
        fleetFlushTimer = null;
      }
      controller!.push.setChildFleet([...runningChildren.entries()].map(([childId, info]) => ({
        childId, role: info.role, tool: info.tool,
      })));
      const elapsed = Date.now() - startedAt;
      const u = turnAgent.lastTurnUsage;
      // Pass the raw answer to ChatApp; ChatApp's ScrollbackRow renders
      // it through marked-terminal unless `raw: true` is set. Honors the
      // user's rawScrollback preference exactly like the readline path.
      const prefsForRender = readPreferences(turnAgent.workspaceRoot);
      // CC-hooks parity — message-display hook. A user hook may TRANSFORM the
      // about-to-display assistant text ({"updatedOutput":"…"}) or HIDE it
      // ({"decision":"deny"}). No-op when the hooks system is off or no
      // message-display hook is registered (runHooks returns []). Best-effort:
      // a throwing hook must never drop the assistant's answer.
      let displayText = answer;
      let displayHidden = false;
      if (getCliKnobs().hooks.enabled && !getCliKnobs().safeMode) {
        try {
          const outcome = applyMessageDisplayHooks(
            answer,
            runHooks(turnAgent.workspaceRoot, 'message-display', { payload: { text: answer } }),
          );
          displayText = outcome.text;
          displayHidden = outcome.hidden;
        } catch { /* hook failure never hides the real answer */ }
      }
      if (!displayHidden) {
        controller.push.assistant(displayText, {
          raw: prefsForRender.rawScrollback === true,
          durationMs: elapsed,
          tokensIn: u.promptTokens,
          tokensOut: u.completionTokens,
          calls: u.calls,
        });
      }
      const warning = turnAgent.takeContradictionWarning();
      if (warning) {
        controller.push.memory('warn', `Memory: ${warning}`);
        controller.push.memory('info', `Use /memory or /briefing to investigate, /forget <id> to archive obsolete records.`);
      }

      // Goal continuation lives at the bottom of the success path so a
      // failed turn doesn't trigger it (we don't want auto-retry loops).
      if (!ephemeral) ctx.scheduleGoalContinuation(rawInput, answer);

      // C1 — if this turn ended with timed-out children, arm the auto-resume watch
      // (skipped when a goal continuation already owns the next turn).
      if (!ephemeral) ctx.scheduleChildResume();

      // MEM-33b — after a successful MULTI-STEP turn, fire-and-forget distil a
      // reusable skill (the brain's <no-skill/> gate drops trivial runs). Opt-in
      // (cli.autoExtractSkills, off by default — one LLM call per turn). Fully
      // self-contained so it can never disturb the session.
      if (!ephemeral && shouldAutoExtractSkill({ enabled: getCliKnobs().autoExtractSkills, toolCalls: turnToolCalls, answerLength: (answer ?? '').length })) {
        const summary = buildSessionSummary(rawInput, answer, turnToolCalls);
        void (async () => {
          try { await callMcpTool(mcpClient, 'memory_extract_skill', { sessionSummary: summary, sessionKey: turnAgent.sessionKey, activeSkill: turnAgent.activeSkill }); }
          catch { /* best-effort — never disturb the session */ }
        })();
      }
    } catch (err: any) {
      parentDone = true;
      controller.push.notice(`✗ Execution failed: ${err?.message ?? err}`, 'error');
      // CLI-21 — a connectivity failure means the prompt wasn't really handled;
      // queue it so it isn't lost (offered for replay on reconnect / relaunch).
      if (!ephemeral && isConnectivityError(err)) {
        queueOfflinePrompt(turnAgent.workspaceRoot, turnAgent.sessionKey, rawInput, new Date().toISOString());
        controller.push.notice('↺ Saved to the offline queue — it was a connectivity error.', 'info');
      }
    } finally {
      ctx.isProcessing = false;
      if (!ephemeral) {
        const sessionMeta = getSessionMeta(turnAgent.workspaceRoot, turnAgent.sessionKey);
        void ctx.federation?.updateRegistration({
          state: 'idle',
          title: sessionMeta.title,
          titleSource: sessionMeta.titleSource,
        });
      }
      // CLI-21 — turn settled (success or normal error): clear the in-flight
      // checkpoint so only a true crash leaves one behind.
      if (!ephemeral) endTurnCheckpoint(turnAgent.workspaceRoot, turnAgent.sessionKey);
      controller.push.setPhase('idle');
      controller.push.setStatus('');
      turnAgent.activeSkill = undefined;
      turnAgent.activeSkills = [];
      // CC-SKILLS-D3 — the skill's per-turn tool blacklist is cleared with it.
      turnAgent.activeSkillDisallowedTools = [];
      turnAgent.activeSkillAllowedTools = undefined;
      turnAgent.refreshSystemPrompt();
      ctx.refreshFooter();
      // If background children survived the parent turn (delegate_agent
      // fire-and-forget pattern), arm the polling ticker so the footer
      // count decrements when they finish — without this the "· N working"
      // pill would stick until the user types something.
      ctx.ensureChildRefreshTimer();
      ctx.refreshBackgroundTasks(); // immediate panel update post-turn (don't wait for the 3s tick)
      // PARITY-W3: now that the turn is over (isProcessing=false), surface any
      // background actor that finished WHILE the turn was running — those were
      // held back so they didn't scroll past under the active turn.
      ctx.notifyIdleCompletions();
      ctx.armIdleHint();
      // C2 — run the next queued message (if any) now the turn has settled and
      // nothing else (goal continuation / child auto-resume) owns the next turn.
      if (!ephemeral) ctx.drainInputQueue();
    }
  };
}
