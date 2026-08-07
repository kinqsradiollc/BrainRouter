import type { Agent, RunTurnCallbacks } from '../agent.js';
import { getCliKnobs } from '../../config/config.js';
import { readPlan } from '../../task/taskStore.js';
import { pendingSteeringConstraint } from '../../task/steeringReceiptStore.js';
import {
  mergePendingChildIds,
  unsynthesizedChildIds,
} from '../../util/agentloop/childResume.js';
import { sanitizeModelArtifacts } from '../../util/agentloop/outputSanitize.js';
import { looksLikeChildSynthesisPunt } from '../../util/agentloop/synthesisGuard.js';
import {
  buildDeliverableCorrection,
  classifyDeferral,
} from '../guards/deliverableCheck.js';
import {
  shouldRunFanOutDifferentiationGuard,
  shouldRunFanOutFollowThroughGuard,
} from '../guards/fanOutFollowThroughGuard.js';
import { getSession } from '../../orchestration/session/orchestrator.js';
import {
  looksLikeDeferredToolPromise,
  looksLikeStalledPreamble,
} from '../guards/toolCallRecovery.js';
import {
  buildTaskTrackingNudge,
  shouldNudgeTaskTracking,
} from '../guards/taskTrackingNudge.js';
import {
  buildBudgetCheckpoint,
  isBudgetCheckpoint,
} from '../guards/turnBudget.js';
import {
  buildDocsOnlyVerificationNote,
  buildVerificationNudge,
  decideVerification,
} from '../guards/verificationGate.js';
import { localModelProfileActive } from '../../provider/modelFamily.js';
import { isInternalSessionKey } from '../../session/transcript/sessionStore.js';
import { applyPendingSteeringAtBoundary } from './steering.js';
import {
  childSynthesisGuardMessage,
  emptyAnswerGuardMessage,
  fanOutGuardMessage,
  undifferentiatedFanOutGuardMessage,
  planSyncGuardMessage,
  promisedToolsGuardMessage,
  stalledPreambleGuardMessage,
} from './turnGuardMessages.js';

interface ModelResponse {
  content?: string | null;
}

export interface TurnLifecycleCoordinatorInput {
  agent: Agent;
  callbacks: RunTurnCallbacks;
  budgetWindow: number;
  maxLoops: number;
  fanOutHinted: boolean;
}

export interface TerminalGuardInput {
  response: ModelResponse;
  spawnedChildIds: Set<string>;
  waitedChildIds: Set<string>;
}

export type TerminalGuardResult =
  | { action: 'continue' }
  | { action: 'finish'; answer: string };

export class TurnLifecycleCoordinator {
  private readonly agent: Agent;
  private readonly callbacks: RunTurnCallbacks;
  private readonly budgetWindow: number;
  private readonly maxLoops: number;
  private readonly fanOutHinted: boolean;
  private readonly planCompletedAtTurnStart: number;
  private budgetCheckpointsFired = 0;
  private preambleGuardFired = 0;
  private fanOutGuardFired = 0;
  private fanOutDifferentiationGuardFired = 0;
  private deliverableGuardFired = 0;
  private verificationNudged = false;
  private planSyncGuardFired = 0;
  private steeringReconciliationGuardFired = 0;
  private requirementPlanTrackSyncGuardFired = 0;
  private sprintAutomationGuardFired = 0;
  private synthesisGuardFired = 0;
  private childOutputDelivered = false;
  private promisedToolsAtCount = -1;

  constructor(input: TurnLifecycleCoordinatorInput) {
    this.agent = input.agent;
    this.callbacks = input.callbacks;
    this.budgetWindow = input.budgetWindow;
    this.maxLoops = input.maxLoops;
    this.fanOutHinted = input.fanOutHinted;
    try {
      this.planCompletedAtTurnStart = readPlan(
        this.agent.workspaceRoot,
        this.agent.sessionKey,
      ).items.filter((item) => item.status === 'completed').length;
    } catch {
      this.planCompletedAtTurnStart = 0;
    }
  }

  beginLoop(loopCount: number): string | undefined {
    if (this.agent.interruptRequested) {
      this.agent.interruptRequested = false;
      const interruptMessage = {
        role: 'system',
        content:
          'The user interrupted this turn before it finished; the work above may be incomplete.',
      };
      this.agent.chatHistory.push(interruptMessage);
      this.agent.recordTranscript(interruptMessage);
      this.callbacks.onStatusUpdate('Interrupted');
      return '⏹ Turn interrupted by user.';
    }

    applyPendingSteeringAtBoundary(this.agent, this.callbacks);
    if (
      isBudgetCheckpoint(
        loopCount,
        this.budgetWindow,
        this.budgetCheckpointsFired,
      )
    ) {
      this.budgetCheckpointsFired += 1;
      const used = loopCount - 1;
      const checkpointMessage = {
        role: 'user',
        content: buildBudgetCheckpoint(used, this.maxLoops - used),
      };
      this.agent.chatHistory.push(checkpointMessage);
      this.agent.recordTranscript({ ...checkpointMessage, name: 'guard' });
      this.callbacks.onStatusUpdate(
        `Tool-budget checkpoint at ${used} calls — reassessing whether to continue`,
      );
    }
    this.callbacks.onStatusUpdate(`Thinking (turn ${loopCount})...`);
    return undefined;
  }

  setPromisedToolsAtCount(count: number): void {
    this.promisedToolsAtCount = count;
  }

  getPromisedToolsAtCount(): number {
    return this.promisedToolsAtCount;
  }

  markChildOutputDelivered(): void {
    this.childOutputDelivered = true;
  }

  applyPendingSteeringGuard(): boolean {
    if (applyPendingSteeringAtBoundary(this.agent, this.callbacks) > 0) {
      return true;
    }
    const pending = pendingSteeringConstraint(
      this.agent.workspaceRoot,
      this.agent.sessionKey,
    );
    if (!pending || this.steeringReconciliationGuardFired >= 1) return false;

    this.steeringReconciliationGuardFired += 1;
    const instruction = pending.phase === 'classify'
      ? `Call \`reconcile_steer\` for receipt "${pending.receiptId}" before continuing or finishing.`
      : `Call \`update_plan\` with steeringReceiptId "${pending.receiptId}" before related work or finishing.`;
    return this.continueWithGuard(
      `A steering receipt is still pending. ${instruction}`,
      'Pending steer requires typed reconciliation',
    );
  }

  evaluateTerminalGuards(input: TerminalGuardInput): TerminalGuardResult {
    const content = input.response.content ?? '';
    if (
      this.preambleGuardFired < 2
      && this.agent.lastTurnToolCalls > 0
      && !content.trim()
    ) {
      this.preambleGuardFired += 1;
      this.continueWithGuard(
        emptyAnswerGuardMessage(this.agent.lastTurnToolCalls),
        `Recovery: empty-answer-after-tools (${this.preambleGuardFired}/2) — forcing synthesis`,
      );
      return { action: 'continue' };
    }

    if (
      this.preambleGuardFired < 2
      && looksLikeStalledPreamble(content)
      && (
        this.agent.lastTurnToolCalls > 0
        || looksLikeDeferredToolPromise(content)
      )
    ) {
      this.preambleGuardFired += 1;
      this.continueWithGuard(
        stalledPreambleGuardMessage(content),
        `Recovery: preamble-without-action (${this.preambleGuardFired}/2) — forcing continuation`,
      );
      return { action: 'continue' };
    }

    if (
      this.preambleGuardFired < 2
      && this.promisedToolsAtCount >= 0
      && this.agent.lastTurnToolCalls === this.promisedToolsAtCount
    ) {
      this.preambleGuardFired += 1;
      this.promisedToolsAtCount = -1;
      this.continueWithGuard(
        promisedToolsGuardMessage(),
        `Recovery: promised-tools-then-asked (${this.preambleGuardFired}/2) — steering to discovery`,
      );
      return { action: 'continue' };
    }

    if (shouldRunFanOutFollowThroughGuard({
      fanOutHinted: this.fanOutHinted,
      guardFired: this.fanOutGuardFired,
      maxGuardFires: 1,
      spawnedChildCount: input.spawnedChildIds.size,
      interactiveTopLevel:
        !this.agent.silent && this.agent.agentDepth === 0,
      internalSession: isInternalSessionKey(this.agent.sessionKey),
    })) {
      this.fanOutGuardFired += 1;
      this.continueWithGuard(
        fanOutGuardMessage(),
        `Recovery: fan-out-hinted-but-no-spawn (${this.fanOutGuardFired}/1) — forcing follow-through`,
      );
      return { action: 'continue' };
    }

    // Children were spawned, but if they all carry one angle the fan-out was
    // arithmetic rather than thinking. Labels come from the session records the
    // spawn path already writes, so this needs no spawn-time bookkeeping.
    const childLabels = [...input.spawnedChildIds]
      .map((id) => getSession(this.agent.workspaceRoot, id)?.label);
    if (shouldRunFanOutDifferentiationGuard({
      fanOutHinted: this.fanOutHinted,
      guardFired: this.fanOutDifferentiationGuardFired,
      maxGuardFires: 1,
      childLabels,
      interactiveTopLevel: !this.agent.silent && this.agent.agentDepth === 0,
      internalSession: isInternalSessionKey(this.agent.sessionKey),
    })) {
      this.fanOutDifferentiationGuardFired += 1;
      this.continueWithGuard(
        undifferentiatedFanOutGuardMessage(childLabels.map((label) => label ?? '')),
        `Recovery: fan-out-children-share-one-lens (${this.fanOutDifferentiationGuardFired}/1) — forcing distinct angles`,
      );
      return { action: 'continue' };
    }

    if (
      this.deliverableGuardFired < 1
      && this.agent.lastTurnToolCalls > 0
      && !this.agent.lastGoalTransition
    ) {
      const deferral = classifyDeferral(content);
      if (deferral) {
        this.deliverableGuardFired += 1;
        const preview = content.trim().slice(-160).replace(/\s+/g, ' ');
        this.continueWithGuard(
          buildDeliverableCorrection(deferral, preview),
          `Recovery: ended-on-${deferral} (${this.deliverableGuardFired}/1) — forcing the deliverable`,
        );
        return { action: 'continue' };
      }
    }

    const verificationDecision = this.agent.lastGoalTransition
      ? 'none'
      : decideVerification({
          filesWritten: this.agent.filesWrittenThisTurn,
          shellWroteUnknown: this.agent.shellWroteThisTurn,
          verified: this.agent.verifiedThisTurn,
          alreadyNudged: this.verificationNudged,
        });
    if (verificationDecision !== 'none') {
      this.verificationNudged = true;
      const docsOnly = verificationDecision === 'report-docs-only';
      this.continueWithGuard(
        docsOnly
          ? buildDocsOnlyVerificationNote(this.agent.filesWrittenThisTurn)
          : buildVerificationNudge({
              local: localModelProfileActive(
                this.agent.llmConfig.model,
                getCliKnobs().localModelProfile,
              ),
            }),
        docsOnly
          ? 'Recovery: docs/config-only change — asking the agent to state no verification was required'
          : 'Recovery: wrote files but ran no verification — nudging to verify',
      );
      return { action: 'continue' };
    }

    if (this.planSyncGuardFired < 1 && this.agent.lastTurnToolCalls > 0) {
      let plan: ReturnType<typeof readPlan> | { items: [] };
      try {
        plan = readPlan(this.agent.workspaceRoot, this.agent.sessionKey);
      } catch {
        plan = { items: [] };
      }
      const open = plan.items.filter((item) => item.status !== 'completed');
      const completedNow = plan.items.length - open.length;
      if (
        plan.items.length > 0
        && open.length > 0
        && completedNow === this.planCompletedAtTurnStart
      ) {
        this.planSyncGuardFired += 1;
        this.continueWithGuard(
          planSyncGuardMessage(open),
          `Recovery: plan not advanced this turn — nudging to reconcile (${this.planSyncGuardFired}/1)`,
        );
        return { action: 'continue' };
      }
    }

    this.applyDeterministicAutomation();

    if (!this.agent.taskTrackingNudged) {
      let planCount = 0;
      try {
        planCount = readPlan(
          this.agent.workspaceRoot,
          this.agent.sessionKey,
        ).items.length;
      } catch {
        planCount = 0;
      }
      if (shouldNudgeTaskTracking({
        toolCallsThisTurn: this.agent.lastTurnToolCalls,
        planItemCount: planCount,
        alreadyNudged: this.agent.taskTrackingNudged,
        silent: this.agent.silent,
      })) {
        this.agent.taskTrackingNudged = true;
        this.continueWithGuard(
          buildTaskTrackingNudge(this.agent.lastTurnToolCalls),
          'Reminder: multi-step work with no task list — nudging to use update_plan',
        );
        return { action: 'continue' };
      }
    }

    if (
      this.synthesisGuardFired < 1
      && this.childOutputDelivered
      && looksLikeChildSynthesisPunt(content)
    ) {
      this.synthesisGuardFired += 1;
      this.continueWithGuard(
        childSynthesisGuardMessage(),
        `Recovery: child results delivered but answer deferred — forcing synthesis (${this.synthesisGuardFired}/1)`,
      );
      return { action: 'continue' };
    }

    const unsynthesized = unsynthesizedChildIds(
      input.spawnedChildIds,
      input.waitedChildIds,
    );
    if (unsynthesized.length > 0) {
      this.agent.lastTurnPendingChildIds = mergePendingChildIds(
        this.agent.lastTurnPendingChildIds,
        unsynthesized,
      );
    }

    return {
      action: 'finish',
      answer: content ? sanitizeModelArtifacts(content) : content,
    };
  }

  private applyDeterministicAutomation(): void {
    const automation = getCliKnobs().automation;
    if (
      this.requirementPlanTrackSyncGuardFired < 1
      && this.agent.lastTurnToolCalls > 0
      && automation.enabled
      && automation.sync.enabled
    ) {
      this.requirementPlanTrackSyncGuardFired += 1;
      try {
        this.agent.autoSynchronizeRequirementPlanTrack(this.callbacks);
      } catch {
        // Deterministic synchronization is best-effort.
      }
    }
    if (
      this.sprintAutomationGuardFired < 1
      && this.agent.lastTurnToolCalls > 0
      && automation.enabled
      && automation.sprints.enabled
    ) {
      this.sprintAutomationGuardFired += 1;
      try {
        this.agent.autoSynchronizeSprints(this.callbacks);
      } catch {
        // Deterministic synchronization is best-effort.
      }
    }
  }

  private continueWithGuard(content: string, status: string): true {
    const guardMessage = { role: 'user', content };
    this.agent.chatHistory.push(guardMessage);
    this.agent.recordTranscript({ ...guardMessage, name: 'guard' });
    this.callbacks.onStatusUpdate(status);
    return true;
  }
}
