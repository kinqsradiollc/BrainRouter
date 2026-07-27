/**
 * The workspace manifest — `.brainrouter/workspace.json` (ADR-021 W1).
 *
 * One committable file declares what KIND of project a workspace is (profile)
 * and which persona/capabilities/orchestration/skills/tools/memory posture fit
 * it, plus the durable "onboarded" marker. This module is the SINGLE chokepoint:
 * schema, load, save, validation, and preset application — no other module
 * parses the JSON (same discipline as config.ts for CLI knobs).
 *
 * Contract:
 * - No manifest → `null` → every consumer keeps today's behavior exactly.
 * - Loading NEVER throws: unreadable/corrupt JSON → null; bad field shapes
 *   normalize to safe defaults; unknown top-level fields and capability ids
 *   are PRESERVED on round-trip when safe (forward compatibility with newer
 *   writers) within deterministic size/traversal bounds; obvious secrets,
 *   tenancy ids, and local absolute paths are discarded before the
 *   committable representation is returned or saved.
 * - Every normalized draft serializes within the loader's byte cap.
 * - Never holds secrets. Committable by design.
 */
import path from 'node:path';
import {
  WORKSPACE_PROFILES,
  getWorkspaceProfile,
  isWorkspaceProfileId,
  type WorkspaceProfileId,
} from './profiles.js';
import { resolveWorkspaceProfileOrchestrationDefaults } from './profileOrchestrationDefaults.js';
import { RESERVED_ORCHESTRATION_ROLE_IDS } from './personaDefinitionFile.js';
import { readWorkspaceFileBounded, writeWorkspaceFileAtomic } from './fileWrite.js';
import { recoverInterruptedWorkspaceManifestClaim } from './manifestClaim.js';
import { recoverInterruptedWorkspaceOnboardingPair } from './onboardingTransaction.js';
import {
  recordWorkspaceCompatibilityDiagnostics,
  type WorkspaceCompatibilityDiagnostic,
} from './compatibilityDiagnostics.js';

export const WORKSPACE_MANIFEST_VERSION = 2;
/** Reviewed catalog-backed tool selection. Existing onboarding stays on v2 until its picker ships. */
export const WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION = 3;
export const WORKSPACE_MANIFEST_RELPATH = path.join('.brainrouter', 'workspace.json');
/** Hard cap for parsing committed workspace metadata into memory. */
export const WORKSPACE_MANIFEST_MAX_BYTES = 256 * 1024;
export const WORKSPACE_MANIFEST_MAX_STRING_BYTES = 4 * 1024;
export const WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES = 256;
export const WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH = 8;
export const WORKSPACE_MANIFEST_MAX_NORMALIZATION_NODES = 4 * 1024;
const WORKSPACE_MANIFEST_MAX_PERCENT_DECODE_PASSES = 16;

export type WorkspaceOnboardSource = 'wizard' | 'agent' | 'import';
export type WorkspaceOrchestrationMode = 'off' | 'explicit' | 'adaptive';
export type WorkspaceToolSelectionMode = 'legacy-groups' | 'explicit-catalog';

export interface WorkspaceManifest {
  version: number;
  name: string;
  profile: WorkspaceProfileId;
  onboarded: { at: string; by: WorkspaceOnboardSource };
  persona: { default: string; enabled: string[] };
  orchestration: {
    mode: WorkspaceOrchestrationMode;
    availableRoles: string[];
    disabledRoles: string[];
    maxParallel: number;
  };
  /** @deprecated Serialized manifest-v1/client compatibility alias for `persona`. */
  agents: { default: string; enabled: string[] };
  capabilities: { enabled: string[]; disabled: string[] };
  skills: { packs: string[]; enabled: string[]; disabled: string[] };
  tools: {
    /** Present on v3 manifests. V2 is interpreted as `legacy-groups` without rewriting it. */
    mode?: WorkspaceToolSelectionMode;
    profiles: string[];
    /** Present on v3 manifests; stable local catalog IDs only. */
    enabled?: string[];
    deny: string[];
  };
  memory: { tags: string[]; captureHint: string };
  /** Instruction-file pointer (e.g. "AGENT.md") — a reference, never content. */
  instructions: string;
  /** Safe unknown fields from newer writers, preserved on round-trip. */
  extra?: Record<string, unknown>;
}

export interface WorkspaceManifestLoadResult {
  manifest: WorkspaceManifest | null;
  diagnostics: WorkspaceCompatibilityDiagnostic[];
}

const KNOWN_KEYS = new Set([
  'version', 'name', 'profile', 'onboarded', 'persona', 'orchestration', 'agents',
  'capabilities', 'skills', 'tools', 'memory', 'instructions',
]);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const SENSITIVE_EXTRA_KEYS = new Set([
  'secret', 'secrets', 'token', 'tokens', 'password', 'passwd', 'credential', 'credentials',
  'authorization', 'cookie', 'cookies', 'apikey', 'accesstoken', 'refreshtoken', 'privatekey',
  'sessionkey', 'userid', 'orgid', 'organizationid', 'projectid', 'workspaceid',
]);
const SENSITIVE_EXTRA_KEY_SUFFIXES = [
  'secret', 'secrets', 'token', 'tokens', 'password', 'passwords', 'credential', 'credentials',
  'apikey', 'accesstoken', 'refreshtoken', 'privatekey', 'sessionkey',
  'userid', 'userids', 'orgid', 'orgids', 'organizationid', 'organizationids',
  'projectid', 'projectids', 'workspaceid', 'workspaceids',
];
const SENSITIVE_EXTRA_KEY_WORDS = new Set([
  'secret', 'secrets', 'token', 'tokens', 'password', 'passwords', 'passwd',
  'credential', 'credentials', 'authorization', 'cookie', 'cookies', 'apikey',
]);
const SENSITIVE_EXTRA_KEY_FRAGMENTS = [
  'secret', 'password', 'passwd', 'credential', 'authorization', 'cookie', 'apikey',
  'token', 'privatekey', 'sessionkey',
];
const SAFE_SENSITIVE_METADATA_SUFFIXES = [
  'algorithm', 'algorithms', 'budget', 'budgets', 'count', 'counts', 'enabled',
  'endpoint', 'endpoints', 'expiresat', 'expiry', 'length', 'lengths', 'limit',
  'limits', 'name', 'names', 'policy', 'policies', 'required', 'status', 'ttl',
  'type', 'types', 'url', 'urls', 'uri', 'uris',
];
const SAFE_TOKEN_METADATA_KEYS = [
  /^(?:max|input|output|context|estimated|used|total|prompt|completion|cached)tokens?$/,
  /^tokens?(?:budget|count|limit|length|usage)$/,
  /^(?:de)?tokenizer(?:model|name|type|config|configuration|version)?$/,
];

/**
 * The manifest always lives at a FIXED relative path under the workspace root.
 * The root itself is the trust boundary — established by the caller (CLI
 * `findWorkspaceRoot`, desktop workspace picker), the same model as every
 * other `.brainrouter/` path helper. `path.resolve` canonicalizes it (drops
 * `..` segments, makes relative roots deterministic) so the joined path can
 * never climb OUT of the resolved root via the relpath.
 */
export function workspaceManifestPath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_MANIFEST_RELPATH);
}

/** True when the workspace has a readable manifest — the "onboarded" check. */
export function isWorkspaceOnboarded(workspaceRoot: string): boolean {
  return loadWorkspaceManifest(workspaceRoot) !== null;
}

/**
 * Load + normalize the manifest. Returns null when absent or unreadable —
 * callers treat null as "not onboarded, behave as today". Bad field shapes
 * degrade to safe defaults (an unknown profile becomes `custom`) rather than
 * failing the load: a hand-edited manifest must never break the app.
 */
export function loadWorkspaceManifest(workspaceRoot: string): WorkspaceManifest | null {
  return loadWorkspaceManifestWithDiagnostics(workspaceRoot).manifest;
}

/** Load a manifest plus bounded local migration diagnostics for review UIs. */
export function loadWorkspaceManifestWithDiagnostics(
  workspaceRoot: string,
): WorkspaceManifestLoadResult {
  let raw: unknown;
  try {
    // Restore any owned pre-write inode before the pair coordinator classifies
    // the manifest side of an interrupted onboarding commit.
    recoverInterruptedWorkspaceManifestClaim(workspaceRoot);
    recoverInterruptedWorkspaceOnboardingPair(workspaceRoot);
    raw = JSON.parse(
      readWorkspaceFileBounded(
        workspaceRoot,
        WORKSPACE_MANIFEST_RELPATH,
        WORKSPACE_MANIFEST_MAX_BYTES,
      ).toString('utf8'),
    );
  } catch {
    return { manifest: null, diagnostics: [] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { manifest: null, diagnostics: [] };
  }
  const record = raw as Record<string, unknown>;
  const diagnostics = diagnoseWorkspaceManifestCompatibility(record);
  recordWorkspaceCompatibilityDiagnostics(workspaceRoot, diagnostics);
  return {
    manifest: normalizeManifest(record),
    diagnostics,
  };
}

/**
 * Inspect only migration shape. Values are counted, never copied into
 * telemetry, and normal v2 manifests (including their serialized `agents`
 * alias) produce no compatibility diagnostics.
 */
export function diagnoseWorkspaceManifestCompatibility(
  raw: Record<string, unknown>,
): WorkspaceCompatibilityDiagnostic[] {
  const diagnostics: WorkspaceCompatibilityDiagnostic[] = [];
  const agents = asRecord(raw.agents);
  const persona = asRecord(raw.persona);
  const orchestration = asRecord(raw.orchestration);
  const hasLegacyAgents = Object.keys(agents).length > 0;
  const hasPersona = Object.keys(persona).length > 0;
  const hasOrchestration = Object.keys(orchestration).length > 0;
  const legacyIds = [
    ...(typeof agents.default === 'string' ? [agents.default] : []),
    ...(Array.isArray(agents.enabled)
      ? agents.enabled.filter((value): value is string => typeof value === 'string').slice(0, 256)
      : []),
  ].filter((value, index, values) => value.trim() && values.indexOf(value) === index);

  if (hasLegacyAgents && !hasPersona) {
    diagnostics.push({
      code: 'legacy_manifest_agents',
      surface: 'manifest',
      severity: 'info',
      message: 'Legacy manifest agent selection was normalized into the persona contract.',
      count: legacyIds.length || 1,
    });
  }
  if (hasLegacyAgents && !hasOrchestration) {
    diagnostics.push({
      code: 'legacy_orchestration_defaults',
      surface: 'manifest',
      severity: 'info',
      message: 'Legacy manifest agent selection required compatibility orchestration defaults.',
      count: legacyIds.length || 1,
    });
  }
  if (hasLegacyAgents && !hasPersona && !hasOrchestration && legacyIds.length > 0) {
    diagnostics.push({
      code: 'implicit_same_id_pairing',
      surface: 'manifest',
      severity: 'warning',
      message: 'Legacy persona ids were implicitly paired with same-id orchestration roles.',
      count: legacyIds.length,
    });
  }
  if (legacyIds.includes('frontend-builder')) {
    diagnostics.push({
      code: 'legacy_frontend_persona',
      surface: 'manifest',
      severity: 'info',
      message: 'Legacy frontend persona selection was normalized to engineer plus the frontend capability.',
      count: 1,
    });
  }
  return diagnostics;
}

/** Write the manifest (stable 2-space JSON + trailing newline), creating `.brainrouter/`. */
export function saveWorkspaceManifest(
  workspaceRoot: string,
  manifest: WorkspaceManifest,
  options: {
    exclusive?: boolean;
    /** Additional compare-before-save validation for reviewed edits. */
    beforeCommit?: () => void;
  } = {},
): string {
  const serialized = serializeWorkspaceManifest(manifest);
  return writeWorkspaceFileAtomic(
    workspaceRoot,
    WORKSPACE_MANIFEST_RELPATH,
    serialized,
    { exclusive: options.exclusive, beforeCommit: options.beforeCommit },
  );
}

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
  return normalizeManifest(
    manifest as unknown as Record<string, unknown>,
    asRecord(manifest.extra),
  );
}

/**
 * Build a fresh manifest from a profile preset. Preset selections are starting
 * points — pass `overrides` for anything the user changed in the wizard.
 */
export function createWorkspaceManifest(input: {
  name: string;
  profile: WorkspaceProfileId;
  by: WorkspaceOnboardSource;
  at?: string;
  overrides?: Partial<Pick<
    WorkspaceManifest,
    'persona' | 'orchestration' | 'agents' | 'capabilities' | 'skills' | 'tools' | 'memory' | 'instructions'
  >>;
}): WorkspaceManifest {
  const preset = getWorkspaceProfile(input.profile) ?? getWorkspaceProfile('custom')!;
  const orchestrationDefaults = resolveWorkspaceProfileOrchestrationDefaults(preset.id);
  const overrides = input.overrides ?? {};
  const persona = overrides.persona ?? overrides.agents ?? {
    default: preset.persona.default,
    enabled: [...preset.persona.enabled],
  };
  const manifest: WorkspaceManifest = {
    version: WORKSPACE_MANIFEST_VERSION,
    name: isBoundedString(input.name) ? input.name.trim() || 'workspace' : 'workspace',
    profile: preset.id,
    onboarded: { at: input.at ?? new Date().toISOString(), by: input.by },
    persona,
    orchestration: overrides.orchestration ?? {
      mode: orchestrationDefaults.mode,
      availableRoles: orchestrationDefaults.availableRoles,
      disabledRoles: orchestrationDefaults.disabledRoles,
      maxParallel: orchestrationDefaults.maxParallel,
    },
    agents: persona,
    capabilities: overrides.capabilities ?? {
      enabled: [...preset.capabilities.recommended],
      disabled: [],
    },
    skills: overrides.skills ?? { packs: [...preset.skills.packs], enabled: [...preset.skills.enabled], disabled: [] },
    tools: overrides.tools ?? { profiles: [...preset.tools.profiles], deny: [] },
    memory: overrides.memory ?? { tags: [...preset.memory.tags], captureHint: preset.memory.captureHint },
    instructions: overrides.instructions ?? 'AGENT.md',
  };
  return normalizeManifest(manifest as unknown as Record<string, unknown>);
}

interface NormalizationBudget {
  remaining: number;
}

function normalizeManifest(
  raw: Record<string, unknown>,
  explicitExtra?: Record<string, unknown>,
): WorkspaceManifest {
  const budget: NormalizationBudget = { remaining: WORKSPACE_MANIFEST_MAX_NORMALIZATION_NODES };
  const profileInput = boundedInputString(raw.profile, budget);
  const profile: WorkspaceProfileId =
    profileInput !== undefined && isWorkspaceProfileId(profileInput) ? profileInput : 'custom';
  const onboardedRaw = asRecord(raw.onboarded);
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
  const extra: Record<string, unknown> = {};
  const extraState = { inspected: 0 };
  if (explicitExtra !== undefined) collectExtraEntries(explicitExtra, extra, budget, extraState);
  collectExtraEntries(raw, extra, budget, extraState, explicitExtra !== undefined);
  const normalized: WorkspaceManifest = {
    version,
    name,
    profile,
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].slice(0, WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES);
}

function appendRequiredString(values: string[], required: string | undefined): string[] {
  if (!required || values.includes(required)) return values;
  if (values.length >= WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES) values.pop();
  values.push(required);
  return values;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? value as number
    : fallback;
}

function isSensitiveExtraKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_EXTRA_KEYS.has(normalized)) return true;
  if (SAFE_TOKEN_METADATA_KEYS.some((pattern) => pattern.test(normalized))) return false;
  if (SAFE_SENSITIVE_METADATA_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false;
  if (SENSITIVE_EXTRA_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return true;

  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word) => SENSITIVE_EXTRA_KEY_WORDS.has(word))) return true;
  return SENSITIVE_EXTRA_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function collectExtraEntries(
  source: Record<string, unknown>,
  output: Record<string, unknown>,
  budget: NormalizationBudget,
  state: { inspected: number },
  skipExplicitExtra = false,
): void {
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue;
    if (state.inspected >= WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES || !takeNode(budget)) return;
    state.inspected += 1;
    if (KNOWN_KEYS.has(key) || (skipExplicitExtra && key === 'extra') ||
        !isSafeExtraKey(key)) continue;
    const sanitized = sanitizeExtraValue(source[key], 0, budget, true);
    if (sanitized !== undefined) output[key] = sanitized;
  }
}

function sanitizeExtraValue(
  value: unknown,
  depth: number,
  budget: NormalizationBudget,
  alreadyCounted = false,
): unknown | undefined {
  if (depth > WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH || (!alreadyCounted && !takeNode(budget))) return undefined;
  if (typeof value === 'string') {
    if (!isBoundedString(value)) return undefined;
    const text = stripControlCharacters(value);
    return isSensitiveValue(text) || isLocalAbsolutePath(text) ? undefined : text;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    const limit = Math.min(value.length, WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES);
    for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
      const sanitized = sanitizeExtraValue(value[index], depth + 1, budget);
      if (sanitized !== undefined) output.push(sanitized);
    }
    return output;
  }
  if (typeof value !== 'object') return undefined;

  const output: Record<string, unknown> = {};
  let inspected = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.hasOwn(value, key)) continue;
    if (inspected >= WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES || !takeNode(budget)) break;
    inspected += 1;
    if (!isSafeExtraKey(key)) continue;
    const sanitized = sanitizeExtraValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
      budget,
      true,
    );
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function safeKnownString(value: unknown, fallback: string, budget: NormalizationBudget): string {
  const input = boundedInputString(value, budget);
  if (input === undefined) return fallback;
  const text = stripControlCharacters(input);
  return isSensitiveValue(text) || isLocalAbsolutePath(text) ? fallback : text;
}

function safeStringArray(value: unknown, budget: NormalizationBudget): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  const limit = Math.min(value.length, WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES);
  for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
    const sanitized = safeKnownString(value[index], '', budget);
    if (sanitized !== '') output.push(sanitized);
  }
  return output;
}

function boundedInputString(value: unknown, budget: NormalizationBudget): string | undefined {
  if (!takeNode(budget) || typeof value !== 'string' || !isBoundedString(value)) return undefined;
  return value;
}

function safeInstructionPointer(value: unknown, budget: NormalizationBudget): string {
  const input = boundedInputString(value, budget);
  if (input === undefined) return 'AGENT.md';
  if (input.trim() === '') return '';
  if (hasControlCharacters(input)) return 'AGENT.md';
  const text = stripControlCharacters(input);
  const pointer = (isSensitiveValue(text) || isLocalAbsolutePath(text) ? 'AGENT.md' : text).trim();
  if (!pointer || pointer.includes('\0') || pointer.includes('\n') || pointer.includes('\r')) return 'AGENT.md';
  const normalized = path.posix.normalize(pointer.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) return 'AGENT.md';
  return normalized;
}

function takeNode(budget: NormalizationBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

function isBoundedString(value: string): boolean {
  return value.length <= WORKSPACE_MANIFEST_MAX_STRING_BYTES &&
    Buffer.byteLength(value) <= WORKSPACE_MANIFEST_MAX_STRING_BYTES;
}

function isSafeExtraKey(key: string): boolean {
  if (!isBoundedString(key)) return false;
  const decoded = decodePercentEscapesTolerantly(key);
  return !UNSAFE_OBJECT_KEYS.has(key) &&
    !UNSAFE_OBJECT_KEYS.has(decoded) &&
    !hasControlCharacters(key) &&
    !hasControlCharacters(decoded) &&
    !isSensitiveExtraKey(key) &&
    !isSensitiveExtraKey(decoded);
}

function hasControlCharacters(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function stripControlCharacters(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
}

function isLocalAbsolutePath(value: string): boolean {
  const text = canonicalizeUriMaterial(value.trim());
  return text.startsWith('/') ||
    path.win32.isAbsolute(text) ||
    /^~[\\/]/.test(text) ||
    /\bfile:\/\//i.test(text) ||
    /(?:^|[^A-Za-z0-9_/])\/(?!\/)[^\s"']+/.test(text) ||
    /(?:^|[^A-Za-z0-9_])~[\\/][^\s"']+/.test(text) ||
    /(?:^|[^A-Za-z0-9_])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+[\\/])[^\s"']*/.test(text);
}

function isSensitiveValue(value: string): boolean {
  const text = canonicalizeUriMaterial(value.trim());
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\bBearer\s+\S+/i.test(text) ||
    /(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{12,}|xox[baprs]-\S+|AKIA[A-Z0-9]{16})/.test(text) ||
    hasSensitiveUriMaterial(text) ||
    containsJwtLikeValue(text);
}

function hasSensitiveUriMaterial(value: string): boolean {
  const decoded = canonicalizeUriMaterial(value);
  return hasUriUserInfo(decoded) ||
    (decoded.includes('=') && hasSensitiveUriParameter(decoded));
}

function canonicalizeUriMaterial(value: string): string {
  return stripControlCharacters(decodePercentEscapesTolerantly(value));
}

function decodePercentEscapesTolerantly(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < WORKSPACE_MANIFEST_MAX_PERCENT_DECODE_PASSES; pass += 1) {
    const next = decoded.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (encoded) =>
      Buffer.from(encoded.replaceAll('%', ''), 'hex').toString('utf8'));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function hasSensitiveUriParameter(value: string): boolean {
  const firstEquals = value.indexOf('=');
  if (firstEquals >= 0) {
    const leadingKey = value.slice(0, firstEquals).trim();
    if (/^[A-Za-z0-9_.-]{1,512}$/u.test(leadingKey) && isSensitiveUriParameterKey(leadingKey)) return true;
  }

  const parameter = /[?&#;]\s*([^=&#;]{1,512})\s*=/gu;
  for (const match of value.matchAll(parameter)) {
    if (isSensitiveUriParameterKey(match[1] ?? '')) return true;
  }
  return false;
}

function isSensitiveUriParameterKey(value: string): boolean {
  const key = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return key === 'sig' || key === 'token' || key.endsWith('token') ||
    ['apikey', 'accesskey', 'privatekey', 'sessionkey', 'accesstoken', 'refreshtoken', 'idtoken',
      'authtoken', 'securitytoken', 'bearertoken', 'clientsecret', 'authorization', 'credential',
      'password', 'passwd', 'secret', 'signature']
      .some((fragment) => key.includes(fragment));
}

function hasUriUserInfo(value: string): boolean {
  let marker = value.indexOf('//');
  while (marker >= 0) {
    const authorityStart = marker + 2;
    let authorityEnd = authorityStart;
    while (authorityEnd < value.length && !'/ ?#\t\r\n'.includes(value[authorityEnd]!)) {
      authorityEnd += 1;
    }
    if (value.indexOf('@', authorityStart) >= 0 && value.indexOf('@', authorityStart) < authorityEnd) return true;
    marker = value.indexOf('//', Math.max(authorityEnd, authorityStart + 1));
  }
  return false;
}

/** Linear-time JWT shape check; an unanchored greedy regex is quadratic on long strings without dots. */
function containsJwtLikeValue(value: string): boolean {
  if (!value.includes('.')) return false;
  const segments = value.split('.');
  for (let index = 0; index + 2 < segments.length; index += 1) {
    const middle = segments[index + 1]!;
    if (middle.length >= 8 && isTokenSegment(middle) &&
        trailingTokenCharacters(segments[index]!) >= 8 &&
        leadingTokenCharacters(segments[index + 2]!) >= 8) return true;
  }
  return false;
}

function isTokenSegment(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!isTokenCharacter(value.charCodeAt(index))) return false;
  }
  return true;
}

function leadingTokenCharacters(value: string): number {
  let index = 0;
  while (index < value.length && isTokenCharacter(value.charCodeAt(index))) index += 1;
  return index;
}

function trailingTokenCharacters(value: string): number {
  let index = value.length - 1;
  while (index >= 0 && isTokenCharacter(value.charCodeAt(index))) index -= 1;
  return value.length - index - 1;
}

function isTokenCharacter(code: number): boolean {
  return (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 || code === 95;
}

export { WORKSPACE_PROFILES, getWorkspaceProfile, isWorkspaceProfileId };
export type { WorkspaceProfileId, WorkspaceProfilePreset } from './profiles.js';
