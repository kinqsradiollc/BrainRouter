/** Main-process boundary for Desktop workspace setup and settings. */
import path from 'node:path';
import {
  WORKSPACE_PROFILES,
  commitReviewedWorkspaceOnboarding,
  createWorkspaceManifest,
  inspectWorkspaceOnboardingReview,
  isWorkspaceProfileId,
  loadWorkspaceManifest,
  normalizeWorkspaceManifest,
  suggestWorkspaceProfile,
  type ProfileSuggestion,
  type WorkspaceManifest,
  type WorkspaceOnboardingReviewRevision,
  type WorkspaceProfilePreset,
} from '@kinqs/brainrouter-core/workspace';

export interface WorkspaceManifestInfo {
  onboarded: boolean;
  manifest: WorkspaceManifest | null;
  suggestion: ProfileSuggestion;
  profiles: readonly WorkspaceProfilePreset[];
  review: ReturnType<typeof inspectWorkspaceOnboardingReview>;
}

/** Everything the setup editor needs, without exposing existing instruction contents. */
export function getWorkspaceManifestInfo(workspaceRoot: string): WorkspaceManifestInfo {
  const manifest = loadWorkspaceManifest(workspaceRoot);
  return {
    onboarded: manifest !== null,
    manifest,
    suggestion: suggestWorkspaceProfile(workspaceRoot),
    profiles: WORKSPACE_PROFILES,
    review: inspectWorkspaceOnboardingReview(workspaceRoot),
  };
}

export interface ManifestSavePayload {
  /** Omitted only by the existing profile-card flow during the staged rollout. */
  expected?: unknown;
  source?: unknown;
  profile: unknown;
  agents?: unknown;
  capabilities?: unknown;
  skills?: unknown;
  tools?: unknown;
  memory?: unknown;
  instructions?: unknown;
  instruction?: unknown;
}

export type ManifestSaveResult =
  | { saved: true; manifest: WorkspaceManifest; review: ReturnType<typeof inspectWorkspaceOnboardingReview> }
  | { saved: false; error: string; stale?: boolean };

/** Validate one complete editor submission, preserve safe unknown fields, and commit it. */
export function saveWorkspaceManifestFromPayload(
  workspaceRoot: string,
  payload: unknown,
): ManifestSaveResult {
  try {
    const record = plainRecord(payload, 'workspace setup payload');
    if (Object.keys(record).length === 1 && Object.hasOwn(record, 'profile')) {
      return saveProfileCardSelection(workspaceRoot, record.profile);
    }
    exactOptionalKeys(record, [
      'expected', 'source', 'profile', 'agents', 'capabilities',
      'skills', 'tools', 'memory', 'instructions',
    ], ['instruction'], 'workspace setup payload');

    const expected = parseRevision(record.expected);
    const source = record.source === 'agent' ? 'agent' : record.source === 'wizard' ? 'wizard' : null;
    const profile = typeof record.profile === 'string' ? record.profile : '';
    if (!source) throw new Error('Unknown workspace setup source.');
    if (!isWorkspaceProfileId(profile)) throw new Error('Unknown workspace profile.');

    const current = loadWorkspaceManifest(workspaceRoot);
    const preset = createWorkspaceManifest({
      name: current?.name ?? path.basename(workspaceRoot),
      profile,
      by: source,
      at: current?.onboarded.at,
    });
    const agents = parseAgents(record.agents);
    const capabilities = parseEnabledDisabled(record.capabilities, 'capabilities');
    const skills = parseSkills(record.skills);
    const tools = parseTools(record.tools);
    const memory = parseMemory(record.memory);
    const instructions = parseText(record.instructions, 'instructions', 512);
    const instruction = parseInstruction(record.instruction, instructions);
    const manifest = normalizeWorkspaceManifest({
      ...preset,
      version: current?.version ?? preset.version,
      name: current?.name ?? preset.name,
      onboarded: current ? { ...current.onboarded } : preset.onboarded,
      agents,
      capabilities,
      skills,
      tools,
      memory,
      instructions,
      ...(current?.extra ? { extra: structuredClone(current.extra) } : {}),
    });

    const committed = commitReviewedWorkspaceOnboarding(workspaceRoot, {
      manifest,
      expected,
      ...(instruction ? { instruction } : {}),
    });
    return { saved: true, manifest: committed.manifest, review: committed.review };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workspace setup could not be saved.';
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

function parseAgents(value: unknown): WorkspaceManifest['agents'] {
  const record = plainRecord(value, 'agents');
  exactKeys(record, ['default', 'enabled'], 'agents');
  return {
    default: parseText(record.default, 'default agent', 128),
    enabled: parseList(record.enabled, 'enabled agents'),
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
  exactKeys(record, ['profiles', 'deny'], 'tools');
  return {
    profiles: parseList(record.profiles, 'tool profiles'),
    deny: parseList(record.deny, 'denied tools'),
  };
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
