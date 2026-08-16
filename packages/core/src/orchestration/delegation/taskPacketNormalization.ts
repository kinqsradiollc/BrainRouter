/**
 * Untrusted task-packet normalization.
 *
 * Every transported packet is rebuilt through Core's bounded builder. Legacy
 * rows become read-only, capability-empty, and tool-free instead of inheriting
 * authority from whichever host eventually claims them.
 */

import type {
  DelegatedTaskPacket,
  LegacyDelegationPacket,
} from '@kinqs/brainrouter-types/agent';
import { buildDelegatedTaskPacket } from './taskPacket.js';

const DEFAULT_BUDGETS: DelegatedTaskPacket['budgets'] = {
  maxWallClockMs: 1_800_000,
  maxPromptTokens: 100_000,
  maxCompletionTokens: 16_000,
  maxIterations: 250,
  maxDepth: 3,
  maxOutputChars: 24_000,
};

/**
 * Normalize a packet received across a host boundary without trusting its
 * claimed persona, orchestration, capabilities, tools, or resource budgets.
 *
 * The transport currently authenticates the owning user and sender session,
 * but it does not carry a server-resolved authority profile. Until it does,
 * cross-host execution is intentionally limited to a read-only, tool-free
 * worker packet. Task scope and evidence references remain available.
 */
export function normalizeUntrustedCrossHostTaskPacket(
  input: DelegatedTaskPacket,
): DelegatedTaskPacket {
  const packet = normalizeDelegatedTaskPacket(input);
  return {
    ...packet,
    persona: { id: 'custom' },
    orchestration: { roleId: 'worker' },
    capabilities: {
      active: [],
      reasons: ['cross-host handoff has no implicit capabilities'],
      skillPacks: [],
      skills: [],
      toolProfiles: [],
    },
    toolPolicyCeiling: {
      accessMode: 'read',
      localTools: [],
      mcpTools: [],
      disallowedTools: packet.toolPolicyCeiling.disallowedTools,
    },
    budgets: capBudgets(packet.budgets, DEFAULT_BUDGETS),
  };
}

export function isDelegatedTaskPacket(
  value: unknown,
): value is DelegatedTaskPacket {
  const candidate = record(value);
  return candidate?.schemaVersion === 1
    && typeof candidate.task === 'string'
    && record(candidate.persona) !== undefined
    && record(candidate.orchestration) !== undefined
    && record(candidate.capabilities) !== undefined
    && record(candidate.toolPolicyCeiling) !== undefined
    && record(candidate.budgets) !== undefined;
}

export function normalizeDelegatedTaskPacket(
  input: DelegatedTaskPacket,
): DelegatedTaskPacket {
  const packet = buildDelegatedTaskPacket({
    task: input.task,
    personaId: input.persona?.id,
    roleId: input.orchestration?.roleId,
    capabilities: {
      active: strings(input.capabilities?.active),
      reasons: strings(input.capabilities?.reasons),
      skillPacks: strings(input.capabilities?.skillPacks),
      skills: strings(input.capabilities?.skills),
      toolProfiles: strings(input.capabilities?.toolProfiles),
      promptBlocks: [],
    },
    accessMode: accessMode(input.toolPolicyCeiling?.accessMode),
    expectedOutput: {
      contractId: text(input.expectedOutput?.contractId) || null,
      description: text(input.expectedOutput?.description),
      requiredSections: strings(input.expectedOutput?.requiredSections),
    },
    goal: input.userConstraints?.goal?.text
      ? {
          text: input.userConstraints.goal.text,
          status: text(input.userConstraints.goal.status) || 'active',
        }
      : null,
    ownership: input.userConstraints?.ownership,
    workspaceInstructionsHash: text(input.userConstraints?.workspaceInstructionsHash),
    executionMode: text(input.userConstraints?.executionMode),
    reviewPolicy: text(input.userConstraints?.reviewPolicy),
    constraints: strings(input.userConstraints?.constraints),
    deadline: text(input.userConstraints?.deadline),
    planState: text(input.planState),
    recalledRecordIds: strings(input.memoryBriefing?.recordIds),
    memoryExcerpt: text(input.memoryBriefing?.excerpt),
    sourceFiles: strings(input.sources?.files),
    localTools: strings(input.toolPolicyCeiling?.localTools),
    mcpTools: strings(input.toolPolicyCeiling?.mcpTools),
    disallowedTools: strings(input.toolPolicyCeiling?.disallowedTools),
    budgets: normalizeBudgetInput(input.budgets),
  });
  const orchestration = input.orchestration;
  const workspaceProfileId = normalizedIdentifier(
    orchestration?.workspaceProfileId,
  );
  const planProfileId = Object.prototype.hasOwnProperty.call(
    orchestration ?? {},
    'planProfileId',
  )
    ? normalizedIdentifier(orchestration?.planProfileId)
    : normalizedIdentifier(orchestration?.profileId);
  packet.orchestration = {
    ...packet.orchestration,
    ...(workspaceProfileId ? { workspaceProfileId } : {}),
    ...(planProfileId ? { planProfileId, profileId: planProfileId } : {}),
    ...optionalIdentifier('strategyId', input.orchestration?.strategyId),
    ...optionalIdentifier('stageId', input.orchestration?.stageId),
    ...(input.orchestration?.skillIds?.length
      ? { skillIds: strings(input.orchestration.skillIds).slice(0, 80) }
      : {}),
    ...(text(input.orchestration?.assignment)
      ? { assignment: bounded(text(input.orchestration.assignment), 4_000) }
      : {}),
  };
  packet.contextLayers = (input.contextLayers ?? [])
    .filter((layer) => layer && typeof layer.kind === 'string')
    .map((layer) => ({
      kind: bounded(layer.kind, 80),
      reference: bounded(text(layer.reference), 500),
      protected: layer.protected === true,
    }))
    .filter((layer) => layer.reference)
    .slice(0, 40);
  return packet;
}

export function legacyDelegatedTaskPacket(
  payload: Record<string, unknown>,
): DelegatedTaskPacket {
  const budget = record(payload.budget);
  const legacyPromptTokens = positiveInteger(budget?.tokens);
  return buildDelegatedTaskPacket({
    task: text(payload.goal),
    personaId: 'custom',
    roleId: 'worker',
    capabilities: {
      active: [],
      reasons: ['legacy cross-host handoff normalized without implicit capabilities'],
      skillPacks: [],
      skills: [],
      toolProfiles: [],
      promptBlocks: [],
    },
    accessMode: 'read',
    constraints: [
      ...strings(payload.constraints),
      ...(text(payload.note) ? [text(payload.note)] : []),
    ],
    deadline: text(payload.deadline),
    sourceFiles: strings(payload.files),
    localTools: [],
    mcpTools: [],
    disallowedTools: [],
    budgets: {
      ...DEFAULT_BUDGETS,
      ...(legacyPromptTokens
        ? { maxPromptTokens: legacyPromptTokens }
        : {}),
    },
  });
}

export function legacyDelegationPayload(
  packet: LegacyDelegationPacket,
): Record<string, unknown> {
  return {
    goal: packet.goal,
    files: packet.files,
    constraints: packet.constraints,
    modelHints: packet.modelHints,
    budget: packet.budget,
    deadline: packet.deadline,
    note: packet.note,
    originatingClient: packet.originatingClient,
    originatingWorkspace: packet.originatingWorkspace,
  };
}

function normalizeBudgetInput(
  budgets: DelegatedTaskPacket['budgets'] | undefined,
): DelegatedTaskPacket['budgets'] {
  return {
    maxWallClockMs: positiveInteger(budgets?.maxWallClockMs) ?? DEFAULT_BUDGETS.maxWallClockMs,
    maxPromptTokens: positiveInteger(budgets?.maxPromptTokens) ?? DEFAULT_BUDGETS.maxPromptTokens,
    maxCompletionTokens: positiveInteger(budgets?.maxCompletionTokens) ?? DEFAULT_BUDGETS.maxCompletionTokens,
    maxIterations: positiveInteger(budgets?.maxIterations) ?? DEFAULT_BUDGETS.maxIterations,
    maxDepth: positiveInteger(budgets?.maxDepth) ?? DEFAULT_BUDGETS.maxDepth,
    maxOutputChars: positiveInteger(budgets?.maxOutputChars) ?? DEFAULT_BUDGETS.maxOutputChars,
  };
}

function capBudgets(
  budgets: DelegatedTaskPacket['budgets'],
  ceiling: DelegatedTaskPacket['budgets'],
): DelegatedTaskPacket['budgets'] {
  return {
    maxWallClockMs: Math.min(budgets.maxWallClockMs, ceiling.maxWallClockMs),
    maxPromptTokens: Math.min(budgets.maxPromptTokens, ceiling.maxPromptTokens),
    maxCompletionTokens: Math.min(
      budgets.maxCompletionTokens,
      ceiling.maxCompletionTokens,
    ),
    maxIterations: Math.min(budgets.maxIterations, ceiling.maxIterations),
    maxDepth: Math.min(budgets.maxDepth, ceiling.maxDepth),
    maxOutputChars: Math.min(budgets.maxOutputChars, ceiling.maxOutputChars),
  };
}

function optionalIdentifier(
  key: 'strategyId' | 'stageId',
  value: unknown,
): Partial<DelegatedTaskPacket['orchestration']> {
  const normalized = normalizedIdentifier(value);
  return normalized ? { [key]: normalized } : {};
}

function normalizedIdentifier(value: unknown): string | undefined {
  const normalized = text(value).trim();
  return normalized.length <= 128
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)
    ? normalized
    : undefined;
}

function accessMode(value: unknown): DelegatedTaskPacket['toolPolicyCeiling']['accessMode'] {
  return value === 'write' || value === 'shell' ? value : 'read';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function bounded(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, Math.max(0, max - 1))}…`;
}
