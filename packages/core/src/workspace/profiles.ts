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
 *
 * ENGINEERING IS DELIBERATELY ONE PROFILE. Frontend, backend, and technical
 * writing are task-time CAPABILITIES inside it, not separate profiles. Splitting
 * them would force someone to choose a lane at workspace-creation time and then
 * re-onboard when a task crosses it — which is most tasks. Breadth of DOMAIN
 * (is this a legal workspace or a marketing one?) is what a profile answers;
 * breadth of SPECIALISM within a domain is what capabilities answer. There is a
 * test asserting no `frontend`/`backend` profile is ever added.
 *
 * The domain-facing profiles below carry an important asymmetry: `finance`,
 * `legal`, and `healthcare` describe work ADJACENT to regulated professions.
 * Their personas state plainly that they do not give professional advice. That
 * belongs in the persona rather than in a UI disclaimer, because the persona is
 * what actually reaches the model.
 */

export type WorkspaceProfileId =
  | 'engineering'
  | 'product-management'
  | 'design'
  | 'research'
  | 'data-science'
  | 'study'
  | 'education'
  | 'writing'
  | 'marketing'
  | 'sales'
  | 'operations'
  | 'finance'
  | 'legal'
  | 'people'
  | 'healthcare'
  | 'consulting'
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
      available: ['frontend', 'backend', 'technical-documentation'],
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
    capabilities: {
      available: ['computational-research'],
      recommended: [],
      enabled: [],
    },
    skills: { packs: ['research'], enabled: ['planning-skill', 'handover-skill'] },
    tools: {
      profiles: [
        'workspace-files', 'browser', 'research-browser', 'project-knowledge',
        'memory-context', 'research-notes', 'artifacts', 'planning-session',
        'orchestration',
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
    capabilities: {
      available: ['computational-research', 'data-visualization'],
      recommended: [],
      enabled: [],
    },
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
    capabilities: {
      available: ['programming-lab'],
      recommended: [],
      enabled: [],
    },
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
    capabilities: {
      available: ['academic-paper', 'technical-documentation'],
      recommended: [],
      enabled: [],
    },
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
    id: 'product-management',
    label: 'Product management',
    description: 'Scoping problems, writing specs, and deciding what ships — outcomes over feature lists.',
    persona: { default: 'product-manager', enabled: ['product-manager'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'architect', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 3,
    },
    agents: { default: 'product-manager', enabled: ['product-manager'] },
    capabilities: {
      available: ['technical-documentation'],
      recommended: [],
      enabled: [],
    },
    skills: {
      packs: ['product'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'spec-driven-skill',
        'idea-refine-skill',
        'concerns-skill',
        'output-skill',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
        'orchestration',
      ],
    },
    memory: { tags: ['product'], captureHint: 'decisions' },
  },
  {
    id: 'design',
    label: 'Design',
    description: 'Interface and experience work — user tasks, constraints, and accessible outcomes.',
    persona: { default: 'designer', enabled: ['designer'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 3,
    },
    agents: { default: 'designer', enabled: ['designer'] },
    capabilities: {
      available: ['frontend'],
      recommended: [],
      enabled: [],
    },
    // ADR-056 D-B4 — one visual-craft skill. `hallmark` rides the frontend
    // capability (ADR-031); the former style skills are worlds it routes to, so
    // the profile lists none of them.
    skills: {
      packs: ['design'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'a11y-skill',
        'concept-diagrams',
        'output-skill',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
        'artifacts',
      ],
    },
    memory: { tags: ['design'], captureHint: 'artifacts' },
  },
  {
    id: 'education',
    label: 'Education',
    description: 'Teaching others — curriculum, explanation, and assessment design. For studying yourself, use Study.',
    persona: { default: 'educator', enabled: ['educator'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 3,
    },
    agents: { default: 'educator', enabled: ['educator'] },
    capabilities: {
      available: [],
      recommended: [],
      enabled: [],
    },
    skills: {
      packs: ['education'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'interview-skill',
        'concept-diagrams',
        'output-skill',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
      ],
    },
    memory: { tags: ['education'], captureHint: 'explanations' },
  },
  {
    id: 'marketing',
    label: 'Marketing',
    description: 'Positioning, campaigns, and content grounded in a specific audience and substantiated claims.',
    persona: { default: 'marketer', enabled: ['marketer'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 3,
    },
    agents: { default: 'marketer', enabled: ['marketer'] },
    capabilities: {
      available: [],
      recommended: [],
      enabled: [],
    },
    skills: {
      packs: ['marketing'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'output-skill',
        'idea-refine-skill',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
      ],
    },
    memory: { tags: ['marketing'], captureHint: 'decisions' },
  },
  {
    id: 'sales',
    label: 'Sales',
    description: 'Pipeline and deals worked from the buyer decision process rather than seller stages.',
    persona: { default: 'sales-strategist', enabled: ['sales-strategist'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer'],
      disabledRoles: ['fleet'],
      maxParallel: 2,
    },
    agents: { default: 'sales-strategist', enabled: ['sales-strategist'] },
    capabilities: {
      available: [],
      recommended: [],
      enabled: [],
    },
    skills: {
      packs: ['sales'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'output-skill',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
      ],
    },
    memory: { tags: ['sales'], captureHint: 'decisions' },
  },
  {
    id: 'operations',
    label: 'Operations',
    description: 'Process design and improvement — how work actually runs, and where it breaks.',
    persona: { default: 'operations-lead', enabled: ['operations-lead'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'architect', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 3,
    },
    agents: { default: 'operations-lead', enabled: ['operations-lead'] },
    capabilities: {
      available: [],
      recommended: [],
      enabled: [],
    },
    skills: {
      packs: ['operations'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'concerns-skill',
        'incremental-skill',
        'output-skill',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
        'orchestration',
      ],
    },
    memory: { tags: ['operations'], captureHint: 'decisions' },
  },
  {
    id: 'finance',
    label: 'Finance',
    description: 'Financial modelling and analysis with stated assumptions. Not licensed financial advice.',
    persona: { default: 'financial-analyst', enabled: ['financial-analyst'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'verifier'],
      disabledRoles: ['fleet'],
      maxParallel: 2,
    },
    agents: { default: 'financial-analyst', enabled: ['financial-analyst'] },
    capabilities: {
      available: ['computational-research'],
      recommended: [],
      enabled: [],
    },
    skills: {
      packs: ['finance'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'verify-loop',
        'output-skill',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
      ],
    },
    memory: { tags: ['finance'], captureHint: 'evidence' },
  },
  {
    id: 'legal',
    label: 'Legal',
    description: 'Contracts, obligations, and legal material. Organises and summarises; not legal advice.',
    persona: { default: 'legal-analyst', enabled: ['legal-analyst'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 2,
    },
    agents: { default: 'legal-analyst', enabled: ['legal-analyst'] },
    capabilities: {
      available: [],
      recommended: [],
      enabled: [],
    },
    skills: {
      packs: ['legal'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'source-driven-skill',
        'concerns-skill',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
      ],
    },
    memory: { tags: ['legal'], captureHint: 'evidence' },
  },
  {
    id: 'people',
    label: 'People',
    description: 'Hiring, performance, and workplace matters — fairness and confidentiality first.',
    persona: { default: 'people-partner', enabled: ['people-partner'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 2,
    },
    agents: { default: 'people-partner', enabled: ['people-partner'] },
    capabilities: {
      available: [],
      recommended: [],
      enabled: [],
    },
    skills: {
      packs: ['people'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'interview-skill',
        'output-skill',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
      ],
    },
    memory: { tags: ['people'], captureHint: 'decisions' },
  },
  {
    id: 'healthcare',
    label: 'Healthcare',
    description: 'Health information and literature. Evidence-first; not medical advice or diagnosis.',
    persona: { default: 'clinical-analyst', enabled: ['clinical-analyst'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'verifier'],
      disabledRoles: ['fleet'],
      maxParallel: 2,
    },
    agents: { default: 'clinical-analyst', enabled: ['clinical-analyst'] },
    capabilities: {
      available: ['computational-research'],
      recommended: [],
      enabled: [],
    },
    skills: {
      packs: ['healthcare'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'source-driven-skill',
        'verify-loop',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
      ],
    },
    memory: { tags: ['healthcare'], captureHint: 'evidence' },
  },
  {
    id: 'consulting',
    label: 'Consulting',
    description: 'Client problem diagnosis and structured recommendation, keeping findings separate from advice.',
    persona: { default: 'consultant', enabled: ['consultant'] },
    orchestration: {
      mode: 'adaptive',
      availableRoles: ['explorer', 'architect', 'reviewer'],
      disabledRoles: ['fleet'],
      maxParallel: 3,
    },
    agents: { default: 'consultant', enabled: ['consultant'] },
    capabilities: {
      available: ['technical-documentation'],
      recommended: [],
      enabled: [],
    },
    skills: {
      packs: ['consulting'],
      enabled: [
        'planning-skill',
        'handover-skill',
        'doubt-driven-skill',
        'concerns-skill',
        'output-skill',
      ],
    },
    tools: {
      profiles: [
        'workspace-files',
        'project-knowledge',
        'memory-context',
        'artifacts',
        'planning-session',
        'browser',
        'orchestration',
      ],
    },
    memory: { tags: ['consulting'], captureHint: 'decisions' },
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
      available: [
        'frontend',
        'backend',
        'academic-paper',
        'computational-research',
        'data-visualization',
        'programming-lab',
        'technical-documentation',
      ],
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
