/** Browser-development mirror of the reviewed onboarding host contract. */
import { WORKSPACE_PROFILES } from '@kinqs/brainrouter-core/dist/workspace/profiles.js';
import { parseOnboardingDraft } from '../components/dialogs/onboardingEditorModel.js';
import {
  buildDevOnboardingPreview,
  devDraftForProfile,
} from './devOnboardingPreview.js';

// Keep the browser-development mock aligned with the core reviewed-proposal
// boundary without pulling the Node-oriented proposal parser into the bundle.
const DEV_MAX_INSTRUCTION_BYTES = 64 * 1024;
const DEV_MAX_DESCRIPTION_BYTES = 4 * 1024;
const DEV_ONBOARDING_AT = '2026-01-01T00:00:00.000Z';

export interface DevOnboardingState {
  manifests: Map<string, Record<string, unknown>>;
  instructions: Map<string, string>;
  manifestRevisions: Map<string, number>;
  instructionRevisions: Map<string, number>;
}

export function createDevOnboardingState(): DevOnboardingState {
  return {
    manifests: new Map(),
    instructions: new Map(),
    manifestRevisions: new Map(),
    instructionRevisions: new Map(),
  };
}

export function getDevWorkspaceManifest(state: DevOnboardingState, root: string): Record<string, unknown> {
  const instruction = state.instructions.get(root);
  return {
    ok: true,
    onboarded: state.manifests.has(root),
    manifest: state.manifests.get(root) ?? null,
    suggestion: {
      profile: 'engineering',
      reasons: ['Node.js (`package.json`)', 'TypeScript (`tsconfig.json`)'],
    },
    profiles: WORKSPACE_PROFILES.map((profile) => ({
      ...profile,
      capabilities: { ...profile.capabilities, disabled: [] },
      skills: { ...profile.skills, disabled: [] },
      tools: { ...profile.tools, enabled: [], deny: [] },
    })),
    preview: buildDevOnboardingPreview(
      state.manifests.get(root) ?? devDraftForProfile('engineering', root),
    ),
    review: {
      revision: revision(state, root),
      instruction: {
        path: 'AGENT.md',
        existed: instruction !== undefined,
        bytes: instruction ? new TextEncoder().encode(instruction).length : 0,
        sha256: instruction === undefined ? null : counterDigest(state.instructionRevisions.get(root) ?? 0),
      },
    },
  };
}

/** Browser-development mirror of the host's bounded, no-write proposal query. */
export function proposeDevWorkspaceOnboarding(root: string, payload: unknown): Record<string, unknown> {
  const record = isRecord(payload) ? payload : {};
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  if (new TextEncoder().encode(description).length > DEV_MAX_DESCRIPTION_BYTES) {
    throw new Error(`Project description exceeds ${DEV_MAX_DESCRIPTION_BYTES} bytes.`);
  }
  const deterministicOnly = record.mode === 'deterministic';
  const profile = WORKSPACE_PROFILES.find((entry) => entry.id === 'engineering');
  if (!profile) throw new Error('Engineering workspace profile is unavailable.');

  const manifest = {
    version: 2,
    name: root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'workspace',
    profile: profile.id,
    onboarded: { at: DEV_ONBOARDING_AT, by: 'agent' },
    persona: { default: profile.persona.default, enabled: [...profile.persona.enabled] },
    orchestration: {
      mode: profile.orchestration.mode,
      availableRoles: [...profile.orchestration.availableRoles],
      disabledRoles: [...profile.orchestration.disabledRoles],
      maxParallel: profile.orchestration.maxParallel,
    },
    capabilities: { enabled: [...profile.capabilities.recommended], disabled: [] },
    skills: { packs: [...profile.skills.packs], enabled: [...profile.skills.enabled], disabled: [] },
    tools: { profiles: [...profile.tools.profiles], enabled: [], deny: [] },
    memory: { tags: [...profile.memory.tags], captureHint: profile.memory.captureHint },
    instructions: 'AGENT.md',
  };
  return {
    proposal: {
      source: deterministicOnly ? 'deterministic' : 'model',
      manifest,
      reasons: description
        ? ['Matched the project description.', 'Detected a TypeScript application.']
        : ['Detected a TypeScript application.'],
      ...(deterministicOnly ? {} : {
        instruction: {
          path: 'AGENT.md',
          contents: '# Workspace instructions\n\n- Keep changes focused and verify them before completion.\n',
        },
      }),
    },
    modelAttempted: !deterministicOnly,
    ...(deterministicOnly ? { fallbackReason: 'model-unavailable' } : {}),
    scan: {
      markers: ['package.json', 'tsconfig.json'],
      stats: {
        entriesVisited: 42,
        directoriesVisited: 8,
        filesRead: 12,
        bytesRead: 24_576,
        ignoredEntries: 3,
        unreadableEntries: 0,
      },
      stoppedBy: [],
    },
  };
}

export function saveDevWorkspaceManifest(
  state: DevOnboardingState,
  root: string,
  payload: unknown,
): Record<string, unknown> {
  if (!isRecord(payload) || !sameRevision(payload.expected, revision(state, root))) {
    return { saved: false, stale: true, error: 'Workspace setup changed while it was open.' };
  }
  if (payload.catalogFingerprint !== 'd'.repeat(64)) {
    return { saved: false, stale: true, error: 'The available setup catalog changed while it was open.' };
  }
  const source = payload.source === 'agent' ? 'agent' : payload.source === 'wizard' ? 'wizard' : null;
  const draft = parseOnboardingDraft(payload);
  if (!source || !draft || !WORKSPACE_PROFILES.some((profile) => profile.id === draft.profile)) {
    return { saved: false, error: 'Workspace setup could not be saved.' };
  }
  const instruction = parseInstruction(payload.instruction);
  if (payload.instruction !== undefined && !instruction) {
    return { saved: false, error: 'Workspace setup could not be saved.' };
  }

  const current = state.manifests.get(root);
  const currentOnboarded = isRecord(current?.onboarded) ? current.onboarded : null;
  const manifest = {
    version: 3,
    name: root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'workspace',
    ...draft,
    tools: { mode: 'explicit-catalog', ...draft.tools },
    onboarded: currentOnboarded ?? { at: new Date().toISOString(), by: source },
  };
  state.manifests.set(root, manifest);
  state.manifestRevisions.set(root, (state.manifestRevisions.get(root) ?? 0) + 1);
  if (instruction) {
    state.instructions.set(root, instruction.contents);
    state.instructionRevisions.set(root, (state.instructionRevisions.get(root) ?? 0) + 1);
  }
  return { saved: true, manifest, review: getDevWorkspaceManifest(state, root).review };
}

export function previewDevWorkspaceOnboarding(root: string, payload: unknown): Record<string, unknown> {
  const draft = parseOnboardingDraft(payload);
  if (!draft || !WORKSPACE_PROFILES.some((profile) => profile.id === draft.profile)) {
    return { ok: false, error: 'Workspace setup preview is unavailable.' };
  }
  return { ok: true, preview: buildDevOnboardingPreview(draft) };
}

/** Browser-development mirror of the read-only, stale-safe preview query. */
export function previewDevWorkspaceInstruction(
  state: DevOnboardingState,
  root: string,
  payload: unknown,
): Record<string, unknown> {
  if (!isRecord(payload) || !hasExactKeys(payload, ['expected', 'instruction'])) {
    return { ok: false, error: 'Workspace instruction preview contains unsafe, oversized, or malformed content.' };
  }
  if (!sameRevision(payload.expected, revision(state, root))) {
    return {
      ok: false,
      stale: true,
      error: 'Workspace setup changed while the instruction was being reviewed.',
    };
  }
  const instruction = parseInstruction(payload.instruction);
  if (!instruction) {
    return { ok: false, error: 'Workspace instruction preview contains unsafe, oversized, or malformed content.' };
  }
  const original = state.instructions.get(root) ?? '';
  return {
    ok: true,
    path: 'AGENT.md',
    existed: state.instructions.has(root),
    original,
    proposed: instruction.contents,
    originalBytes: new TextEncoder().encode(original).length,
    proposedBytes: new TextEncoder().encode(instruction.contents).length,
  };
}

function revision(state: DevOnboardingState, root: string): Record<string, string> {
  return {
    root: rootDigest(root),
    manifest: counterDigest(state.manifestRevisions.get(root) ?? 0),
    instruction: counterDigest(state.instructionRevisions.get(root) ?? 0),
  };
}

function sameRevision(value: unknown, expected: Record<string, string>): boolean {
  return isRecord(value) && hasExactKeys(value, ['root', 'manifest', 'instruction']) &&
    value.root === expected.root && value.manifest === expected.manifest &&
    value.instruction === expected.instruction;
}

function parseInstruction(value: unknown): { path: 'AGENT.md'; contents: string } | null {
  if (!isRecord(value) || !hasExactKeys(value, ['path', 'contents']) ||
      value.path !== 'AGENT.md' || typeof value.contents !== 'string') return null;
  const bytes = new TextEncoder().encode(value.contents).length;
  if (bytes < 1 || bytes > DEV_MAX_INSTRUCTION_BYTES) return null;
  return { path: 'AGENT.md', contents: value.contents };
}

function rootDigest(root: string): string {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(root)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(8);
}

function counterDigest(value: number): string {
  return value.toString(16).padStart(64, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
