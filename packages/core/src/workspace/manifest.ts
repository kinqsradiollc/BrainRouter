/**
 * The workspace manifest — `.brainrouter/workspace.json` (ADR-021 W1).
 *
 * One committable file declares what KIND of project a workspace is (profile)
 * and which agents/capabilities/skills/tools/memory posture fit it, plus the
 * durable "onboarded" marker. This module is the SINGLE chokepoint for the file:
 * schema, load, save, validation, and preset application — no other module
 * parses the JSON (same discipline as config.ts for CLI knobs).
 *
 * Contract:
 * - No manifest → `null` → every consumer keeps today's behavior exactly.
 * - Loading NEVER throws: unreadable/corrupt JSON → null; bad field shapes
 *   normalize to safe defaults; unknown top-level fields and capability ids
 *   are PRESERVED on round-trip when safe (forward compatibility with newer
 *   writers); obvious secrets, tenancy ids, and local absolute paths are
 *   discarded before the committable representation is returned or saved.
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
  capabilities: { enabled: string[]; disabled: string[] };
  skills: { packs: string[]; enabled: string[]; disabled: string[] };
  tools: { profiles: string[]; deny: string[] };
  memory: { tags: string[]; captureHint: string };
  /** Instruction-file pointer (e.g. "AGENT.md") — a reference, never content. */
  instructions: string;
  /** Safe unknown fields from newer writers, preserved on round-trip. */
  extra?: Record<string, unknown>;
}

const KNOWN_KEYS = new Set([
  'version', 'name', 'profile', 'onboarded', 'agents', 'capabilities', 'skills', 'tools', 'memory', 'instructions',
]);

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
  const { extra: inputExtra, ...inputKnown } = manifest;
  const normalized = normalizeManifest({ ...(inputExtra ?? {}), ...inputKnown });
  const { extra, ...known } = normalized;
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
  overrides?: Partial<Pick<WorkspaceManifest, 'agents' | 'capabilities' | 'skills' | 'tools' | 'memory' | 'instructions'>>;
}): WorkspaceManifest {
  const preset = getWorkspaceProfile(input.profile) ?? getWorkspaceProfile('custom')!;
  const overrides = input.overrides ?? {};
  const manifest: WorkspaceManifest = {
    version: WORKSPACE_MANIFEST_VERSION,
    name: input.name.trim() || 'workspace',
    profile: preset.id,
    onboarded: { at: input.at ?? new Date().toISOString(), by: input.by },
    agents: overrides.agents ?? { default: preset.agents.default, enabled: [...preset.agents.enabled] },
    capabilities: overrides.capabilities ?? { enabled: [...preset.capabilities.enabled], disabled: [] },
    skills: overrides.skills ?? { packs: [...preset.skills.packs], enabled: [...preset.skills.enabled], disabled: [] },
    tools: overrides.tools ?? { profiles: [...preset.tools.profiles], deny: [] },
    memory: overrides.memory ?? { tags: [...preset.memory.tags], captureHint: preset.memory.captureHint },
    instructions: overrides.instructions ?? 'AGENT.md',
  };
  return normalizeManifest(manifest as unknown as Record<string, unknown>);
}

function normalizeManifest(raw: Record<string, unknown>): WorkspaceManifest {
  const profile: WorkspaceProfileId =
    typeof raw.profile === 'string' && isWorkspaceProfileId(raw.profile) ? raw.profile : 'custom';
  const onboardedRaw = asRecord(raw.onboarded);
  const agentsRaw = asRecord(raw.agents);
  const legacyFrontendPersona =
    agentsRaw.default === 'frontend-builder' || strArray(agentsRaw.enabled).includes('frontend-builder');
  const agentDefault = agentsRaw.default === 'frontend-builder'
    ? 'engineer'
    : safeKnownString(agentsRaw.default, '');
  const agentEnabled = uniqueStrings(safeStringValues([
    ...strArray(agentsRaw.enabled).map((agent) => agent === 'frontend-builder' ? 'engineer' : agent),
    ...(legacyFrontendPersona ? ['engineer'] : []),
  ]));
  const capabilitiesRaw = asRecord(raw.capabilities);
  const disabledCapabilities = uniqueStrings(safeStringArray(capabilitiesRaw.disabled));
  const disabledCapabilitySet = new Set(disabledCapabilities);
  const enabledCapabilities = uniqueStrings([
    ...safeStringArray(capabilitiesRaw.enabled),
    ...(legacyFrontendPersona ? ['frontend'] : []),
  ]).filter((capability) => !disabledCapabilitySet.has(capability));
  const by = onboardedRaw.by;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (KNOWN_KEYS.has(key) || isSensitiveExtraKey(key)) continue;
    const sanitized = sanitizeExtraValue(value);
    if (sanitized !== undefined) extra[key] = sanitized;
  }
  return {
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : WORKSPACE_MANIFEST_VERSION,
    name: safeKnownString(raw.name, 'workspace'),
    profile,
    onboarded: {
      at: safeKnownString(onboardedRaw.at, ''),
      by: by === 'wizard' || by === 'agent' || by === 'import' ? by : 'import',
    },
    agents: { default: agentDefault, enabled: agentEnabled },
    capabilities: { enabled: enabledCapabilities, disabled: disabledCapabilities },
    skills: {
      packs: safeStringArray(asRecord(raw.skills).packs),
      enabled: safeStringArray(asRecord(raw.skills).enabled),
      disabled: safeStringArray(asRecord(raw.skills).disabled),
    },
    tools: {
      profiles: safeStringArray(asRecord(raw.tools).profiles),
      deny: safeStringArray(asRecord(raw.tools).deny),
    },
    memory: {
      tags: safeStringArray(asRecord(raw.memory).tags),
      captureHint: safeKnownString(asRecord(raw.memory).captureHint, ''),
    },
    instructions: safeInstructionPointer(raw.instructions),
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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

function sanitizeExtraValue(value: unknown, depth = 0): unknown | undefined {
  if (depth > 8) return undefined;
  if (typeof value === 'string') {
    return isSensitiveValue(value) || isLocalAbsolutePath(value) ? undefined : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeExtraValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveExtraKey(key)) continue;
    const sanitized = sanitizeExtraValue(nested, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function safeKnownString(value: unknown, fallback: string): string {
  const text = str(value, fallback);
  return isSensitiveValue(text) || isLocalAbsolutePath(text) ? fallback : text;
}

function safeStringArray(value: unknown): string[] {
  return safeStringValues(strArray(value));
}

function safeStringValues(values: string[]): string[] {
  return values.map((value) => safeKnownString(value, '')).filter((value) => value !== '');
}

function safeInstructionPointer(value: unknown): string {
  const pointer = safeKnownString(value, 'AGENT.md').trim();
  if (!pointer || pointer.includes('\0') || pointer.includes('\n') || pointer.includes('\r')) return 'AGENT.md';
  const normalized = path.posix.normalize(pointer.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) return 'AGENT.md';
  return normalized;
}

function isLocalAbsolutePath(value: string): boolean {
  const text = value.trim();
  return text.startsWith('/') ||
    path.win32.isAbsolute(text) ||
    /^~[\\/]/.test(text) ||
    /\bfile:\/\//i.test(text) ||
    /(?:^|[^A-Za-z0-9_/])\/(?!\/)[^\s"']+/.test(text) ||
    /(?:^|[^A-Za-z0-9_])~[\\/][^\s"']+/.test(text) ||
    /(?:^|[^A-Za-z0-9_])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+[\\/])[^\s"']*/.test(text);
}

function isSensitiveValue(value: string): boolean {
  const text = value.trim();
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\bBearer\s+\S+/i.test(text) ||
    /(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{12,}|xox[baprs]-\S+|AKIA[A-Z0-9]{16})/.test(text) ||
    /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text);
}

export { WORKSPACE_PROFILES, getWorkspaceProfile, isWorkspaceProfileId };
export type { WorkspaceProfileId, WorkspaceProfilePreset } from './profiles.js';
