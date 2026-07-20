/**
 * The workspace manifest — `.brainrouter/workspace.json` (ADR-021 W1).
 *
 * One committable file declares what KIND of project a workspace is (profile)
 * and which agents/skills/tools/memory posture fit it, plus the durable
 * "onboarded" marker. This module is the SINGLE chokepoint for the file:
 * schema, load, save, validation, and preset application — no other module
 * parses the JSON (same discipline as config.ts for CLI knobs).
 *
 * Contract:
 * - No manifest → `null` → every consumer keeps today's behavior exactly.
 * - Loading NEVER throws: unreadable/corrupt JSON → null; bad field shapes
 *   normalize to safe defaults; unknown top-level fields are PRESERVED on
 *   round-trip (forward compatibility with newer writers).
 * - Never holds secrets. Committable by design.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  WORKSPACE_PROFILES,
  getWorkspaceProfile,
  isWorkspaceProfileId,
  type WorkspaceProfileId,
} from './profiles.js';

export const WORKSPACE_MANIFEST_VERSION = 1;
export const WORKSPACE_MANIFEST_RELPATH = path.join('.brainrouter', 'workspace.json');

export type WorkspaceOnboardSource = 'wizard' | 'agent' | 'import';

export interface WorkspaceManifest {
  version: number;
  name: string;
  profile: WorkspaceProfileId;
  onboarded: { at: string; by: WorkspaceOnboardSource };
  agents: { default: string; enabled: string[] };
  skills: { packs: string[]; enabled: string[]; disabled: string[] };
  tools: { profiles: string[]; deny: string[] };
  memory: { tags: string[]; captureHint: string };
  /** Instruction-file pointer (e.g. "AGENT.md") — a reference, never content. */
  instructions: string;
  /** Unknown fields from newer writers, preserved verbatim on round-trip. */
  extra?: Record<string, unknown>;
}

const KNOWN_KEYS = new Set([
  'version', 'name', 'profile', 'onboarded', 'agents', 'skills', 'tools', 'memory', 'instructions',
]);

export function workspaceManifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, WORKSPACE_MANIFEST_RELPATH);
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
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(workspaceManifestPath(workspaceRoot), 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return normalizeManifest(raw as Record<string, unknown>);
}

/** Write the manifest (stable 2-space JSON + trailing newline), creating `.brainrouter/`. */
export function saveWorkspaceManifest(workspaceRoot: string, manifest: WorkspaceManifest): string {
  const target = workspaceManifestPath(workspaceRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const { extra, ...known } = manifest;
  fs.writeFileSync(target, `${JSON.stringify({ ...(extra ?? {}), ...known }, null, 2)}\n`, 'utf8');
  return target;
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
  overrides?: Partial<Pick<WorkspaceManifest, 'agents' | 'skills' | 'tools' | 'memory' | 'instructions'>>;
}): WorkspaceManifest {
  const preset = getWorkspaceProfile(input.profile) ?? getWorkspaceProfile('custom')!;
  const overrides = input.overrides ?? {};
  return {
    version: WORKSPACE_MANIFEST_VERSION,
    name: input.name.trim() || 'workspace',
    profile: preset.id,
    onboarded: { at: input.at ?? new Date().toISOString(), by: input.by },
    agents: overrides.agents ?? { default: preset.agents.default, enabled: [...preset.agents.enabled] },
    skills: overrides.skills ?? { packs: [...preset.skills.packs], enabled: [...preset.skills.enabled], disabled: [] },
    tools: overrides.tools ?? { profiles: [...preset.tools.profiles], deny: [] },
    memory: overrides.memory ?? { tags: [...preset.memory.tags], captureHint: preset.memory.captureHint },
    instructions: overrides.instructions ?? 'AGENT.md',
  };
}

function normalizeManifest(raw: Record<string, unknown>): WorkspaceManifest {
  const profile: WorkspaceProfileId =
    typeof raw.profile === 'string' && isWorkspaceProfileId(raw.profile) ? raw.profile : 'custom';
  const onboardedRaw = asRecord(raw.onboarded);
  const by = onboardedRaw.by;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(key)) extra[key] = value;
  }
  return {
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : WORKSPACE_MANIFEST_VERSION,
    name: str(raw.name, 'workspace'),
    profile,
    onboarded: {
      at: str(onboardedRaw.at, ''),
      by: by === 'wizard' || by === 'agent' || by === 'import' ? by : 'import',
    },
    agents: { default: str(asRecord(raw.agents).default, ''), enabled: strArray(asRecord(raw.agents).enabled) },
    skills: {
      packs: strArray(asRecord(raw.skills).packs),
      enabled: strArray(asRecord(raw.skills).enabled),
      disabled: strArray(asRecord(raw.skills).disabled),
    },
    tools: { profiles: strArray(asRecord(raw.tools).profiles), deny: strArray(asRecord(raw.tools).deny) },
    memory: { tags: strArray(asRecord(raw.memory).tags), captureHint: str(asRecord(raw.memory).captureHint, '') },
    instructions: str(raw.instructions, 'AGENT.md'),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export { WORKSPACE_PROFILES, getWorkspaceProfile, isWorkspaceProfileId };
export type { WorkspaceProfileId, WorkspaceProfilePreset } from './profiles.js';
