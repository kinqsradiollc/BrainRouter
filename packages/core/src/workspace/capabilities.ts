/**
 * Task-scoped workspace capability resolution (ADR-021 W4).
 *
 * Profiles declare which optional capabilities are available, while this pure
 * resolver activates their additive skill/tool/prompt contributions only when
 * current task or file signals justify them. A missing manifest is an exact
 * no-op so onboarding cannot change legacy workspace behavior implicitly.
 * Unknown capability ids remain forward-compatible manifest data but do not
 * activate until this runtime knows their contract. Explicit disables always
 * win over enabled values and detected signals.
 */
import type { WorkspaceManifest } from './manifest.js';
import { getWorkspaceProfile } from './profiles.js';

export interface WorkspaceCapabilityResolutionInput {
  manifest: Pick<WorkspaceManifest, 'profile' | 'persona' | 'capabilities'> | null | undefined;
  /** Current user task or requirement text. */
  task?: string;
  /** Files currently in scope for the task, expressed relative or absolute. */
  files?: readonly string[];
  /** Domain agent running this task; defaults to the manifest's soft default. */
  activeAgent?: string;
  /** Live catalog snapshot; omitted entries cannot be contributed to this turn. */
  availability?: WorkspaceCapabilityAvailability;
}

export interface WorkspaceCapabilityAvailability {
  skillPacks?: readonly string[];
  skills?: readonly string[];
  toolProfiles?: readonly string[];
}

export interface WorkspaceCapabilityResolution {
  active: string[];
  reasons: string[];
  skillPacks: string[];
  skills: string[];
  toolProfiles: string[];
  promptBlocks: string[];
}

interface CapabilityContribution {
  skillPacks: readonly string[];
  skills: readonly string[];
  toolProfiles: readonly string[];
  promptBlocks: readonly string[];
}

export interface WorkspaceCapabilityDefinition {
  id:
    | 'frontend'
    | 'backend'
    | 'academic-paper'
    | 'computational-research'
    | 'data-visualization'
    | 'programming-lab'
    | 'technical-documentation';
  label: string;
  description: string;
  skillPackId: string;
  skillIds: readonly string[];
  toolProfileIds: readonly string[];
}

/** Prompt-free metadata safe for onboarding catalog projection. */
export const WORKSPACE_CAPABILITY_DEFINITIONS: readonly WorkspaceCapabilityDefinition[] = [
  {
    id: 'frontend',
    label: 'Frontend',
    description: 'Task-time UI, visual design, accessibility, design-system, responsive, and browser-visual expertise for the engineer persona.',
    skillPackId: 'frontend',
    // ADR-031 D1 — `hallmark` is the vendored design skill. It rides the frontend
    // CAPABILITY rather than a profile, so it is on by default in `engineering`
    // and available-but-off in `design`, and it comes from the shipped skill
    // library rather than this pack's own files (profilePlugins.ts
    // `librarySkillIds`). Keep this list and that one in agreement — a test does.
    skillIds: ['a11y-skill', 'browser-testing-skill', 'taste-skill', 'hallmark'],
    toolProfileIds: ['browser', 'artifacts', 'interactive-browser'],
  },
  {
    id: 'backend',
    label: 'Backend',
    description: 'Task-time service, authorization, data-integrity, background-work, production, and backend-test expertise for the engineer persona.',
    skillPackId: 'backend',
    skillIds: [
      'api-service-design-skill',
      'authorization-boundary-skill',
      'data-integrity-migration-skill',
      'background-work-skill',
      'production-readiness-skill',
      'backend-testing-skill',
    ],
    toolProfileIds: ['coding', 'shell', 'artifacts'],
  },
  {
    id: 'academic-paper',
    label: 'Academic paper',
    description: 'Task-time claim-evidence, citation, drafting, and adversarial paper-review workflows for the writer persona.',
    skillPackId: 'academic-paper',
    skillIds: [
      'source-synthesis-skill',
      'citation-verification-skill',
      'academic-paper-drafting-skill',
      'academic-paper-review-skill',
    ],
    toolProfileIds: [
      'workspace-files',
      'browser',
      'research-browser',
      'research-notes',
      'artifacts',
    ],
  },
  {
    id: 'computational-research',
    label: 'Computational research',
    description: 'Task-time reproducible analysis, experiment, validation, uncertainty, and limitation workflows.',
    skillPackId: 'computational-research',
    skillIds: ['data-analysis-skill', 'experiment-validation-skill'],
    toolProfileIds: ['coding', 'shell', 'browser', 'research-notes', 'artifacts'],
  },
  {
    id: 'data-visualization',
    label: 'Data visualization',
    description: 'Task-time chart, dashboard, figure, visual-integrity, accessibility, and interactive-verification workflow.',
    skillPackId: 'data-visualization',
    skillIds: ['data-visualization-skill'],
    toolProfileIds: ['coding', 'shell', 'artifacts', 'interactive-browser'],
  },
  {
    id: 'programming-lab',
    label: 'Programming lab',
    description: 'Task-time coding exercises, executable feedback, progressive hints, debugging, tests, and transfer checks.',
    skillPackId: 'programming-lab',
    skillIds: ['programming-lab-skill'],
    toolProfileIds: ['coding', 'shell', 'artifacts'],
  },
  {
    id: 'technical-documentation',
    label: 'Technical documentation',
    description: 'Task-time repository-grounded references, guides, tutorials, runbooks, runnable examples, and documentation verification.',
    skillPackId: 'technical-documentation',
    skillIds: ['technical-documentation-skill'],
    toolProfileIds: ['workspace-files', 'shell', 'browser', 'artifacts'],
  },
] as const;

const CAPABILITY_BY_ID = new Map(
  WORKSPACE_CAPABILITY_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const FRONTEND_DEFINITION = CAPABILITY_BY_ID.get('frontend')!;
const BACKEND_DEFINITION = CAPABILITY_BY_ID.get('backend')!;
const ACADEMIC_PAPER_DEFINITION = CAPABILITY_BY_ID.get('academic-paper')!;
const COMPUTATIONAL_RESEARCH_DEFINITION = CAPABILITY_BY_ID.get('computational-research')!;
const DATA_VISUALIZATION_DEFINITION = CAPABILITY_BY_ID.get('data-visualization')!;
const PROGRAMMING_LAB_DEFINITION = CAPABILITY_BY_ID.get('programming-lab')!;
const TECHNICAL_DOCUMENTATION_DEFINITION = CAPABILITY_BY_ID.get('technical-documentation')!;

const FRONTEND_CONTRIBUTION: CapabilityContribution = {
  skillPacks: [FRONTEND_DEFINITION.skillPackId],
  skills: FRONTEND_DEFINITION.skillIds,
  toolProfiles: FRONTEND_DEFINITION.toolProfileIds,
  promptBlocks: [
    'Frontend engineering capability is active for this task. Stay in the engineer persona, discover and follow the workspace design artifact, reuse its component system, preserve established product UX, treat accessibility and responsive behavior as acceptance criteria, and visually verify user-facing changes.',
  ],
};

const BACKEND_CONTRIBUTION: CapabilityContribution = {
  skillPacks: [BACKEND_DEFINITION.skillPackId],
  skills: BACKEND_DEFINITION.skillIds,
  toolProfiles: BACKEND_DEFINITION.toolProfileIds,
  promptBlocks: [
    'Backend engineering capability is active for this task. Stay in the engineer persona, preserve service and data contracts, validate every trust boundary, make concurrency and failure behavior explicit, prefer reversible migrations and idempotent operations, and verify production-relevant failure paths. This capability does not itself grant shell, network, database, or write access.',
  ],
};

const ACADEMIC_PAPER_CONTRIBUTION: CapabilityContribution = {
  skillPacks: [ACADEMIC_PAPER_DEFINITION.skillPackId],
  skills: ACADEMIC_PAPER_DEFINITION.skillIds,
  toolProfiles: ACADEMIC_PAPER_DEFINITION.toolProfileIds,
  promptBlocks: [
    'Academic paper capability is active for this task. Stay in the writer persona, preserve the reviewed evidence boundary, maintain an explicit claim-evidence map, resolve and verify material citations, separate drafting from adversarial review, and never invent evidence, methods, results, citations, or numerical values. This capability does not itself grant file, network, or artifact authority.',
  ],
};

const COMPUTATIONAL_RESEARCH_CONTRIBUTION: CapabilityContribution = {
  skillPacks: [COMPUTATIONAL_RESEARCH_DEFINITION.skillPackId],
  skills: COMPUTATIONAL_RESEARCH_DEFINITION.skillIds,
  toolProfiles: COMPUTATIONAL_RESEARCH_DEFINITION.toolProfileIds,
  promptBlocks: [
    'Computational research capability is active for this task. Preserve the active domain persona, state a measurable question and hypotheses, record data lineage and transformations, use reproducible environments and seeds, validate results independently, report effect size and uncertainty, and keep limitations and unsupported claims visible. This capability does not itself grant shell, notebook, file, network, or artifact authority.',
  ],
};

const DATA_VISUALIZATION_CONTRIBUTION: CapabilityContribution = {
  skillPacks: [DATA_VISUALIZATION_DEFINITION.skillPackId],
  skills: DATA_VISUALIZATION_DEFINITION.skillIds,
  toolProfiles: DATA_VISUALIZATION_DEFINITION.toolProfileIds,
  promptBlocks: [
    'Data visualization capability is active for this task. Stay in the data-scientist persona, define the audience and decision, verify data lineage and transformations, choose an encoding that preserves the comparison, disclose scales, normalization, missingness, and uncertainty, provide accessible alternatives, and verify representative values and interactive states. This capability does not itself grant file, shell, notebook, browser, or artifact authority.',
  ],
};

const PROGRAMMING_LAB_CONTRIBUTION: CapabilityContribution = {
  skillPacks: [PROGRAMMING_LAB_DEFINITION.skillPackId],
  skills: PROGRAMMING_LAB_DEFINITION.skillIds,
  toolProfiles: PROGRAMMING_LAB_DEFINITION.toolProfileIds,
  promptBlocks: [
    'Programming lab capability is active for this task. Stay in the tutor persona, establish the learner level and objective, preserve learner ownership, isolate one concept at a time, use bounded execution and tests as feedback, escalate hints progressively, distinguish environment, syntax, logic, and conceptual errors, and finish with an explanation or transfer check. This capability does not itself grant file, shell, notebook, language-service, or artifact authority.',
  ],
};

const TECHNICAL_DOCUMENTATION_CONTRIBUTION: CapabilityContribution = {
  skillPacks: [TECHNICAL_DOCUMENTATION_DEFINITION.skillPackId],
  skills: TECHNICAL_DOCUMENTATION_DEFINITION.skillIds,
  toolProfiles: TECHNICAL_DOCUMENTATION_DEFINITION.toolProfileIds,
  promptBlocks: [
    'Technical documentation capability is active for this task. Preserve the active engineer or writer persona, define the audience and job, ground material claims in current code, schemas, tests, runtime evidence, or primary sources, distinguish implemented behavior from proposals, verify runnable examples, expose prerequisites, permissions, side effects, failure recovery, and version limits, and keep terminology consistent. This capability does not itself grant file, shell, network, or artifact authority.',
  ],
};

const KNOWN_WORKSPACE_CAPABILITY_IDS = WORKSPACE_CAPABILITY_DEFINITIONS.map(
  (definition) => definition.id,
);

const EMPTY_RESOLUTION: WorkspaceCapabilityResolution = {
  active: [],
  reasons: [],
  skillPacks: [],
  skills: [],
  toolProfiles: [],
  promptBlocks: [],
};

const FRONTEND_TASK_SIGNALS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(front[ -]?end|user interface|ui|ux|web(?:site|page|app)|landing page|dashboard)\b/i,
    reason: 'task describes user-interface work',
  },
  {
    pattern:
      /\b(accessibility|a11y|design system|css|html|tailwind|sass|scss|vue|svelte|angular)\b|\bresponsive (?:ui|layout|design|page|screen)\b/i,
    reason: 'task names a frontend implementation concern',
  },
  {
    pattern:
      /\b(screenshot|visual (?:design|regression|verification|qa|polish)|browser (?:ui|layout|rendering|visual|screenshot|test))\b/i,
    reason: 'task requires browser-visual verification',
  },
  {
    pattern: /\b(?:ui|web|react|vue|svelte|angular) (?:component|navigation|theme|modal|dialog|form|layout)\b/i,
    reason: 'task names a concrete frontend surface',
  },
  {
    pattern: /(?:^|[\s"'`(])[^\s"'`()]+\.(?:css|scss|sass|less|html?|jsx|tsx|vue|svelte)(?=$|[\s"'`,;:)]|\.(?:\s|$))/i,
    reason: 'task names a frontend source or presentation file',
  },
];

const FRONTEND_FILE_PATTERN =
  /\.(?:css|scss|sass|less|html?|jsx|tsx|vue|svelte)$|\.(?:component|stories)\.(?:js|ts)$/i;
const FRONTEND_CONFIG_PATTERN = /(?:^|\/)(?:(?:tailwind|postcss|vite|next|nuxt)\.config\.[^/]+|design\.md)$/i;

const BACKEND_TASK_SIGNALS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /\b(back[ -]?end|server(?:-side)?|api|endpoint|rest(?:ful)?|graphql|rpc|webhook|middleware|service layer|microservice)\b/i,
    reason: 'task describes server or API work',
  },
  {
    pattern:
      /\b(authentication|authorization|authn|authz|rbac|permission|database|sql|schema|migration|transaction|orm|repository layer|data repository)\b|\b(?:access|refresh|bearer|api) token\b|\bsession token\b(?!\s+budget)|\bsession (?:cookie|store|authentication)\b/i,
    reason: 'task names a backend trust or persistence concern',
  },
  {
    pattern:
      /\b(background job|queue|worker process|retry|idempotenc\w*|lease|cache|redis|docker|kubernetes|service latency|request latency|throughput|observability|distributed tracing|service metrics)\b/i,
    reason: 'task names backend concurrency, deployment, or operations work',
  },
];

const BACKEND_FILE_PATTERN =
  /(?:^|\/)(?:api|backend|server|services?|controllers?|routes?|repositories?|middleware|workers?|jobs?|queues?|migrations?|db|database)(?:\/|$)|\.(?:sql|prisma)$/i;
const BACKEND_CONFIG_PATTERN =
  /(?:^|\/)(?:dockerfile(?:\.[^/]+)?|docker-compose(?:\.[^/]+)?\.ya?ml|compose(?:\.[^/]+)?\.ya?ml|helm|k8s|kubernetes|terraform)(?:\/|$)/i;
const ACADEMIC_PAPER_TASK_PATTERN =
  /\b(academic paper|research paper|journal (?:article|submission)|conference paper|manuscript|preprint|literature review|systematic review|citation audit|claim[- ]evidence map)\b/i;
const ACADEMIC_PAPER_FILE_PATTERN = /\.(?:tex|bib|ris|enw|nbib)$/i;
const COMPUTATIONAL_RESEARCH_TASK_PATTERN =
  /\b(computational research|computational analysis|empirical analysis|reproducib(?:le|ility)|experiment(?:al)? analysis|statistical analysis|simulation|notebook analysis)\b/i;
const COMPUTATIONAL_RESEARCH_FILE_PATTERN =
  /\.(?:ipynb|rmd|qmd|sas|do|jl|r)$/i;
const DATA_VISUALIZATION_TASK_PATTERN =
  /\b(data visuali[sz]ation|visual analytics|interactive chart|analytical dashboard|data dashboard|chart design|chart audit|plotting|publication figure|statistical graphic)\b/i;
const DATA_VISUALIZATION_FILE_PATTERN =
  /(?:^|\/)(?:charts?|figures?|visuali[sz]ations?)(?:\/|$)|\.(?:vega|vl)\.json$|\.(?:pbix|twb|twbx)$/i;
const PROGRAMMING_LAB_TASK_PATTERN =
  /\b(programming lab|coding lab|coding exercise|programming exercise|code kata|learn (?:to )?(?:code|program)|debugging practice|test[- ]driven learning|guided coding)\b/i;
const PROGRAMMING_LAB_FILE_PATTERN =
  /\.(?:c|cc|cpp|cs|go|java|js|jsx|kt|kts|php|py|rb|rs|swift|ts|tsx)$/i;
const TECHNICAL_DOCUMENTATION_TASK_PATTERN =
  /\b(technical documentation|developer documentation|api documentation|api reference|developer guide|integration guide|technical tutorial|operational runbook|architecture documentation|documentation audit)\b/i;
const TECHNICAL_DOCUMENTATION_FILE_PATTERN =
  /(?:^|\/)(?:docs?|documentation|guides?|runbooks?)(?:\/|$)|(?:^|\/)(?:readme|contributing|architecture)\.(?:md|mdx)$|(?:^|\/)(?:openapi|asyncapi)\.(?:json|ya?ml)$/i;

/** Resolve additive capabilities for one task without reading disk or mutating the manifest. */
export function resolveWorkspaceCapabilities(input: WorkspaceCapabilityResolutionInput): WorkspaceCapabilityResolution {
  if (!input.manifest) return emptyResolution();

  const activeAgent = input.activeAgent ?? input.manifest.persona.default;
  const engineerIsActive = activeAgent === 'engineer' && input.manifest.persona.enabled.includes('engineer');
  const writerIsActive = activeAgent === 'writer' && input.manifest.persona.enabled.includes('writer');
  const computationalResearchPersonaIsActive =
    (activeAgent === 'researcher' || activeAgent === 'data-scientist')
    && input.manifest.persona.enabled.includes(activeAgent);
  const dataScientistIsActive =
    activeAgent === 'data-scientist' && input.manifest.persona.enabled.includes('data-scientist');
  const tutorIsActive =
    activeAgent === 'tutor' && input.manifest.persona.enabled.includes('tutor');
  const technicalDocumentationPersonaIsActive =
    (activeAgent === 'engineer' || activeAgent === 'writer')
    && input.manifest.persona.enabled.includes(activeAgent);
  const available = new Set(
    getWorkspaceProfile(input.manifest.profile)?.capabilities.available ?? [],
  );
  const disabled = new Set(input.manifest.capabilities.disabled);
  const enabled = new Set(input.manifest.capabilities.enabled.filter(
    (id) => available.has(id) && !disabled.has(id),
  ));
  const active: string[] = [];
  const reasons: string[] = [];
  const skillPacks: string[] = [];
  const skills: string[] = [];
  const toolProfiles: string[] = [];
  const promptBlocks: string[] = [];

  if (engineerIsActive && enabled.has('frontend')) {
    const frontendReasons = detectFrontendReasons(input.task, input.files);
    if (frontendReasons.length > 0) {
      active.push('frontend');
      reasons.push(...frontendReasons);
      appendAvailable(skillPacks, FRONTEND_CONTRIBUTION.skillPacks, input.availability?.skillPacks);
      appendAvailable(skills, FRONTEND_CONTRIBUTION.skills, input.availability?.skills);
      appendAvailable(toolProfiles, FRONTEND_CONTRIBUTION.toolProfiles, input.availability?.toolProfiles);
      appendUnique(promptBlocks, FRONTEND_CONTRIBUTION.promptBlocks);
    }
  }

  if (engineerIsActive && enabled.has('backend')) {
    const backendReasons = detectBackendReasons(input.task, input.files);
    if (backendReasons.length > 0) {
      active.push('backend');
      reasons.push(...backendReasons);
      appendAvailable(skillPacks, BACKEND_CONTRIBUTION.skillPacks, input.availability?.skillPacks);
      appendAvailable(skills, BACKEND_CONTRIBUTION.skills, input.availability?.skills);
      appendAvailable(toolProfiles, BACKEND_CONTRIBUTION.toolProfiles, input.availability?.toolProfiles);
      appendUnique(promptBlocks, BACKEND_CONTRIBUTION.promptBlocks);
    }
  }

  if (writerIsActive && enabled.has('academic-paper')) {
    const academicPaperReasons = detectAcademicPaperReasons(input.task, input.files);
    if (academicPaperReasons.length > 0) {
      active.push('academic-paper');
      reasons.push(...academicPaperReasons);
      appendAvailable(skillPacks, ACADEMIC_PAPER_CONTRIBUTION.skillPacks, input.availability?.skillPacks);
      appendAvailable(skills, ACADEMIC_PAPER_CONTRIBUTION.skills, input.availability?.skills);
      appendAvailable(toolProfiles, ACADEMIC_PAPER_CONTRIBUTION.toolProfiles, input.availability?.toolProfiles);
      appendUnique(promptBlocks, ACADEMIC_PAPER_CONTRIBUTION.promptBlocks);
    }
  }

  if (computationalResearchPersonaIsActive && enabled.has('computational-research')) {
    const computationalReasons = detectComputationalResearchReasons(input.task, input.files);
    if (computationalReasons.length > 0) {
      active.push('computational-research');
      reasons.push(...computationalReasons);
      appendAvailable(skillPacks, COMPUTATIONAL_RESEARCH_CONTRIBUTION.skillPacks, input.availability?.skillPacks);
      appendAvailable(skills, COMPUTATIONAL_RESEARCH_CONTRIBUTION.skills, input.availability?.skills);
      appendAvailable(toolProfiles, COMPUTATIONAL_RESEARCH_CONTRIBUTION.toolProfiles, input.availability?.toolProfiles);
      appendUnique(promptBlocks, COMPUTATIONAL_RESEARCH_CONTRIBUTION.promptBlocks);
    }
  }

  if (dataScientistIsActive && enabled.has('data-visualization')) {
    const visualizationReasons = detectDataVisualizationReasons(input.task, input.files);
    if (visualizationReasons.length > 0) {
      active.push('data-visualization');
      reasons.push(...visualizationReasons);
      appendAvailable(skillPacks, DATA_VISUALIZATION_CONTRIBUTION.skillPacks, input.availability?.skillPacks);
      appendAvailable(skills, DATA_VISUALIZATION_CONTRIBUTION.skills, input.availability?.skills);
      appendAvailable(toolProfiles, DATA_VISUALIZATION_CONTRIBUTION.toolProfiles, input.availability?.toolProfiles);
      appendUnique(promptBlocks, DATA_VISUALIZATION_CONTRIBUTION.promptBlocks);
    }
  }

  if (tutorIsActive && enabled.has('programming-lab')) {
    const programmingReasons = detectProgrammingLabReasons(input.task, input.files);
    if (programmingReasons.length > 0) {
      active.push('programming-lab');
      reasons.push(...programmingReasons);
      appendAvailable(skillPacks, PROGRAMMING_LAB_CONTRIBUTION.skillPacks, input.availability?.skillPacks);
      appendAvailable(skills, PROGRAMMING_LAB_CONTRIBUTION.skills, input.availability?.skills);
      appendAvailable(toolProfiles, PROGRAMMING_LAB_CONTRIBUTION.toolProfiles, input.availability?.toolProfiles);
      appendUnique(promptBlocks, PROGRAMMING_LAB_CONTRIBUTION.promptBlocks);
    }
  }

  if (technicalDocumentationPersonaIsActive && enabled.has('technical-documentation')) {
    const documentationReasons = detectTechnicalDocumentationReasons(input.task, input.files);
    if (documentationReasons.length > 0) {
      active.push('technical-documentation');
      reasons.push(...documentationReasons);
      appendAvailable(skillPacks, TECHNICAL_DOCUMENTATION_CONTRIBUTION.skillPacks, input.availability?.skillPacks);
      appendAvailable(skills, TECHNICAL_DOCUMENTATION_CONTRIBUTION.skills, input.availability?.skills);
      appendAvailable(toolProfiles, TECHNICAL_DOCUMENTATION_CONTRIBUTION.toolProfiles, input.availability?.toolProfiles);
      appendUnique(promptBlocks, TECHNICAL_DOCUMENTATION_CONTRIBUTION.promptBlocks);
    }
  }

  return { active, reasons, skillPacks, skills, toolProfiles, promptBlocks };
}

/** Capability ids this runtime can safely activate and brief. */
export function workspaceCapabilityIds(): string[] {
  return [...KNOWN_WORKSPACE_CAPABILITY_IDS];
}

function detectFrontendReasons(task: string | undefined, files: readonly string[] | undefined): string[] {
  const reasons: string[] = [];
  const taskText = task?.trim() ?? '';
  for (const signal of FRONTEND_TASK_SIGNALS) {
    if (signal.pattern.test(taskText)) appendUnique(reasons, [signal.reason]);
  }

  const normalizedFiles = (files ?? []).map((file) => file.replaceAll('\\', '/'));
  if (normalizedFiles.some((file) => FRONTEND_FILE_PATTERN.test(file))) {
    reasons.push('task includes a frontend source or presentation file');
  }
  if (normalizedFiles.some((file) => FRONTEND_CONFIG_PATTERN.test(file))) {
    reasons.push('task includes a frontend build or styling configuration');
  }
  return reasons;
}

function detectBackendReasons(task: string | undefined, files: readonly string[] | undefined): string[] {
  const reasons: string[] = [];
  const taskText = task?.trim() ?? '';
  for (const signal of BACKEND_TASK_SIGNALS) {
    if (signal.pattern.test(taskText)) appendUnique(reasons, [signal.reason]);
  }

  const normalizedFiles = (files ?? []).map((file) => file.replaceAll('\\', '/'));
  if (normalizedFiles.some((file) => BACKEND_FILE_PATTERN.test(file))) {
    reasons.push('task includes a backend service or persistence file');
  }
  if (normalizedFiles.some((file) => BACKEND_CONFIG_PATTERN.test(file))) {
    reasons.push('task includes backend deployment or operations configuration');
  }
  return reasons;
}

function detectAcademicPaperReasons(
  task: string | undefined,
  files: readonly string[] | undefined,
): string[] {
  const reasons: string[] = [];
  if (ACADEMIC_PAPER_TASK_PATTERN.test(task?.trim() ?? '')) {
    reasons.push('task describes academic-paper work');
  }
  const normalizedFiles = (files ?? []).map((file) => file.replaceAll('\\', '/'));
  if (normalizedFiles.some((file) => ACADEMIC_PAPER_FILE_PATTERN.test(file))) {
    reasons.push('task includes an academic manuscript or citation file');
  }
  return reasons;
}

function detectComputationalResearchReasons(
  task: string | undefined,
  files: readonly string[] | undefined,
): string[] {
  const reasons: string[] = [];
  if (COMPUTATIONAL_RESEARCH_TASK_PATTERN.test(task?.trim() ?? '')) {
    reasons.push('task describes computational research');
  }
  const normalizedFiles = (files ?? []).map((file) => file.replaceAll('\\', '/'));
  if (normalizedFiles.some((file) => COMPUTATIONAL_RESEARCH_FILE_PATTERN.test(file))) {
    reasons.push('task includes a computational research file');
  }
  return reasons;
}

function detectDataVisualizationReasons(
  task: string | undefined,
  files: readonly string[] | undefined,
): string[] {
  const reasons: string[] = [];
  if (DATA_VISUALIZATION_TASK_PATTERN.test(task?.trim() ?? '')) {
    reasons.push('task describes data-visualization work');
  }
  const normalizedFiles = (files ?? []).map((file) => file.replaceAll('\\', '/'));
  if (normalizedFiles.some((file) => DATA_VISUALIZATION_FILE_PATTERN.test(file))) {
    reasons.push('task includes a visualization artifact');
  }
  return reasons;
}

function detectProgrammingLabReasons(
  task: string | undefined,
  files: readonly string[] | undefined,
): string[] {
  const reasons: string[] = [];
  if (PROGRAMMING_LAB_TASK_PATTERN.test(task?.trim() ?? '')) {
    reasons.push('task describes a programming lab');
  }
  const normalizedFiles = (files ?? []).map((file) => file.replaceAll('\\', '/'));
  if (normalizedFiles.some((file) => PROGRAMMING_LAB_FILE_PATTERN.test(file))) {
    reasons.push('task includes a programming source file');
  }
  return reasons;
}

function detectTechnicalDocumentationReasons(
  task: string | undefined,
  files: readonly string[] | undefined,
): string[] {
  const reasons: string[] = [];
  if (TECHNICAL_DOCUMENTATION_TASK_PATTERN.test(task?.trim() ?? '')) {
    reasons.push('task describes technical-documentation work');
  }
  const normalizedFiles = (files ?? []).map((file) => file.replaceAll('\\', '/'));
  if (normalizedFiles.some((file) => TECHNICAL_DOCUMENTATION_FILE_PATTERN.test(file))) {
    reasons.push('task includes a technical-documentation artifact');
  }
  return reasons;
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function appendAvailable(target: string[], contributions: readonly string[], available: readonly string[] | undefined): void {
  if (!available) return;
  const live = new Set(available);
  appendUnique(target, contributions.filter((value) => live.has(value)));
}

function emptyResolution(): WorkspaceCapabilityResolution {
  return {
    active: [...EMPTY_RESOLUTION.active],
    reasons: [...EMPTY_RESOLUTION.reasons],
    skillPacks: [...EMPTY_RESOLUTION.skillPacks],
    skills: [...EMPTY_RESOLUTION.skills],
    toolProfiles: [...EMPTY_RESOLUTION.toolProfiles],
    promptBlocks: [...EMPTY_RESOLUTION.promptBlocks],
  };
}
