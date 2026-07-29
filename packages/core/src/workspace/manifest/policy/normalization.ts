/**
 * Pure workspace-manifest normalization and serialization policy.
 *
 * A25-5d2: owns profile-default resolution, compatibility translation, safe
 * normalization, and bounded serialization without reading or writing a
 * workspace. Trusted storage and recovery composition remain outside.
 *
 * Contract:
 * - Bad field shapes normalize to safe defaults.
 * - Unknown top-level fields and capability ids
 *   are PRESERVED on round-trip when safe (forward compatibility with newer
 *   writers) within deterministic size/traversal bounds; obvious secrets,
 *   tenancy ids, and local absolute paths are discarded.
 * - Every normalized draft serializes within the manifest byte cap.
 * - Never holds secrets. Committable by design.
 */
import {
  isWorkspaceProfileId,
  type WorkspaceProfileId,
} from '../../profiles.js';
import { RESERVED_ORCHESTRATION_ROLE_IDS } from '../../personaDefinitionFile.js';
import {
  WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION,
  WORKSPACE_MANIFEST_MAX_BYTES,
  WORKSPACE_MANIFEST_VERSION,
  type WorkspaceManifest,
  type WorkspaceOrchestrationMode,
} from '../contracts.js';
import {
  appendRequiredString,
  asRecord,
  boundedInputString,
  boundedInteger,
  collectExtraEntries,
  createNormalizationBudget,
  safeInstructionPointer,
  safeKnownString,
  safeStringArray,
  uniqueStrings,
} from './valueSafety.js';

/** Return the exact normalized bytes persisted by `saveWorkspaceManifest`. */
export function serializeWorkspaceManifest(manifest: WorkspaceManifest): string {
  const normalized = normalizeWorkspaceManifest(manifest);
  const { extra, ...known } = normalized;
  const serialized = `${JSON.stringify({ ...(extra ?? {}), ...known }, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > WORKSPACE_MANIFEST_MAX_BYTES) {
    throw new Error(`Workspace manifest exceeds ${WORKSPACE_MANIFEST_MAX_BYTES} bytes after normalization.`);
  }
  return serialized;
}

/** Normalize a collected draft before it is reviewed, returned, or saved. */
export function normalizeWorkspaceManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  return normalizeWorkspaceManifestRecord(
    manifest as unknown as Record<string, unknown>,
    asRecord(manifest.extra),
  );
}

export function normalizeWorkspaceManifestRecord(
  raw: Record<string, unknown>,
  explicitExtra?: Record<string, unknown>,
): WorkspaceManifest {
  const budget = createNormalizationBudget();
  const profileInput = boundedInputString(raw.profile, budget);
  const profile: WorkspaceProfileId =
    profileInput !== undefined && isWorkspaceProfileId(profileInput) ? profileInput : 'custom';
  const onboardedRaw = asRecord(raw.onboarded);
  const planningRaw = asRecord(raw.planning);
  const agentsRaw = asRecord(raw.agents);
  const personaRaw = Object.keys(asRecord(raw.persona)).length > 0
    ? asRecord(raw.persona)
    : agentsRaw;
  const rawAgentDefault = safeKnownString(personaRaw.default, '', budget);
  const rawAgentEnabled = safeStringArray(personaRaw.enabled, budget);
  const legacyFrontendPersona =
    rawAgentDefault === 'frontend-builder' || rawAgentEnabled.includes('frontend-builder');
  const agentDefault = rawAgentDefault === 'frontend-builder'
    ? 'engineer'
    : rawAgentDefault;
  const agentEnabled = appendRequiredString(
    uniqueStrings(rawAgentEnabled.map((agent) => agent === 'frontend-builder' ? 'engineer' : agent)),
    legacyFrontendPersona ? 'engineer' : undefined,
  );
  const persona = { default: agentDefault, enabled: agentEnabled };
  const orchestrationRaw = asRecord(raw.orchestration);
  const hasV2Orchestration = Object.keys(orchestrationRaw).length > 0;
  const legacyRoles = [
    ...[...RESERVED_ORCHESTRATION_ROLE_IDS].filter((id) => id !== 'primary'),
    ...agentEnabled,
  ];
  const rawAvailableRoles = hasV2Orchestration
    ? safeStringArray(orchestrationRaw.availableRoles, budget)
    : legacyRoles;
  const disabledRoles = hasV2Orchestration
    ? uniqueStrings(safeStringArray(orchestrationRaw.disabledRoles, budget))
    : [];
  const disabledRoleSet = new Set(disabledRoles);
  const availableRoles = uniqueStrings(rawAvailableRoles).filter((id) => !disabledRoleSet.has(id));
  const rawMode = boundedInputString(orchestrationRaw.mode, budget);
  const orchestrationMode: WorkspaceOrchestrationMode = hasV2Orchestration &&
    (rawMode === 'off' || rawMode === 'explicit' || rawMode === 'adaptive')
    ? rawMode
    : hasV2Orchestration ? 'off' : 'adaptive';
  const maxParallel = hasV2Orchestration
    ? boundedInteger(orchestrationRaw.maxParallel, 1, 32, 1)
    : 4;
  const capabilitiesRaw = asRecord(raw.capabilities);
  const disabledCapabilities = uniqueStrings(safeStringArray(capabilitiesRaw.disabled, budget));
  const disabledCapabilitySet = new Set(disabledCapabilities);
  const enabledCapabilities = appendRequiredString(
    uniqueStrings(safeStringArray(capabilitiesRaw.enabled, budget)),
    legacyFrontendPersona ? 'frontend' : undefined,
  ).filter((capability) => !disabledCapabilitySet.has(capability));
  const by = boundedInputString(onboardedRaw.by, budget);
  const skillsRaw = asRecord(raw.skills);
  const toolsRaw = asRecord(raw.tools);
  const memoryRaw = asRecord(raw.memory);
  const name = safeKnownString(raw.name, 'workspace', budget);
  const onboardedAt = safeKnownString(onboardedRaw.at, '', budget);
  const skillPacks = safeStringArray(skillsRaw.packs, budget);
  const enabledSkills = safeStringArray(skillsRaw.enabled, budget);
  const disabledSkills = safeStringArray(skillsRaw.disabled, budget);
  const toolProfiles = safeStringArray(toolsRaw.profiles, budget);
  const enabledTools = safeStringArray(toolsRaw.enabled, budget);
  const deniedTools = safeStringArray(toolsRaw.deny, budget);
  const version = raw.version === WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION
    ? WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION
    : WORKSPACE_MANIFEST_VERSION;
  const memoryTags = safeStringArray(memoryRaw.tags, budget);
  const memoryCaptureHint = safeKnownString(memoryRaw.captureHint, '', budget);
  const instructions = safeInstructionPointer(raw.instructions, budget);
  const planningSchemaId = safeKnownString(planningRaw.schemaId, '', budget);
  const extra: Record<string, unknown> = {};
  const extraState = { inspected: 0 };
  if (explicitExtra !== undefined) collectExtraEntries(explicitExtra, extra, budget, extraState);
  collectExtraEntries(raw, extra, budget, extraState, explicitExtra !== undefined);
  const normalized: WorkspaceManifest = {
    version,
    name,
    profile,
    ...(planningSchemaId ? { planning: { schemaId: planningSchemaId } } : {}),
    onboarded: {
      at: onboardedAt,
      by: by === 'wizard' || by === 'agent' || by === 'import' ? by : 'import',
    },
    persona,
    orchestration: {
      mode: orchestrationMode,
      availableRoles,
      disabledRoles,
      maxParallel,
    },
    agents: persona,
    capabilities: { enabled: enabledCapabilities, disabled: disabledCapabilities },
    skills: {
      packs: skillPacks,
      enabled: enabledSkills,
      disabled: disabledSkills,
    },
    tools: {
      ...(version === WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION
        ? { mode: 'explicit-catalog' as const, enabled: enabledTools }
        : {}),
      profiles: toolProfiles,
      deny: deniedTools,
    },
    memory: {
      tags: memoryTags,
      captureHint: memoryCaptureHint,
    },
    instructions,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
  return fitManifestToSerializedLimit(normalized);
}

/**
 * Keep the highest-priority known fields, then the longest fitting prefix of
 * forward-compatible extras. If known collections alone exceed the file cap,
 * lower-priority collections are deterministically trimmed from the end.
 */
function fitManifestToSerializedLimit(manifest: WorkspaceManifest): WorkspaceManifest {
  if (serializedManifestBytes(manifest) <= WORKSPACE_MANIFEST_MAX_BYTES) return manifest;

  const extraEntries = Object.entries(manifest.extra ?? {});
  delete manifest.extra;
  if (serializedManifestBytes(manifest) <= WORKSPACE_MANIFEST_MAX_BYTES) {
    let low = 0;
    let high = extraEntries.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      manifest.extra = Object.fromEntries(extraEntries.slice(0, middle));
      if (serializedManifestBytes(manifest) <= WORKSPACE_MANIFEST_MAX_BYTES) low = middle;
      else high = middle - 1;
    }
    if (low > 0) manifest.extra = Object.fromEntries(extraEntries.slice(0, low));
    else delete manifest.extra;
    return manifest;
  }

  const collections: Array<{ values: string[]; assign(values: string[]): void }> = [
    { values: manifest.memory.tags, assign: (values) => { manifest.memory.tags = values; } },
    { values: manifest.skills.enabled, assign: (values) => { manifest.skills.enabled = values; } },
    { values: manifest.skills.packs, assign: (values) => { manifest.skills.packs = values; } },
    { values: manifest.tools.enabled ?? [], assign: (values) => {
      if (manifest.version === WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION) {
        manifest.tools.enabled = values;
      }
    } },
    { values: manifest.tools.profiles, assign: (values) => { manifest.tools.profiles = values; } },
    { values: manifest.capabilities.enabled, assign: (values) => { manifest.capabilities.enabled = values; } },
    { values: manifest.persona.enabled, assign: (values) => {
      manifest.persona.enabled = values;
      manifest.agents.enabled = values;
    } },
    { values: manifest.orchestration.availableRoles, assign: (values) => {
      manifest.orchestration.availableRoles = values;
    } },
    { values: manifest.orchestration.disabledRoles, assign: (values) => {
      manifest.orchestration.disabledRoles = values;
    } },
    { values: manifest.skills.disabled, assign: (values) => { manifest.skills.disabled = values; } },
    { values: manifest.capabilities.disabled, assign: (values) => { manifest.capabilities.disabled = values; } },
    { values: manifest.tools.deny, assign: (values) => { manifest.tools.deny = values; } },
  ];

  for (const collection of collections) {
    collection.assign([]);
    if (serializedManifestBytes(manifest) > WORKSPACE_MANIFEST_MAX_BYTES) continue;
    let low = 0;
    let high = collection.values.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      collection.assign(collection.values.slice(0, middle));
      if (serializedManifestBytes(manifest) <= WORKSPACE_MANIFEST_MAX_BYTES) low = middle;
      else high = middle - 1;
    }
    collection.assign(collection.values.slice(0, low));
    return manifest;
  }

  // Bounded scalar fields cannot reach the file cap, but retain a fail-closed
  // fallback if future schema additions invalidate that invariant.
  return {
    version: manifest.version,
    name: 'workspace',
    profile: manifest.profile,
    onboarded: { at: '', by: manifest.onboarded.by },
    persona: { default: '', enabled: [] },
    orchestration: { mode: 'off', availableRoles: [], disabledRoles: [], maxParallel: 1 },
    agents: { default: '', enabled: [] },
    capabilities: { enabled: [], disabled: [] },
    skills: { packs: [], enabled: [], disabled: [] },
    tools: manifest.version === WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION
      ? { mode: 'explicit-catalog', profiles: [], enabled: [], deny: [] }
      : { profiles: [], deny: [] },
    memory: { tags: [], captureHint: '' },
    instructions: 'AGENT.md',
  };
}

function serializedManifestBytes(manifest: WorkspaceManifest): number {
  const { extra, ...known } = manifest;
  return Buffer.byteLength(`${JSON.stringify({ ...(extra ?? {}), ...known }, null, 2)}\n`);
}
