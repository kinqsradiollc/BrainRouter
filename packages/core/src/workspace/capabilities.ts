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

export interface WorkspaceCapabilityResolutionInput {
  manifest: Pick<WorkspaceManifest, 'agents' | 'capabilities'> | null | undefined;
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

const FRONTEND_CONTRIBUTION: CapabilityContribution = {
  skillPacks: ['frontend'],
  skills: ['a11y-skill', 'browser-testing-skill', 'taste-skill'],
  toolProfiles: ['browser', 'design'],
  promptBlocks: [
    'Frontend engineering capability is active for this task. Stay in the engineer persona, discover and follow the workspace design artifact, reuse its component system, preserve established product UX, treat accessibility and responsive behavior as acceptance criteria, and visually verify user-facing changes.',
  ],
};

const KNOWN_WORKSPACE_CAPABILITY_IDS = ['frontend'] as const;

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

/** Resolve additive capabilities for one task without reading disk or mutating the manifest. */
export function resolveWorkspaceCapabilities(input: WorkspaceCapabilityResolutionInput): WorkspaceCapabilityResolution {
  if (!input.manifest) return emptyResolution();

  const activeAgent = input.activeAgent ?? input.manifest.agents.default;
  const engineerIsActive = activeAgent === 'engineer' && input.manifest.agents.enabled.includes('engineer');
  const disabled = new Set(input.manifest.capabilities.disabled);
  const enabled = new Set(input.manifest.capabilities.enabled.filter((id) => !disabled.has(id)));
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
