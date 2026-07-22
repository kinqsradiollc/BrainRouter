/** Browser-development mirror of the reviewed onboarding host contract. */
import { WORKSPACE_PROFILES } from '@kinqs/brainrouter-core/dist/workspace/profiles.js';
import { parseOnboardingDraft } from '../components/dialogs/onboardingEditorModel.js';

// Keep the browser-development mock aligned with the core reviewed-proposal
// boundary without pulling the Node-oriented proposal parser into the bundle.
const DEV_MAX_INSTRUCTION_BYTES = 64 * 1024;

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
      tools: { ...profile.tools, deny: [] },
    })),
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

export function saveDevWorkspaceManifest(
  state: DevOnboardingState,
  root: string,
  payload: unknown,
): Record<string, unknown> {
  if (!isRecord(payload) || !sameRevision(payload.expected, revision(state, root))) {
    return { saved: false, stale: true, error: 'Workspace setup changed while it was open.' };
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
    version: 1,
    name: root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'workspace',
    ...draft,
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

function revision(state: DevOnboardingState, root: string): Record<string, string> {
  return {
    root: rootDigest(root),
    manifest: counterDigest(state.manifestRevisions.get(root) ?? 0),
    instruction: counterDigest(state.instructionRevisions.get(root) ?? 0),
  };
}

function sameRevision(value: unknown, expected: Record<string, string>): boolean {
  return isRecord(value) && value.root === expected.root && value.manifest === expected.manifest &&
    value.instruction === expected.instruction;
}

function parseInstruction(value: unknown): { path: 'AGENT.md'; contents: string } | null {
  if (!isRecord(value) || value.path !== 'AGENT.md' || typeof value.contents !== 'string') return null;
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
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
