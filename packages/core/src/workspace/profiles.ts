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
  agents: { default: string; enabled: string[] };
  /** Optional capability sets available for task-scoped activation. */
  capabilities: { enabled: string[] };
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
    description: 'Building and maintaining software — code, tests, reviews, releases. Frontend and design work activates additional engineering capabilities when needed.',
    agents: { default: 'engineer', enabled: ['engineer'] },
    capabilities: { enabled: ['frontend'] },
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
    tools: { profiles: ['coding', 'terminal', 'browser'] },
    memory: { tags: ['engineering'], captureHint: 'code' },
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Evidence gathering and synthesis — sources, citations, findings.',
    agents: { default: 'researcher', enabled: ['researcher'] },
    capabilities: { enabled: [] },
    skills: { packs: ['research'], enabled: ['planning-skill', 'handover-skill'] },
    tools: { profiles: ['browser', 'notes'] },
    memory: { tags: ['research'], captureHint: 'sources' },
  },
  {
    id: 'data-science',
    label: 'Data science',
    description: 'Datasets, experiments, notebooks, and visual reporting.',
    agents: { default: 'data-scientist', enabled: ['data-scientist'] },
    capabilities: { enabled: [] },
    skills: { packs: ['data'], enabled: ['planning-skill', 'testing-skill', 'verify-loop'] },
    tools: { profiles: ['coding', 'terminal', 'browser'] },
    memory: { tags: ['data-science'], captureHint: 'experiments' },
  },
  {
    id: 'study',
    label: 'Study',
    description: 'Learning a subject — tutoring, practice, and progress over time.',
    agents: { default: 'tutor', enabled: ['tutor'] },
    capabilities: { enabled: [] },
    skills: { packs: ['study'], enabled: ['planning-skill', 'handover-skill'] },
    tools: { profiles: ['browser', 'notes'] },
    memory: { tags: ['study'], captureHint: 'learning' },
  },
  {
    id: 'writing',
    label: 'Writing',
    description: 'Long-form writing — outline, draft, revise, and style passes.',
    agents: { default: 'writer', enabled: ['writer'] },
    capabilities: { enabled: [] },
    skills: { packs: ['writing'], enabled: ['planning-skill', 'handover-skill'] },
    tools: { profiles: ['notes', 'browser'] },
    memory: { tags: ['writing'], captureHint: 'drafts' },
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Start empty and pick agents, skills, and tools yourself.',
    agents: { default: '', enabled: [] },
    capabilities: { enabled: [] },
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
