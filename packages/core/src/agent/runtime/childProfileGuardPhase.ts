import type { Agent, RunTurnCallbacks } from '../agent.js';
import type { ProfileStageController } from '../../orchestration/runtime/profileStageController.js';
import {
  executeOrchestrationTool,
  type OrchestrationContext,
} from '../../orchestration/tools.js';
import { getCliKnobs } from '../../config/config.js';
import {
  formatChildDrainTimeoutAnswer,
  parseChildDrainTimeouts,
  summarizeWaitedChildOutputs,
  trackChildObservation,
} from '../support/childObservation.js';
import { getToolPreview, getToolSummary } from '../support/toolSummary.js';
import {
  buildRequiredDelegatedStageCorrection,
  buildRequiredProfileStageCorrection,
} from './profileStageRuntime.js';

export interface ChildProfileGuardInput {
  agent: Agent;
  callbacks: RunTurnCallbacks;
  spawnedChildIds: Set<string>;
  waitedChildIds: Set<string>;
  buildOrchestrationContext: () => OrchestrationContext;
  profileStageController?: ProfileStageController;
  profileStageGuardFired: number;
  profileStageGuardMax: number;
}

export interface ChildProfileGuardResult {
  action: 'none' | 'continue' | 'finish';
  profileStageGuardFired: number;
  childOutputDelivered: boolean;
  answer?: string;
}

function continueWithGuard(
  agent: Agent,
  callbacks: RunTurnCallbacks,
  content: string,
  status: string,
  profileStageGuardFired: number,
): ChildProfileGuardResult {
  const guardMessage = { role: 'user', content };
  agent.chatHistory.push(guardMessage);
  agent.recordTranscript({ ...guardMessage, name: 'guard' });
  callbacks.onStatusUpdate(status);
  return {
    action: 'continue',
    profileStageGuardFired,
    childOutputDelivered: false,
  };
}

export async function runChildProfileGuardPhase(
  input: ChildProfileGuardInput,
): Promise<ChildProfileGuardResult> {
  const {
    agent,
    callbacks,
    spawnedChildIds,
    waitedChildIds,
    buildOrchestrationContext,
    profileStageController,
    profileStageGuardMax,
  } = input;
  let profileStageGuardFired = input.profileStageGuardFired;
  const unobservedChildIds = [...spawnedChildIds]
    .filter((id) => !waitedChildIds.has(id));

  if (unobservedChildIds.length > 0 && !agent.interruptRequested) {
    const timeoutMs = Math.max(1, getCliKnobs().childDrainTimeoutMs);
    const waitName = 'wait_agents';
    const waitArgs = { ids: unobservedChildIds, timeoutMs };

    callbacks.onStatusUpdate(
      `Auto-draining ${unobservedChildIds.length} spawned child agent${unobservedChildIds.length === 1 ? '' : 's'}...`,
    );
    callbacks.onToolStart(waitName, waitArgs);
    agent.lastTurnToolCalls += 1;

    let resultText = '';
    let failed = false;
    let summary = '';
    try {
      resultText = await executeOrchestrationTool(
        waitName,
        waitArgs,
        buildOrchestrationContext(),
      );
      summary = getToolSummary(waitName, waitArgs, resultText);
      trackChildObservation(
        waitName,
        waitArgs,
        resultText,
        spawnedChildIds,
        waitedChildIds,
      );
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      resultText = `Tool execution failed: ${message}`;
      summary = message;
    }

    callbacks.onToolEnd(waitName, {
      success: !failed,
      summary,
      preview: failed
        ? undefined
        : getToolPreview(waitName, waitArgs, resultText),
    });

    const timeouts = parseChildDrainTimeouts(resultText);
    if (timeouts.length > 0) {
      agent.lastTurnPendingChildIds = timeouts
        .map((timeout) => timeout.id)
        .filter((id) => id && id !== '(unknown)');
      return {
        action: 'finish',
        answer: formatChildDrainTimeoutAnswer(timeouts),
        profileStageGuardFired,
        childOutputDelivered: false,
      };
    }

    const childResultSystem = summarizeWaitedChildOutputs(resultText);
    if (childResultSystem) {
      const systemMessage = { role: 'system', content: childResultSystem };
      agent.chatHistory.push(systemMessage);
      agent.recordTranscript(systemMessage);
    }
    const guardMessage = {
      role: 'user',
      content: [
        `Runtime child-drain guardrail auto-called \`${waitName}\` because this turn spawned child agents and the model tried to answer without observing them.`,
        `Child wait result:\n${resultText}`,
        'Now synthesize the child output for the user. Do not say you are waiting unless the wait result timed out.',
      ].join('\n\n'),
    };
    agent.chatHistory.push(guardMessage);
    agent.recordTranscript({ ...guardMessage, name: 'guard' });
    return {
      action: 'continue',
      profileStageGuardFired,
      childOutputDelivered: Boolean(childResultSystem),
    };
  }

  const failedStage = profileStageController?.failedRequiredStage();
  if (failedStage) {
    return {
      action: 'finish',
      answer:
        `The active profile strategy failed required stage "${failedStage.stageId}"` +
        `${failedStage.roleId ? ` for role "${failedStage.roleId}"` : ''}. ` +
        'Its dependent stages were not unlocked. Review the stage tool result before retrying the task.',
      profileStageGuardFired,
      childOutputDelivered: false,
    };
  }

  const requiredPrimaryStage = profileStageController?.nextRequiredAction();
  if (requiredPrimaryStage) {
    if (profileStageGuardFired < profileStageGuardMax) {
      profileStageGuardFired += 1;
      return continueWithGuard(
        agent,
        callbacks,
        buildRequiredProfileStageCorrection(requiredPrimaryStage),
        `Recovery: required profile stage ${requiredPrimaryStage.stageId}/${requiredPrimaryStage.skillId} ` +
          `(${profileStageGuardFired}/${profileStageGuardMax})`,
        profileStageGuardFired,
      );
    }
    return {
      action: 'finish',
      answer:
        `The active profile strategy could not finish required stage "${requiredPrimaryStage.stageId}" ` +
        `because skill "${requiredPrimaryStage.skillId}" was not ${requiredPrimaryStage.action === 'begin' ? 'started' : 'completed'} ` +
        'within the bounded runtime guard. No broader tool authority was granted.',
      profileStageGuardFired,
      childOutputDelivered: false,
    };
  }

  const requiredDelegatedStage = profileStageController?.nextRequiredDelegation();
  if (requiredDelegatedStage) {
    if (profileStageGuardFired < profileStageGuardMax) {
      profileStageGuardFired += 1;
      return continueWithGuard(
        agent,
        callbacks,
        buildRequiredDelegatedStageCorrection(requiredDelegatedStage),
        `Recovery: required delegated stage ${requiredDelegatedStage.stageId}/${requiredDelegatedStage.roleId} ` +
          `(${profileStageGuardFired}/${profileStageGuardMax})`,
        profileStageGuardFired,
      );
    }
    return {
      action: 'finish',
      answer:
        'The active profile strategy could not launch required delegated stage ' +
        `"${requiredDelegatedStage.stageId}" with role "${requiredDelegatedStage.roleId}" ` +
        'within the bounded runtime guard. No child was launched outside the compiled plan.',
      profileStageGuardFired,
      childOutputDelivered: false,
    };
  }

  return {
    action: 'none',
    profileStageGuardFired,
    childOutputDelivered: false,
  };
}
