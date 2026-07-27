/** Reviewed project onboarding for one CLI workspace. */
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { Config } from '@kinqs/brainrouter-core/config';
import {
  WORKSPACE_PROFILES,
  buildWorkspaceOnboardingPreview,
  buildWorkspaceOnboardingSources,
  buildWorkspaceSelectionCatalog,
  commitReviewedWorkspaceOnboarding,
  inspectWorkspaceOnboardingReview,
  isWorkspaceProfileId,
  loadWorkspaceManifest,
  suggestWorkspaceProfile,
  workspaceProfilesForOnboarding,
  workspaceManifestPath,
  type WorkspaceOnboardingPreview,
  type WorkspaceSelectionCatalog,
  type WorkspaceManifest,
  type WorkspaceOnboardSource,
  type WorkspaceProfileId,
} from '@kinqs/brainrouter-core/workspace';
import { runPicker, runTextField, type PickerRow } from '../../ink/prompt/runPicker.js';
import {
  createProjectOnboardingDraft,
  finalizeCatalogReviewedProjectOnboarding,
  parseProjectOnboardingList,
  type ProjectOnboardingFieldEdits,
} from './onboardingDraft.js';
import {
  formatPlanPreview,
  requestCatalogSelection,
} from './projectOnboardingCatalog.js';

type WorkspaceOrchestrationProfiles = Parameters<typeof buildWorkspaceOnboardingPreview>[2];

export { suggestWorkspaceProfile, type ProfileSuggestion } from '@kinqs/brainrouter-core/workspace';

export type ProjectOnboardingPromptId =
  | 'start'
  | 'profile'
  | 'persona-default'
  | 'personas-enabled'
  | 'orchestration-mode'
  | 'orchestration-available'
  | 'orchestration-disabled'
  | 'orchestration-max-parallel'
  | 'capabilities-enabled'
  | 'capabilities-disabled'
  | 'skill-packs'
  | 'skills-enabled'
  | 'skills-disabled'
  | 'tool-profiles'
  | 'tools-enabled'
  | 'tools-denied'
  | 'memory-tags'
  | 'memory-capture-hint'
  | 'instructions'
  | 'instruction-change'
  | 'confirm';

export interface ProjectOnboardingPromptRequest {
  id: ProjectOnboardingPromptId;
  kind: 'choice' | 'text';
  title: string;
  subtitle?: string;
  badge?: string;
  rows?: PickerRow[];
  initialChoice?: string;
  initialChoices?: string[];
  multiSelect?: boolean;
  allowEmptySelection?: boolean;
  initialValue?: string;
}

export type ProjectOnboardingPromptResponse =
  | { kind: 'submit'; value: string | string[] }
  | { kind: 'skip' }
  | { kind: 'cancel' };

export type ProjectOnboardingPrompt = (
  request: ProjectOnboardingPromptRequest,
) => Promise<ProjectOnboardingPromptResponse>;

export type ProjectOnboardingResult =
  | { status: 'committed'; manifest: WorkspaceManifest; manifestPath: string }
  | { status: 'existing'; manifest: WorkspaceManifest }
  | { status: 'skipped' }
  | { status: 'cancelled' };

export interface ProjectOnboardingOptions {
  edit?: boolean;
  source?: WorkspaceOnboardSource;
  prompt?: ProjectOnboardingPrompt;
  now?: () => string;
  print?: (message: string) => void;
  /** Host-owned plugin enablement snapshot; never derived from prompt input. */
  config?: Config;
  /** Production reload seam for the pre-write catalog drift check. */
  getConfig?: () => Config;
}

/** Parse a legacy numbered profile answer for compatibility with callers. */
export function resolveProfileAnswer(input: string, suggested: WorkspaceProfileId): WorkspaceProfileId | null {
  const answer = input.trim().toLowerCase();
  if (answer === '') return suggested;
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= WORKSPACE_PROFILES.length) {
    return WORKSPACE_PROFILES[index - 1].id;
  }
  const matches = WORKSPACE_PROFILES.filter(
    (preset) => preset.id === answer || preset.id.startsWith(answer) || preset.label.toLowerCase().startsWith(answer),
  );
  return matches.length === 1 ? matches[0].id : null;
}

/** Human summary used for existing workspaces and the final review screen. */
export function formatManifestSummary(
  manifest: WorkspaceManifest,
  preview: WorkspaceOnboardingPreview = buildWorkspaceOnboardingPreview(manifest),
): string {
  const lines = [
    `${chalk.bold('Workspace')}: ${manifest.name}  ${chalk.gray(`(profile: ${manifest.profile})`)}`,
    `  default persona: ${manifest.persona.default || chalk.gray('(none)')}`,
    `  enabled personas: ${formatList(manifest.persona.enabled)}`,
    `  orchestration: ${manifest.orchestration.mode}; available: ${formatList(manifest.orchestration.availableRoles)}${formatDisabled(manifest.orchestration.disabledRoles)}; max parallel: ${manifest.orchestration.maxParallel}`,
    `  capabilities: ${formatList(manifest.capabilities.enabled)}${formatDisabled(manifest.capabilities.disabled)}`,
    `  skill packs: ${formatList(manifest.skills.packs)}`,
    `  enabled skills: ${formatList(manifest.skills.enabled)}${formatDisabled(manifest.skills.disabled)}`,
    `  tool profiles: ${formatList(manifest.tools.profiles)}${manifest.tools.enabled?.length ? `; individual: ${manifest.tools.enabled.join(', ')}` : ''}${manifest.tools.deny.length ? `; denied: ${manifest.tools.deny.join(', ')}` : ''}`,
    ...formatPlanPreview(preview),
    `  memory tags: ${formatList(manifest.memory.tags)}`,
    `  instructions: ${manifest.instructions || chalk.gray('(none)')}`,
    chalk.gray(`  onboarded ${manifest.onboarded.at || '(unknown)'} via ${manifest.onboarded.by} — edit with /init --edit (.brainrouter/workspace.json)`),
  ];
  return lines.join('\n');
}

/** Production adapter: an ambient chat overlay or a standalone Ink prompt. */
export async function promptProjectOnboarding(
  request: ProjectOnboardingPromptRequest,
): Promise<ProjectOnboardingPromptResponse> {
  if (request.kind === 'choice') {
    const rows = request.rows ?? [];
    const initialCursor = Math.max(0, rows.findIndex((row) => row.id === request.initialChoice));
    const result = await runPicker({
      title: request.title,
      subtitle: request.subtitle,
      badge: request.badge,
      rows,
      initialCursor,
      multiSelect: request.multiSelect,
      initialSelected: request.initialChoices,
      allowEmptySelection: request.allowEmptySelection,
    });
    if (result.kind === 'multi') return { kind: 'submit', value: result.ids };
    if (result.kind !== 'pick') return { kind: 'cancel' };
    if (result.id === 'skip') return { kind: 'skip' };
    return { kind: 'submit', value: result.id };
  }
  const result = await runTextField({
    title: request.title,
    subtitle: request.subtitle,
    badge: request.badge,
    prefilled: request.initialValue ?? '',
    placeholder: '(leave blank for none)',
  });
  return result.kind === 'accept'
    ? { kind: 'submit', value: result.text }
    : { kind: 'cancel' };
}

/**
 * Run create or edit onboarding. Every field stays in memory until the final
 * confirmation, where the core compares all reviewed revisions and commits.
 */
export async function runProjectOnboarding(
  workspaceRoot: string,
  options: ProjectOnboardingOptions = {},
): Promise<ProjectOnboardingResult> {
  const root = path.resolve(workspaceRoot);
  const reviewBeforeLoad = inspectWorkspaceOnboardingReview(root);
  const existing = loadWorkspaceManifest(root);
  const review = inspectWorkspaceOnboardingReview(root);
  if (!sameRevision(reviewBeforeLoad.revision, review.revision)) {
    throw new Error('Workspace manifest changed while setup was starting. Re-run /init to review the latest version.');
  }
  if (!existing && fs.existsSync(workspaceManifestPath(root))) {
    throw new Error(
      'Workspace manifest exists but cannot be read safely. Repair or remove .brainrouter/workspace.json before retrying; no project files were written.',
    );
  }
  const sources = buildWorkspaceOnboardingSources(
    root,
    options.getConfig?.() ?? options.config,
  );
  const print = options.print ?? console.log;
  if (existing && !options.edit) {
    print(`\n${formatManifestSummary(existing, buildWorkspaceOnboardingPreview(
      existing,
      sources.catalog,
      sources.orchestrationProfiles,
    ))}\n`);
    return { status: 'existing', manifest: existing };
  }
  const prompt = options.prompt ?? promptProjectOnboarding;
  const suggestion = suggestWorkspaceProfile(root);
  const editing = !!existing && !!options.edit;
  const start = await prompt({
    id: 'start',
    kind: 'choice',
    title: editing ? 'Edit workspace setup' : 'Set up this workspace',
    subtitle: editing
      ? 'Review every saved field. Nothing changes until the final confirmation.'
      : `Detected ${suggestion.profile}: ${suggestion.reasons.join('; ')}. Review every field before saving.`,
    badge: 'Workspace',
    rows: editing
      ? [
          { id: 'continue', label: 'Review and edit', description: 'Load the current workspace profile' },
          { id: 'cancel', label: 'Cancel', description: 'Leave project files unchanged' },
        ]
      : [
          { id: 'continue', label: 'Start setup', description: 'Profile, persona, orchestration, capabilities, skills, tools, and memory' },
          { id: 'skip', label: 'Skip for now', description: 'Start without writing project files' },
        ],
    initialChoice: 'continue',
  });
  if (start.kind === 'skip') return skipped(print);
  if (start.kind !== 'submit' || start.value !== 'continue') return cancelled(print);
  const catalog = sources.catalog;

  const profileResponse = await prompt({
    id: 'profile',
    kind: 'choice',
    title: 'Workspace profile',
    subtitle: 'Profiles are editable presets. Detection never overrides your selection.',
    badge: 'Step 1 of 4',
    rows: workspaceProfilesForOnboarding().map((preset) => ({
      id: preset.id,
      label: preset.label,
      value: preset.id === suggestion.profile ? 'detected' : undefined,
      description: preset.description,
    })),
    initialChoice: existing?.profile ?? suggestion.profile,
  });
  if (
    profileResponse.kind !== 'submit'
    || typeof profileResponse.value !== 'string'
    || !isWorkspaceProfileId(profileResponse.value)
  ) {
    return cancelled(print);
  }

  const draft = createProjectOnboardingDraft({
    workspaceRoot: root,
    profile: profileResponse.value,
    existing,
    source: options.source,
    now: options.now,
  });
  const edits = await collectProjectOnboardingEdits(
    prompt,
    draft,
    catalog,
    sources.orchestrationProfiles,
  );
  if (!edits) return cancelled(print);
  const reviewed = finalizeCatalogReviewedProjectOnboarding(draft, edits, catalog);
  print(`\n${formatManifestSummary(reviewed, buildWorkspaceOnboardingPreview(
    reviewed,
    catalog,
    sources.orchestrationProfiles,
  ))}\n`);

  const confirm = await prompt({
    id: 'confirm',
    kind: 'choice',
    title: editing ? 'Save workspace settings?' : 'Finish workspace setup?',
    subtitle: 'This is the only step that writes the workspace manifest.',
    badge: 'Step 4 of 4 · review',
    rows: [
      { id: 'save', label: editing ? 'Save changes' : 'Finish setup', description: '.brainrouter/workspace.json' },
      { id: 'cancel', label: 'Cancel', description: 'Leave project files unchanged' },
    ],
    initialChoice: 'save',
  });
  if (confirm.kind !== 'submit' || confirm.value !== 'save') return cancelled(print);

  const currentSources = buildWorkspaceOnboardingSources(
    root,
    options.getConfig?.() ?? options.config,
  );
  if (currentSources.catalog.fingerprint !== catalog.fingerprint) {
    throw new Error('Workspace setup choices changed while setup was open. Reload and review the latest catalog.');
  }
  const committed = commitReviewedWorkspaceOnboarding(root, {
    manifest: reviewed,
    expected: review.revision,
  });
  print(chalk.green(`\n✓ Onboarded — wrote ${path.relative(root, committed.manifestPath)}`));
  print(`\n${formatManifestSummary(committed.manifest, buildWorkspaceOnboardingPreview(
    committed.manifest,
    currentSources.catalog,
    currentSources.orchestrationProfiles,
  ))}\n`);
  return { status: 'committed', manifest: committed.manifest, manifestPath: committed.manifestPath };
}

export async function collectProjectOnboardingEdits(
  prompt: ProjectOnboardingPrompt,
  draft: WorkspaceManifest,
  catalog: WorkspaceSelectionCatalog = buildWorkspaceSelectionCatalog(),
  orchestrationProfiles?: WorkspaceOrchestrationProfiles,
): Promise<ProjectOnboardingFieldEdits | null> {
  const personaDefault = await requestText(prompt, 'persona-default', 'Default domain persona', draft.persona.default, 'Step 2 of 4 · persona');
  if (personaDefault === null) return null;
  const personasEnabled = await requestList(prompt, 'personas-enabled', 'Enabled domain personas', draft.persona.enabled, 'Step 2 of 4 · persona');
  if (!personasEnabled) return null;
  const orchestrationMode = await requestOrchestrationMode(prompt, draft.orchestration.mode);
  if (!orchestrationMode) return null;
  const rolePreview = buildWorkspaceOnboardingPreview({
    ...draft,
    orchestration: { ...draft.orchestration, mode: orchestrationMode },
  }, catalog, orchestrationProfiles);
  const roleCatalog = { ...catalog, entries: rolePreview.catalog };
  const orchestrationAvailableRoles = await requestCatalogSelection(
    prompt, roleCatalog, 'orchestration-available', 'Available orchestration roles', 'role',
    draft.orchestration.availableRoles,
    'Step 2 of 4 · orchestration', true,
  );
  if (!orchestrationAvailableRoles) return null;
  const orchestrationDisabledRoles = await requestCatalogSelection(
    prompt, roleCatalog, 'orchestration-disabled', 'Disabled orchestration roles', 'role',
    draft.orchestration.disabledRoles,
    'Step 2 of 4 · orchestration', false,
  );
  if (!orchestrationDisabledRoles) return null;
  const orchestrationMaxParallelRaw = await requestText(
    prompt,
    'orchestration-max-parallel',
    'Maximum parallel roles',
    String(draft.orchestration.maxParallel),
    'Step 2 of 4 · orchestration',
  );
  if (orchestrationMaxParallelRaw === null) return null;
  const parsedMaxParallel = Number(orchestrationMaxParallelRaw.trim());
  const orchestrationMaxParallel = Number.isInteger(parsedMaxParallel) &&
    parsedMaxParallel >= 1 && parsedMaxParallel <= 32
    ? parsedMaxParallel
    : draft.orchestration.maxParallel;
  const capabilitiesEnabled = await requestCatalogSelection(
    prompt, roleCatalog, 'capabilities-enabled', 'Optional capabilities', 'capability',
    draft.capabilities.enabled, 'Step 2 of 4 · capabilities', true,
  );
  if (!capabilitiesEnabled) return null;
  const capabilitiesDisabled = await requestCatalogSelection(
    prompt, roleCatalog, 'capabilities-disabled', 'Disabled optional capabilities', 'capability',
    draft.capabilities.disabled, 'Step 2 of 4 · capabilities', true,
  );
  if (!capabilitiesDisabled) return null;
  const includedSkillPacks = WORKSPACE_PROFILES.find(
    (profile) => profile.id === draft.profile,
  )?.skills.packs ?? [];
  const additionalSkillPacks = await requestCatalogSelection(
    prompt, catalog, 'skill-packs', 'Additional skill packs', 'skill-pack',
    draft.skills.packs.filter((id) => !includedSkillPacks.includes(id)),
    'Step 3 of 4 · skills', true, includedSkillPacks,
  );
  if (!additionalSkillPacks) return null;
  const skillPacks = [...new Set([...includedSkillPacks, ...additionalSkillPacks])];
  const skillsEnabled = await requestCatalogSelection(
    prompt, catalog, 'skills-enabled', 'Enabled individual skills', 'skill',
    draft.skills.enabled, 'Step 3 of 4 · skills', true,
  );
  if (!skillsEnabled) return null;
  const skillsDisabled = await requestCatalogSelection(
    prompt, catalog, 'skills-disabled', 'Disabled skills', 'skill',
    draft.skills.disabled, 'Step 3 of 4 · skills', false,
  );
  if (!skillsDisabled) return null;
  const toolProfiles = await requestCatalogSelection(
    prompt, catalog, 'tool-profiles', 'Tool groups', 'tool-group',
    draft.tools.profiles, 'Step 3 of 4 · tools', true,
  );
  if (!toolProfiles) return null;
  const toolsEnabled = await requestCatalogSelection(
    prompt, catalog, 'tools-enabled', 'Additional individual tools', 'tool',
    draft.tools.enabled ?? [], 'Step 3 of 4 · tools', true,
  );
  if (!toolsEnabled) return null;
  const toolsDenied = await requestCatalogSelection(
    prompt, catalog, 'tools-denied', 'Denied tool groups or tools', ['tool-group', 'tool'],
    draft.tools.deny, 'Step 3 of 4 · tools', false,
  );
  if (!toolsDenied) return null;
  const memoryTags = await requestList(prompt, 'memory-tags', 'Memory tags', draft.memory.tags, 'Step 3 of 4 · memory');
  if (!memoryTags) return null;
  const memoryCaptureHint = await requestText(prompt, 'memory-capture-hint', 'Memory capture hint', draft.memory.captureHint, 'Step 3 of 4 · memory');
  if (memoryCaptureHint === null) return null;
  const instructions = await requestText(prompt, 'instructions', 'Instruction file pointer', draft.instructions, 'Step 3 of 4 · instructions');
  if (instructions === null) return null;
  return {
    personaDefault,
    personasEnabled,
    orchestrationMode,
    orchestrationAvailableRoles,
    orchestrationDisabledRoles,
    orchestrationMaxParallel,
    capabilitiesEnabled,
    capabilitiesDisabled,
    skillPacks,
    skillsEnabled,
    skillsDisabled,
    toolProfiles,
    toolsEnabled,
    toolsDenied,
    memoryTags,
    memoryCaptureHint,
    instructions,
  };
}

async function requestOrchestrationMode(
  prompt: ProjectOnboardingPrompt,
  initial: 'off' | 'explicit' | 'adaptive',
): Promise<'off' | 'explicit' | 'adaptive' | null> {
  const result = await prompt({
    id: 'orchestration-mode',
    kind: 'choice',
    title: 'Orchestration mode',
    subtitle: 'Available roles are invoked only when this mode permits them.',
    badge: 'Step 2 of 4 · orchestration',
    rows: [
      { id: 'off', label: 'Off', description: 'Use only the primary agent' },
      { id: 'explicit', label: 'Explicit', description: 'Delegate only when the user or a trusted workflow requests it' },
      { id: 'adaptive', label: 'Adaptive', description: 'Allow task evidence to select an available role' },
    ],
    initialChoice: initial,
  });
  return result.kind === 'submit' &&
    (result.value === 'off' || result.value === 'explicit' || result.value === 'adaptive')
    ? result.value
    : null;
}

async function requestText(
  prompt: ProjectOnboardingPrompt,
  id: ProjectOnboardingPromptId,
  title: string,
  initialValue: string,
  badge: string,
): Promise<string | null> {
  const result = await prompt({ id, kind: 'text', title, badge, initialValue });
  return result.kind === 'submit' && typeof result.value === 'string' ? result.value : null;
}

async function requestList(
  prompt: ProjectOnboardingPrompt,
  id: ProjectOnboardingPromptId,
  title: string,
  initial: string[],
  badge: string,
): Promise<string[] | null> {
  const value = await requestText(prompt, id, title, initial.join(', '), badge);
  return value === null ? null : parseProjectOnboardingList(value);
}

function formatList(values: string[]): string {
  return values.join(', ') || chalk.gray('(none)');
}

function formatDisabled(values: string[]): string {
  return values.length > 0 ? `; disabled: ${values.join(', ')}` : '';
}

function sameRevision(
  left: { root: string; manifest: string; instruction: string },
  right: { root: string; manifest: string; instruction: string },
): boolean {
  return left.root === right.root && left.manifest === right.manifest && left.instruction === right.instruction;
}

function skipped(print: (message: string) => void): ProjectOnboardingResult {
  print(chalk.gray('\nSkipped — nothing written. Run /init when you are ready.\n'));
  return { status: 'skipped' };
}

function cancelled(print: (message: string) => void): ProjectOnboardingResult {
  print(chalk.gray('\nCancelled — nothing written.\n'));
  return { status: 'cancelled' };
}
