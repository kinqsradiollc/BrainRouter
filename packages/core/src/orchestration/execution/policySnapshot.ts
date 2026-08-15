/**
 * Immutable workspace-policy capture for reviewed durable execution.
 *
 * A live fingerprint detects drift and revokes the lease. This snapshot is the
 * separate execution source of truth: hooks and child policy never re-read a
 * briefly swapped workspace file between two matching fingerprint checks.
 */
import type { Hook } from '../../hooks/hooksStore.js';
import { readHooks } from '../../hooks/hooksStore.js';
import type { HookifyRule } from '../../hooks/hookifyStore.js';
import { listHookifyRules } from '../../hooks/hookifyStore.js';
import {
  listAll as listAgentDefinitions,
  type DefinitionSource,
} from '../agents/agentRegistry.js';
import type { AgentDefinition } from '../agents/agentDefinitionFile.js';
import {
  resolveDelegationPolicy,
  type DelegationPolicy,
} from '../delegation/delegationPolicy.js';
import { loadWorkspaceInstructionSummary } from '../../prompt/systemPrompt.js';
import { readPreferences } from '../../session/preferences/preferencesStore.js';
import {
  resolveActiveMode,
  resolveActivePersonality,
  type ResolvedMode,
} from '../../session/state/sessionModeStore.js';
import type { PersonalityResolution } from '../../session/preferences/personality.js';
import {
  loadWorkspaceManifest,
  type WorkspaceManifest,
} from '../../workspace/manifest.js';

export interface ReviewedExecutionRoleSnapshot {
  source: DefinitionSource;
  definition: AgentDefinition;
}

export interface ReviewedExecutionPolicySnapshot {
  manifest: WorkspaceManifest | null;
  roles: readonly ReviewedExecutionRoleSnapshot[];
  hooks: readonly Hook[];
  hookifyRules: readonly HookifyRule[];
  delegationPolicy: DelegationPolicy;
  activeMode: ResolvedMode;
  activePersonality: PersonalityResolution;
  instructionSummary: string | null;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/** Capture trusted parsed values, not file paths or lazy readers. */
export function captureReviewedExecutionPolicy(
  workspaceRoot: string,
  sessionKey: string,
): ReviewedExecutionPolicySnapshot {
  const snapshot: ReviewedExecutionPolicySnapshot = {
    manifest: loadWorkspaceManifest(workspaceRoot),
    roles: listAgentDefinitions(workspaceRoot)
      .map((loaded) => ({
        source: loaded.source,
        definition: loaded.def,
      }))
      .sort((left, right) => (
        left.definition.id < right.definition.id
          ? -1
          : left.definition.id > right.definition.id
            ? 1
            : left.source < right.source ? -1 : left.source > right.source ? 1 : 0
      )),
    hooks: readHooks(workspaceRoot),
    hookifyRules: listHookifyRules(workspaceRoot),
    delegationPolicy: resolveDelegationPolicy(readPreferences(workspaceRoot)),
    activeMode: resolveActiveMode(workspaceRoot, sessionKey),
    activePersonality: resolveActivePersonality(workspaceRoot, sessionKey),
    instructionSummary: loadWorkspaceInstructionSummary(workspaceRoot) ?? null,
  };
  return deepFreeze(structuredClone(snapshot));
}

export function reviewedExecutionRole(
  snapshot: ReviewedExecutionPolicySnapshot,
  roleId: string,
): ReviewedExecutionRoleSnapshot | undefined {
  return snapshot.roles.find((role) => role.definition.id === roleId);
}
