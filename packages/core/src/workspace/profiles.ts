/**
 * Workspace profile presets (ADR-021 W1).
 *
 * A profile answers "what KIND of project is this workspace?" and preselects a
 * domain persona, task-time capabilities, skill packs, starter skills, tool
 * groups, and memory tags for onboarding. Presets are STARTING POINTS, not
 * silos — everything a preset fills into the manifest stays user-editable
 * afterwards, and `custom` starts empty so nothing is imposed.
 *
 * Domain personas named here sit ABOVE the orchestration harness roles
 * (architect/explorer/reviewer/verifier/worker): they shape briefing, default
 * skills, and tool posture, never the orchestration tiers.
 */

export type WorkspaceProfileId =
  | 'engineering'
  | 'research'
  | 'data-science'
  | 'study'
  | 'writing'
  | 'custom';

export interface WorkspaceProfilePreset {
  id: WorkspaceProfileId;
  label: string;
  description: string;
  /** Default domain persona id + the personas surfaced for this profile. */
  persona: { default: string; enabled: string[] };
  /** Roles the runtime may expose; availability never means invocation. */
  orchestration: {
    mode: 'off' | 'explicit' | 'adaptive';
    availableRoles: string[];
    disabledRoles: string[];
    maxParallel: number;
  };
  /** @deprecated Manifest-v1/client compatibility alias for `persona`. */
  agents: { default: string; enabled: string[] };
  /**
   * Optional task capabilities exposed by this profile.
   *
   * `available` is the compatibility ceiling; `recommended` is the default
   * manifest selection. The deprecated `enabled` alias stays wire-compatible
   * with 0.4.17 onboarding clients and always mirrors `recommended`.
   */
  capabilities: { available: string[]; recommended: string[]; enabled: string[] };
  /** Skill packs (plugin-delivered) + individual starter skills to enable. */
  skills: { packs: string[]; enabled: string[] };
  /** Tool GROUPS (mapped onto extension gating), not individual tool names. */
  tools: { profiles: string[] };
  /** Tags added to memory capture + a hint for what capture should favor. */
  memory: { tags: string[]; captureHint: string };
}

/** Ordered for display: the common cases first, `custom` always last. */
export const WORKSPACE_PROFILES: readonly WorkspaceProfilePreset[] = [
  {
    id: 'engineering',
    label: 'Engineering',
    description: 'Building and maintaining software — code, tests, reviews, releases. Frontend and backend expertise activates as task-specific capabilities when needed.',
    persona: { default: 'engineer', enabled: ['engineer'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'architect', 'worker', 'reviewer', 'verifier'],
      disabledRoles: ['fleet'],
      maxParallel: 4,
    },
    agents: { default: 'engineer', enabled: ['engineer'] },
    capabilities: {
      available: ['frontend', 'backend'],
      recommended: ['frontend', 'backend'],
      enabled: ['frontend', 'backend'],
    },
    skills: {
      packs: ['engineering'],
      enabled: [
        'planning-skill',
        'spec-driven-skill',
        'adr-skill',
        'debugging-and-error-recovery',
        'testing-skill',
        'conventions-skill',
        'code-review-and-quality',
        'incremental-skill',
        'shipping-skill',
        'changelog-generator',
        'verify-loop',
      ],
    },
    tools: {
      profiles: [
        'coding',
        'shell',
        'browser',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'orchestration',
        'pull-request-observation',
      ],
    },
    memory: { tags: ['engineering'], captureHint: 'code' },
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Evidence gathering and synthesis — sources, citations, findings.',
    persona: { default: 'researcher', enabled: ['researcher'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 3,
    },
    agents: { default: 'researcher', enabled: ['researcher'] },
    capabilities: { available: [], recommended: [], enabled: [] },
    skills: { packs: ['research'], enabled: ['planning-skill', 'handover-skill'] },
    tools: {
      profiles: [
        'workspace-files', 'browser', 'project-knowledge', 'memory-context', 'research-notes',
        'artifacts', 'planning-session', 'orchestration',
      ],
    },
    memory: { tags: ['research'], captureHint: 'sources' },
  },
  {
    id: 'data-science',
    label: 'Data science',
    description: 'Datasets, experiments, notebooks, and visual reporting.',
    persona: { default: 'data-scientist', enabled: ['data-scientist'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'worker', 'verifier'],
      disabledRoles: ['fleet'],
      maxParallel: 4,
    },
    agents: { default: 'data-scientist', enabled: ['data-scientist'] },
    capabilities: { available: [], recommended: [], enabled: [] },
    skills: { packs: ['data'], enabled: ['planning-skill', 'testing-skill', 'verify-loop'] },
    tools: {
      profiles: [
        'coding', 'shell', 'browser', 'project-knowledge', 'memory-context', 'research-notes',
        'artifacts', 'planning-session', 'orchestration',
      ],
    },
    memory: { tags: ['data-science'], captureHint: 'experiments' },
  },
  {
    id: 'study',
    label: 'Study',
    description: 'Learning a subject — tutoring, practice, and progress over time.',
    persona: { default: 'tutor', enabled: ['tutor'] },
    orchestration: {
      mode: 'explicit',
      availableRoles: ['explorer'],
      disabledRoles: ['fleet'],
      maxParallel: 2,
    },
    agents: { default: 'tutor', enabled: ['tutor'] },
    capabilities: { available: [], recommended: [], enabled: [] },
    skills: { packs: ['study'], enabled: ['planning-skill', 'handover-skill'] },
    tools: {
      profiles: [
        'workspace-files', 'browser', 'project-knowledge', 'memory-context',
        'research-notes', 'artifacts', 'planning-session', 'orchestration',
      ],
    },
    memory: { tags: ['study'], captureHint: 'learning' },
  },
  {
    id: 'writing',
    label: 'Writing',
    description: 'Long-form writing — outline, draft, revise, and style passes.',
    persona: { default: 'writer', enabled: ['writer'] },
    orchestration: {
      mode: 'explicit',
      availableRoles: ['reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 2,
    },
    agents: { default: 'writer', enabled: ['writer'] },
    capabilities: { available: [], recommended: [], enabled: [] },
    skills: { packs: ['writing'], enabled: ['planning-skill', 'handover-skill'] },
    tools: {
      profiles: [
        'workspace-files', 'browser', 'project-knowledge', 'memory-context',
        'research-notes', 'artifacts', 'planning-session', 'orchestration',
      ],
    },
    memory: { tags: ['writing'], captureHint: 'drafts' },
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Start empty and pick agents, skills, and tools yourself.',
    persona: { default: '', enabled: [] },
    orchestration: {
      mode: 'off',
      availableRoles: [],
      disabledRoles: [],
      maxParallel: 1,
    },
    agents: { default: '', enabled: [] },
    capabilities: {
      available: ['frontend', 'backend'],
      recommended: [],
      enabled: [],
    },
    skills: { packs: [], enabled: [] },
    tools: { profiles: [] },
    memory: { tags: [], captureHint: '' },
  },
];

const PROFILE_BY_ID = new Map(WORKSPACE_PROFILES.map((preset) => [preset.id, preset]));

export function getWorkspaceProfile(id: string): WorkspaceProfilePreset | undefined {
  return PROFILE_BY_ID.get(id as WorkspaceProfileId);
}

export function isWorkspaceProfileId(id: string): id is WorkspaceProfileId {
  return PROFILE_BY_ID.has(id as WorkspaceProfileId);
}
