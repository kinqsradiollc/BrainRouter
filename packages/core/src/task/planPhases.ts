/**
 * Phase reconciliation and transition validation for the durable plan store.
 *
 * Persistence stays in taskStore; this module owns phase identity, ordered
 * step membership, compatibility projection, and fail-closed transition
 * invariants. It has no filesystem or Agent dependency.
 */
import crypto from 'node:crypto';
import type {
  PlanPhaseInput,
  PlanPhaseStatus,
  StoredPlanPhase,
  StoredPlanStep,
} from '@kinqs/brainrouter-types/planning';

const PHASE_ID_PATTERN = /^phase_[a-z0-9_-]{8,80}$/i;
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PHASES = 64;
const MAX_STEPS_PER_PHASE = 128;

export function reconcilePlanPhases(input: {
  phases: PlanPhaseInput[];
  current: readonly StoredPlanPhase[];
  currentItems: readonly StoredPlanStep[];
  reconciledItems: readonly StoredPlanStep[];
}): StoredPlanPhase[] {
  if (!Array.isArray(input.phases) || input.phases.length === 0) {
    throw new Error('phases must contain at least one executable phase.');
  }
  if (input.phases.length > MAX_PHASES) {
    throw new Error(`phases cannot contain more than ${MAX_PHASES} entries.`);
  }

  const phaseIds = assignPhaseIds(input.phases, input.current);
  let itemOffset = 0;
  const phases = input.phases.map((phase, index): StoredPlanPhase => {
    const title = typeof phase.title === 'string' ? phase.title.trim() : '';
    if (!title) throw new Error(`Phase ${index + 1} is missing a non-empty title.`);
    if (!isPlanPhaseStatus(phase.status)) {
      throw new Error(
        `Phase ${index + 1} has invalid status "${String(phase.status)}".`,
      );
    }
    if (!Array.isArray(phase.steps) || phase.steps.length === 0) {
      throw new Error(`Phase "${title}" must contain at least one step.`);
    }
    if (phase.steps.length > MAX_STEPS_PER_PHASE) {
      throw new Error(
        `Phase "${title}" cannot contain more than ${MAX_STEPS_PER_PHASE} steps.`,
      );
    }
    const stepIds = input.reconciledItems
      .slice(itemOffset, itemOffset + phase.steps.length)
      .map((step) => step.id);
    itemOffset += phase.steps.length;
    const requiredSkillIds = uniqueStrings(
      phase.requiredSkillIds,
      SKILL_ID_PATTERN,
      `Phase "${title}" requiredSkillIds`,
    );
    const dependsOn = phase.dependsOn === undefined && index > 0
      ? [phaseIds[index - 1]]
      : uniqueStrings(
        phase.dependsOn,
        PHASE_ID_PATTERN,
        `Phase "${title}" dependsOn`,
      );
    const blockedReason =
      typeof phase.blockedReason === 'string' && phase.blockedReason.trim()
        ? phase.blockedReason.trim().slice(0, 2_000)
        : undefined;
    return {
      id: phaseIds[index],
      title,
      status: phase.status,
      dependsOn,
      requiredSkillIds,
      stepIds,
      ...(blockedReason ? { blockedReason } : {}),
    };
  });

  assertCompletedPhasesImmutable({
    currentPhases: input.current,
    currentItems: input.currentItems,
    nextPhases: phases,
    nextItems: input.reconciledItems,
  });
  validatePhaseTransitions(phases, input.reconciledItems);
  return phases;
}

/**
 * Activate the first ready phase and its first pending step when a plan update
 * leaves no active work. This makes phase-to-phase progression host-owned
 * while preserving a blocked phase and every explicit dependency.
 */
export function advancePlanProgress(input: {
  phases: readonly StoredPlanPhase[];
  items: readonly StoredPlanStep[];
}): { phases: StoredPlanPhase[]; items: StoredPlanStep[] } {
  const phases = input.phases.map((phase) => ({
    ...phase,
    dependsOn: [...phase.dependsOn],
    requiredSkillIds: [...phase.requiredSkillIds],
    stepIds: [...phase.stepIds],
  }));
  const items = input.items.map((item) => ({
    ...item,
    ...(item.evidence ? { evidence: [...item.evidence] } : {}),
  }));
  if (
    phases.some((phase) => phase.status === 'in_progress') ||
    phases.some((phase) => phase.status === 'blocked')
  ) {
    return { phases, items };
  }

  const itemsById = new Map(items.map((item) => [item.id, item]));
  const terminal = (phase: StoredPlanPhase): boolean =>
    phase.status === 'completed' || phase.status === 'skipped';

  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    if (phase.status !== 'pending') continue;
    if (phases.slice(0, index).some((candidate) => !terminal(candidate))) break;
    if (phase.dependsOn.some((id) => {
      const dependency = phases.find((candidate) => candidate.id === id);
      return !dependency || !terminal(dependency);
    })) continue;

    const phaseItems = phase.stepIds.flatMap((id) => {
      const item = itemsById.get(id);
      return item ? [item] : [];
    });
    const nextStep = phaseItems.find((item) => item.status === 'pending');
    if (!nextStep) {
      if (phaseItems.every((item) => item.status === 'completed')) {
        phases[index] = { ...phase, status: 'completed' };
        continue;
      }
      break;
    }
    nextStep.status = 'in_progress';
    phases[index] = { ...phase, status: 'in_progress', blockedReason: undefined };
    break;
  }

  validatePhaseTransitions(phases, items);
  return { phases, items };
}

export function compatibilityPlanPhases(input: {
  items: readonly StoredPlanStep[];
  current: readonly StoredPlanPhase[];
  title?: string;
}): StoredPlanPhase[] {
  if (input.items.length === 0) return [];
  const itemsById = new Map(input.items.map((item) => [item.id, item]));
  const retained = input.current.map((phase): StoredPlanPhase => {
    const stepIds = phase.stepIds.filter((id) => itemsById.has(id));
    return {
      ...phase,
      stepIds,
      status: statusForSteps(stepIds.map((id) => itemsById.get(id)!)),
      blockedReason: undefined,
    };
  }).filter((phase) => phase.stepIds.length > 0);
  const claimed = new Set(retained.flatMap((phase) => phase.stepIds));
  const unclaimed = input.items.filter((item) => !claimed.has(item.id));
  if (retained.length > 0) {
    if (unclaimed.length > 0) {
      const targetIndex = Math.max(
        0,
        retained.findIndex((phase) => phase.status === 'in_progress'),
      );
      retained[targetIndex] = {
        ...retained[targetIndex],
        stepIds: [
          ...retained[targetIndex].stepIds,
          ...unclaimed.map((item) => item.id),
        ],
      };
      retained[targetIndex].status = statusForSteps(
        retained[targetIndex].stepIds.map((id) => itemsById.get(id)!),
      );
    }
    return normalizeSequentialDependencies(retained);
  }

  return [{
    id: createPhaseId(),
    title: input.title?.trim().slice(0, 200) || 'Execution',
    status: statusForSteps(input.items),
    dependsOn: [],
    requiredSkillIds: [],
    stepIds: input.items.map((item) => item.id),
  }];
}

export function normalizeStoredPlanPhases(
  value: unknown,
  items: readonly StoredPlanStep[],
): StoredPlanPhase[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PHASES) {
    return undefined;
  }
  try {
    const phases = value.map((candidate, index): StoredPlanPhase => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error(`Stored phase ${index + 1} must be an object.`);
      }
      const phase = candidate as Partial<StoredPlanPhase>;
      if (typeof phase.id !== 'string' || !PHASE_ID_PATTERN.test(phase.id)) {
        throw new Error(`Stored phase ${index + 1} has an invalid id.`);
      }
      const title = typeof phase.title === 'string' ? phase.title.trim() : '';
      if (!title || !isPlanPhaseStatus(phase.status)) {
        throw new Error(`Stored phase ${index + 1} is invalid.`);
      }
      const blockedReason =
        typeof phase.blockedReason === 'string' && phase.blockedReason.trim()
          ? phase.blockedReason.trim().slice(0, 2_000)
          : undefined;
      return {
        id: phase.id,
        title,
        status: phase.status,
        dependsOn: uniqueStrings(
          phase.dependsOn,
          PHASE_ID_PATTERN,
          `Stored phase "${title}" dependsOn`,
        ),
        requiredSkillIds: uniqueStrings(
          phase.requiredSkillIds,
          SKILL_ID_PATTERN,
          `Stored phase "${title}" requiredSkillIds`,
        ),
        stepIds: uniqueStrings(
          phase.stepIds,
          /^task_[a-z0-9_-]{8,80}$/i,
          `Stored phase "${title}" stepIds`,
        ),
        ...(blockedReason ? { blockedReason } : {}),
      };
    });
    validatePhaseTransitions(phases, items);
    return phases;
  } catch {
    return undefined;
  }
}

export function validatePhaseTransitions(
  phases: readonly StoredPlanPhase[],
  items: readonly StoredPlanStep[],
): void {
  const phaseIds = new Set(phases.map((phase) => phase.id));
  if (phaseIds.size !== phases.length) {
    throw new Error('Plan phase ids must be unique.');
  }
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const claimed = new Set<string>();
  let activePhases = 0;

  for (const [index, phase] of phases.entries()) {
    for (const dependencyId of phase.dependsOn) {
      if (!phaseIds.has(dependencyId) || dependencyId === phase.id) {
        throw new Error(
          `Phase "${phase.title}" has invalid dependency "${dependencyId}".`,
        );
      }
    }
    const steps = phase.stepIds.map((stepId) => {
      const step = itemsById.get(stepId);
      if (!step) {
        throw new Error(
          `Phase "${phase.title}" references unknown step "${stepId}".`,
        );
      }
      if (claimed.has(stepId)) {
        throw new Error(`Step "${stepId}" belongs to more than one phase.`);
      }
      claimed.add(stepId);
      return step;
    });
    if (steps.length === 0) {
      throw new Error(`Phase "${phase.title}" must contain at least one step.`);
    }
    const activeSteps = steps.filter((step) => step.status === 'in_progress');
    if (phase.status === 'in_progress') {
      activePhases += 1;
      if (activeSteps.length !== 1) {
        throw new Error(
          `In-progress phase "${phase.title}" must have exactly one in-progress step.`,
        );
      }
      const unresolvedDependency = phase.dependsOn.find((dependencyId) => {
        const dependency = phases.find((candidate) =>
          candidate.id === dependencyId);
        return dependency?.status !== 'completed' &&
          dependency?.status !== 'skipped';
      });
      if (unresolvedDependency) {
        throw new Error(
          `Phase "${phase.title}" cannot start before dependency "${unresolvedDependency}" completes.`,
        );
      }
    } else if (activeSteps.length > 0) {
      throw new Error(
        `Phase "${phase.title}" contains an in-progress step but is "${phase.status}".`,
      );
    }
    if (
      phase.status === 'completed' &&
      steps.some((step) => step.status !== 'completed')
    ) {
      throw new Error(
        `Completed phase "${phase.title}" still has incomplete steps.`,
      );
    }
    if (phase.status === 'blocked' && !phase.blockedReason) {
      throw new Error(`Blocked phase "${phase.title}" requires blockedReason.`);
    }
    if (
      phase.status === 'in_progress' &&
      phases.slice(0, index).some((candidate) =>
        candidate.status !== 'completed' && candidate.status !== 'skipped')
    ) {
      throw new Error(
        `Phase "${phase.title}" cannot start before earlier phases complete.`,
      );
    }
  }
  if (activePhases > 1) {
    throw new Error('At most one plan phase can be in_progress.');
  }
  if (claimed.size !== items.length) {
    throw new Error('Every plan step must belong to exactly one phase.');
  }
}

export function currentPlanProgress(
  phases: readonly StoredPlanPhase[],
  items: readonly StoredPlanStep[],
): {
  phase?: StoredPlanPhase;
  step?: StoredPlanStep;
  stepIndex?: number;
  stepCount?: number;
} {
  const phase = phases.find((candidate) => candidate.status === 'in_progress');
  if (!phase) return {};
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const steps = phase.stepIds.flatMap((id) => {
    const step = itemsById.get(id);
    return step ? [step] : [];
  });
  const stepIndex = steps.findIndex((step) => step.status === 'in_progress');
  return {
    phase,
    ...(stepIndex >= 0
      ? {
          step: steps[stepIndex],
          stepIndex: stepIndex + 1,
          stepCount: steps.length,
        }
      : {}),
  };
}

export function planExecutionBlockReason(
  phases: readonly StoredPlanPhase[],
  items: readonly StoredPlanStep[],
): string | undefined {
  if (phases.length === 0 || items.length === 0) {
    return 'create a phase-aware plan with one in-progress phase and step before mutating';
  }
  const blocked = phases.find((phase) => phase.status === 'blocked');
  if (blocked) {
    return `phase "${blocked.title}" is blocked: ${blocked.blockedReason ?? 'prerequisite unavailable'}`;
  }
  const progress = currentPlanProgress(phases, items);
  if (!progress.phase || !progress.step) {
    return phases.every((phase) =>
      phase.status === 'completed' || phase.status === 'skipped')
      ? 'all phases are terminal; revise the plan with the next required phase before mutating'
      : 'set exactly one ready phase and one bounded step to in_progress before mutating';
  }
  return undefined;
}

function assertCompletedPhasesImmutable(input: {
  currentPhases: readonly StoredPlanPhase[];
  currentItems: readonly StoredPlanStep[];
  nextPhases: readonly StoredPlanPhase[];
  nextItems: readonly StoredPlanStep[];
}): void {
  const currentItems = new Map(input.currentItems.map((item) => [item.id, item]));
  const nextItems = new Map(input.nextItems.map((item) => [item.id, item]));
  for (const current of input.currentPhases) {
    if (current.status !== 'completed') continue;
    const next = input.nextPhases.find((phase) => phase.id === current.id);
    const samePhase =
      next?.status === 'completed' &&
      next.title === current.title &&
      JSON.stringify(next.stepIds) === JSON.stringify(current.stepIds);
    const sameSteps = current.stepIds.every((id) => {
      const before = currentItems.get(id);
      const after = nextItems.get(id);
      return before !== undefined && after !== undefined &&
        before.status === 'completed' &&
        after.status === 'completed' &&
        before.step === after.step &&
        before.acceptance === after.acceptance &&
        JSON.stringify(before.evidence ?? []) === JSON.stringify(after.evidence ?? []);
    });
    if (!samePhase || !sameSteps) {
      throw new Error(
        `Completed phase "${current.title}" is immutable; append a remediation phase instead of rewriting completed work or evidence.`,
      );
    }
  }
}

function assignPhaseIds(
  phases: readonly PlanPhaseInput[],
  current: readonly StoredPlanPhase[],
): string[] {
  const used = new Set<string>();
  return phases.map((phase, index) => {
    const requested = typeof phase.id === 'string' &&
      PHASE_ID_PATTERN.test(phase.id) &&
      current.some((candidate) => candidate.id === phase.id)
        ? phase.id
        : undefined;
    const title = typeof phase.title === 'string'
      ? phase.title.trim().toLowerCase()
      : '';
    const titleMatch = current.find((candidate) =>
      !used.has(candidate.id) &&
      candidate.title.trim().toLowerCase() === title);
    const positional = current[index];
    const id = requested && !used.has(requested)
      ? requested
      : titleMatch?.id
        ?? (positional && !used.has(positional.id)
          ? positional.id
          : createPhaseId());
    used.add(id);
    return id;
  });
}

function normalizeSequentialDependencies(
  phases: readonly StoredPlanPhase[],
): StoredPlanPhase[] {
  return phases.map((phase, index) => ({
    ...phase,
    dependsOn: index === 0 ? [] : [phases[index - 1].id],
  }));
}

function statusForSteps(
  steps: readonly StoredPlanStep[],
): PlanPhaseStatus {
  if (steps.every((step) => step.status === 'completed')) return 'completed';
  if (steps.some((step) => step.status === 'in_progress')) return 'in_progress';
  return 'pending';
}

function uniqueStrings(
  value: unknown,
  pattern: RegExp,
  label: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const result: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !pattern.test(candidate)) {
      throw new Error(`${label} contains invalid id "${String(candidate)}".`);
    }
    if (!result.includes(candidate)) result.push(candidate);
  }
  return result;
}

function isPlanPhaseStatus(value: unknown): value is PlanPhaseStatus {
  return value === 'pending' ||
    value === 'in_progress' ||
    value === 'blocked' ||
    value === 'completed' ||
    value === 'skipped';
}

function createPhaseId(): string {
  return `phase_${crypto.randomUUID().replaceAll('-', '')}`;
}
