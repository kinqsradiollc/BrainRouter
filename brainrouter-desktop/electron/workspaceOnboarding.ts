/** Main-process boundary for Desktop workspace setup and settings. */
import path from 'node:path';
import type { Config } from '@kinqs/brainrouter-core/config';
import {
  WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION,
  buildWorkspaceOnboardingPreview,
  buildWorkspaceOnboardingSources,
  commitReviewedWorkspaceOnboarding,
  createWorkspaceManifest,
  inspectWorkspaceOnboardingReview,
  isWorkspaceProfileId,
  loadWorkspaceManifest,
  migrateWorkspaceManifestToolSelection,
  normalizeWorkspaceManifest,
  previewReviewedWorkspaceInstruction,
  suggestWorkspaceProfile,
  validateReviewedWorkspaceCapabilitySelection,
  validateReviewedWorkspacePersonaSelection,
  validateReviewedWorkspaceSkillSelection,
  validateReviewedWorkspaceRoleSelection,
  workspaceProfilesForOnboarding,
  type ProfileSuggestion,
  type WorkspaceManifest,
  type WorkspaceOnboardingPreview,
  type WorkspaceOnboardingReviewRevision,
  type WorkspaceProfilePreset,
} from '@kinqs/brainrouter-core/workspace';

export interface WorkspaceManifestInfo {
  onboarded: boolean;
  manifest: WorkspaceManifest | null;
  suggestion: ProfileSuggestion;
  profiles: readonly WorkspaceProfilePreset[];
  preview: WorkspaceOnboardingPreview;
  review: ReturnType<typeof inspectWorkspaceOnboardingReview>;
}

/** Everything the setup editor needs, without exposing existing instruction contents. */
export function getWorkspaceManifestInfo(
  workspaceRoot: string,
  config?: Config,
): WorkspaceManifestInfo {
  const manifest = loadWorkspaceManifest(workspaceRoot);
  const suggestion = suggestWorkspaceProfile(workspaceRoot);
  const previewManifest = manifest ?? createWorkspaceManifest({
    name: path.basename(workspaceRoot),
    profile: suggestion.profile,
    by: 'wizard',
  });
  const sources = buildWorkspaceOnboardingSources(workspaceRoot, config);
  return {
    onboarded: manifest !== null,
    manifest,
    suggestion,
    profiles: workspaceProfilesForOnboarding(),
    preview: buildWorkspaceOnboardingPreview(
      previewManifest,
      sources.catalog,
      sources.orchestrationProfiles,
    ),
    review: inspectWorkspaceOnboardingReview(workspaceRoot),
  };
}

export interface ManifestSavePayload {
  /** Omitted only by the existing profile-card flow during the staged rollout. */
  expected?: unknown;
  source?: unknown;
  profile: unknown;
  persona?: unknown;
  orchestration?: unknown;
  capabilities?: unknown;
  skills?: unknown;
  tools?: unknown;
  memory?: unknown;
  instructions?: unknown;
  instruction?: unknown;
  catalogFingerprint?: unknown;
}

export type ManifestSaveResult =
  | { saved: true; manifest: WorkspaceManifest; review: ReturnType<typeof inspectWorkspaceOnboardingReview> }
  | { saved: false; error: string; stale?: boolean };

export type WorkspaceInstructionPreviewResult =
  | {
      ok: true;
      path: 'AGENT.md';
      existed: boolean;
      original: string;
      proposed: string;
      originalBytes: number;
      proposedBytes: number;
    }
  | { ok: false; error: string; stale?: boolean };

export type WorkspaceOnboardingPreviewResult =
  | { ok: true; preview: WorkspaceOnboardingPreview }
  | { ok: false; error: string };

/** Parse an untrusted renderer draft and return only Core's safe preview. */
export function previewWorkspaceOnboardingFromPayload(
  workspaceRoot: string,
  payload: unknown,
  config?: Config,
): WorkspaceOnboardingPreviewResult {
  try {
    const record = plainRecord(payload, 'workspace preview payload');
    exactKeys(record, [
      'profile', 'persona', 'orchestration', 'capabilities',
      'skills', 'tools', 'memory', 'instructions',
    ], 'workspace preview payload');
    const current = loadWorkspaceManifest(workspaceRoot);
    const draft = parseManifestDraft(workspaceRoot, record, current, 'wizard');
    const sources = buildWorkspaceOnboardingSources(workspaceRoot, config);
    return {
      ok: true,
      preview: buildWorkspaceOnboardingPreview(
        draft,
        sources.catalog,
        sources.orchestrationProfiles,
      ),
    };
  } catch {
    return { ok: false, error: 'Workspace setup preview is unavailable.' };
  }
}

/**
 * Validate an instruction-preview query and expose exact text only through the
 * core no-follow, secret-safe, stale-revision gate. This function never writes.
 */
export function previewWorkspaceInstructionFromPayload(
  workspaceRoot: string,
  payload: unknown,
): WorkspaceInstructionPreviewResult {
  try {
    const record = plainRecord(payload, 'instruction preview payload');
    exactKeys(record, ['expected', 'instruction'], 'instruction preview payload');
    const expected = parseRevision(record.expected);
    const instruction = parseInstruction(record.instruction, 'AGENT.md');
    if (!instruction) throw new Error('Instruction proposal is required.');
    return {
      ok: true,
      ...previewReviewedWorkspaceInstruction(workspaceRoot, { expected, instruction }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('changed during review')) {
      return {
        ok: false,
        stale: true,
        error: 'Workspace setup changed while the instruction was being reviewed.',
      };
    }
    if (/unsafe|exceeds|invalid|proposal is required/i.test(message)) {
      return { ok: false, error: 'Workspace instruction preview contains unsafe, oversized, or malformed content.' };
    }
    return { ok: false, error: 'Workspace instruction preview is unavailable.' };
  }
}

/** Validate one complete editor submission, preserve safe unknown fields, and commit it. */
export function saveWorkspaceManifestFromPayload(
  workspaceRoot: string,
  payload: unknown,
  config?: Config,
): ManifestSaveResult {
  try {
    const record = plainRecord(payload, 'workspace setup payload');
    if (Object.keys(record).length === 1 && Object.hasOwn(record, 'profile')) {
      return saveProfileCardSelection(workspaceRoot, record.profile);
    }
    exactOptionalKeys(record, [
      'expected', 'source', 'profile', 'persona', 'orchestration', 'capabilities',
      'skills', 'tools', 'memory', 'instructions', 'catalogFingerprint',
    ], ['instruction'], 'workspace setup payload');

    const expected = parseRevision(record.expected);
    const source = record.source === 'agent' ? 'agent' : record.source === 'wizard' ? 'wizard' : null;
    if (!source) throw new Error('Unknown workspace setup source.');
    const current = loadWorkspaceManifest(workspaceRoot);
    const draft = parseManifestDraft(workspaceRoot, record, current, source);
    const catalog = buildWorkspaceOnboardingSources(workspaceRoot, config).catalog;
    const catalogFingerprint = parseDigest(record.catalogFingerprint);
    const personas = validateReviewedWorkspacePersonaSelection(draft.persona, catalog);
    if (!personas.ok) throw new Error('Reviewed workspace persona selection is unavailable.');
    const roles = validateReviewedWorkspaceRoleSelection({
      availableRoles: draft.orchestration.availableRoles,
      disabledRoles: draft.orchestration.disabledRoles,
    }, catalog);
    if (!roles.ok) throw new Error('Reviewed workspace role selection is unavailable.');
    const capabilityCatalog = {
      ...catalog,
      entries: buildWorkspaceOnboardingPreview(draft, catalog).catalog,
    };
    const capabilities = validateReviewedWorkspaceCapabilitySelection(
      draft.capabilities,
      capabilityCatalog,
    );
    if (!capabilities.ok) throw new Error('Reviewed workspace capability selection is unavailable.');
    const skills = validateReviewedWorkspaceSkillSelection(draft.skills, catalog);
    if (!skills.ok) throw new Error('Reviewed workspace skill selection is unavailable.');
    const manifest = migrateWorkspaceManifestToolSelection({
      manifest: {
        ...draft,
        persona: personas.value,
        agents: personas.value,
        orchestration: {
          ...draft.orchestration,
          availableRoles: roles.value.availableRoles,
          disabledRoles: roles.value.disabledRoles,
        },
        capabilities: capabilities.value,
        skills: skills.value,
      },
      reviewed: {
        profiles: draft.tools.profiles,
        enabled: draft.tools.enabled ?? [],
        deny: draft.tools.deny,
      },
      catalog,
      reviewedCatalogFingerprint: catalogFingerprint,
    });
    const instructions = manifest.instructions;
    const instruction = parseInstruction(record.instruction, instructions);

    const committed = commitReviewedWorkspaceOnboarding(workspaceRoot, {
      manifest,
      expected,
      ...(instruction ? { instruction } : {}),
    });
    return { saved: true, manifest: committed.manifest, review: committed.review };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workspace setup could not be saved.';
    if (isStaleCatalogReviewError(error)) {
      return {
        saved: false,
        stale: true,
        error: 'Available setup choices changed while this dialog was open. Reload and review the latest options.',
      };
    }
    if (message.includes('changed during review')) {
      return { saved: false, stale: true, error: 'Workspace setup changed while it was open. Reload and review the latest version.' };
    }
    if (message.includes('Unknown workspace profile')) return { saved: false, error: message };
    if (message.includes('unsafe') || message.includes('Unsafe') || message.includes('exceeds')) {
      return { saved: false, error: 'Workspace setup contains unsafe or oversized content.' };
    }
    return { saved: false, error: 'Workspace setup could not be saved.' };
  }
}

/** Preserve the currently shipped profile-card IPC contract until the editor wiring lands. */
function saveProfileCardSelection(workspaceRoot: string, value: unknown): ManifestSaveResult {
  const profile = typeof value === 'string' ? value : '';
  if (!isWorkspaceProfileId(profile)) throw new Error('Unknown workspace profile.');
  if (loadWorkspaceManifest(workspaceRoot) !== null) {
    return { saved: false, error: 'Workspace is already onboarded.' };
  }
  const expected = inspectWorkspaceOnboardingReview(workspaceRoot).revision;
  if (loadWorkspaceManifest(workspaceRoot) !== null) {
    return { saved: false, error: 'Workspace is already onboarded.' };
  }
  const manifest = createWorkspaceManifest({
    name: path.basename(workspaceRoot),
    profile,
    by: 'wizard',
  });
  const committed = commitReviewedWorkspaceOnboarding(workspaceRoot, { expected, manifest });
  return { saved: true, manifest: committed.manifest, review: committed.review };
}

function parseRevision(value: unknown): WorkspaceOnboardingReviewRevision {
  const record = plainRecord(value, 'review revision');
  exactKeys(record, ['root', 'manifest', 'instruction'], 'review revision');
  return {
    root: parseDigest(record.root),
    manifest: parseDigest(record.manifest),
    instruction: parseDigest(record.instruction),
  };
}

function parsePersona(value: unknown): WorkspaceManifest['persona'] {
  const record = plainRecord(value, 'persona');
  exactKeys(record, ['default', 'enabled'], 'persona');
  return {
    default: parseText(record.default, 'default persona', 128),
    enabled: parseList(record.enabled, 'enabled personas'),
  };
}

function parseOrchestration(value: unknown): WorkspaceManifest['orchestration'] {
  const record = plainRecord(value, 'orchestration');
  exactKeys(record, ['mode', 'availableRoles', 'disabledRoles', 'maxParallel'], 'orchestration');
  const mode = record.mode;
  if (!(mode === 'off' || mode === 'explicit' || mode === 'adaptive')) {
    throw new Error('Invalid orchestration mode.');
  }
  if (!Number.isSafeInteger(record.maxParallel) ||
      Number(record.maxParallel) < 1 || Number(record.maxParallel) > 32) {
    throw new Error('Invalid orchestration parallelism.');
  }
  const disabledRoles = parseList(record.disabledRoles, 'disabled orchestration roles');
  const disabledRoleSet = new Set(disabledRoles);
  return {
    mode,
    availableRoles: parseList(record.availableRoles, 'available orchestration roles')
      .filter((role) => !disabledRoleSet.has(role)),
    disabledRoles,
    maxParallel: Number(record.maxParallel),
  };
}

function parseEnabledDisabled(value: unknown, label: string): { enabled: string[]; disabled: string[] } {
  const record = plainRecord(value, label);
  exactKeys(record, ['enabled', 'disabled'], label);
  return {
    enabled: parseList(record.enabled, `enabled ${label}`),
    disabled: parseList(record.disabled, `disabled ${label}`),
  };
}

function parseSkills(value: unknown): WorkspaceManifest['skills'] {
  const record = plainRecord(value, 'skills');
  exactKeys(record, ['packs', 'enabled', 'disabled'], 'skills');
  return {
    packs: parseList(record.packs, 'skill packs'),
    enabled: parseList(record.enabled, 'enabled skills'),
    disabled: parseList(record.disabled, 'disabled skills'),
  };
}

function parseTools(value: unknown): WorkspaceManifest['tools'] {
  const record = plainRecord(value, 'tools');
  exactKeys(record, ['profiles', 'enabled', 'deny'], 'tools');
  return {
    profiles: parseList(record.profiles, 'tool profiles'),
    enabled: parseList(record.enabled, 'enabled tools'),
    deny: parseList(record.deny, 'denied tools'),
  };
}

function parseManifestDraft(
  workspaceRoot: string,
  record: Record<string, unknown>,
  current: WorkspaceManifest | null,
  source: 'wizard' | 'agent',
): WorkspaceManifest {
  const profile = typeof record.profile === 'string' ? record.profile : '';
  if (!isWorkspaceProfileId(profile)) throw new Error('Unknown workspace profile.');
  const preset = createWorkspaceManifest({
    name: current?.name ?? path.basename(workspaceRoot),
    profile,
    by: source,
    at: current?.onboarded.at,
  });
  return normalizeWorkspaceManifest({
    ...preset,
    version: WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION,
    name: current?.name ?? preset.name,
    onboarded: current ? { ...current.onboarded } : preset.onboarded,
    persona: parsePersona(record.persona),
    orchestration: parseOrchestration(record.orchestration),
    capabilities: parseEnabledDisabled(record.capabilities, 'capabilities'),
    skills: parseSkills(record.skills),
    tools: { ...parseTools(record.tools), mode: 'explicit-catalog' },
    memory: parseMemory(record.memory),
    instructions: parseText(record.instructions, 'instructions', 512),
    ...(current?.extra ? { extra: structuredClone(current.extra) } : {}),
  });
}

function parseMemory(value: unknown): WorkspaceManifest['memory'] {
  const record = plainRecord(value, 'memory');
  exactKeys(record, ['tags', 'captureHint'], 'memory');
  return {
    tags: parseList(record.tags, 'memory tags'),
    captureHint: parseText(record.captureHint, 'memory capture hint', 256),
  };
}

function parseInstruction(
  value: unknown,
  manifestPath: string,
): { path: 'AGENT.md'; contents: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const record = plainRecord(value, 'instruction proposal');
  exactKeys(record, ['path', 'contents'], 'instruction proposal');
  const instructionPath = parseText(record.path, 'instruction path', 512);
  if (instructionPath !== 'AGENT.md' || manifestPath !== instructionPath) {
    throw new Error('Unsafe instruction proposal target.');
  }
  return {
    path: 'AGENT.md',
    contents: parseText(record.contents, 'instruction contents', 64 * 1024, false),
  };
}

function parseList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`Invalid ${label}.`);
  return value.map((entry) => parseText(entry, label, 128)).filter(Boolean);
}

function parseText(value: unknown, label: string, maxBytes: number, trim = true): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) throw new Error(`Invalid ${label}.`);
  return trim ? value.trim() : value;
}

function parseDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid review revision.');
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  const keys = Object.keys(record);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new Error(`Invalid ${label}.`);
  }
}

function exactOptionalKeys(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) ||
      keys.some((key) => !allowed.has(key))) {
    throw new Error(`Invalid ${label}.`);
  }
}

function isStaleCatalogReviewError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'WorkspaceSelectionReviewError') return false;
  const issues = (error as Error & { issues?: unknown }).issues;
  return Array.isArray(issues) && issues.some((issue) =>
    plainIssueCode(issue) === 'stale-catalog');
}

function plainIssueCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const code = (value as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}
