/** Reviewed project onboarding for one CLI workspace. */
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import {
  WORKSPACE_PROFILES,
  commitReviewedWorkspaceOnboarding,
  inspectWorkspaceOnboardingReview,
  isWorkspaceProfileId,
  loadWorkspaceManifest,
  suggestWorkspaceProfile,
  workspaceManifestPath,
  type WorkspaceManifest,
  type WorkspaceOnboardSource,
  type WorkspaceProfileId,
} from '@kinqs/brainrouter-core/workspace';
import { runPicker, runTextField, type PickerRow } from '../../ink/prompt/runPicker.js';
import {
  applyProjectOnboardingEdits,
  createProjectOnboardingDraft,
  parseProjectOnboardingList,
  type ProjectOnboardingFieldEdits,
} from './onboardingDraft.js';

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
  initialValue?: string;
}

export type ProjectOnboardingPromptResponse =
  | { kind: 'submit'; value: string }
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
export function formatManifestSummary(manifest: WorkspaceManifest): string {
  const lines = [
    `${chalk.bold('Workspace')}: ${manifest.name}  ${chalk.gray(`(profile: ${manifest.profile})`)}`,
    `  default persona: ${manifest.persona.default || chalk.gray('(none)')}`,
    `  enabled personas: ${formatList(manifest.persona.enabled)}`,
    `  orchestration: ${manifest.orchestration.mode}; available: ${formatList(manifest.orchestration.availableRoles)}${formatDisabled(manifest.orchestration.disabledRoles)}; max parallel: ${manifest.orchestration.maxParallel}`,
    `  capabilities: ${formatList(manifest.capabilities.enabled)}${formatDisabled(manifest.capabilities.disabled)}`,
    `  skill packs: ${formatList(manifest.skills.packs)}`,
    `  enabled skills: ${formatList(manifest.skills.enabled)}${formatDisabled(manifest.skills.disabled)}`,
    `  tool profiles: ${formatList(manifest.tools.profiles)}${manifest.tools.deny.length ? `; denied: ${manifest.tools.deny.join(', ')}` : ''}`,
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
    });
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
  const print = options.print ?? console.log;
  if (existing && !options.edit) {
    print(`\n${formatManifestSummary(existing)}\n`);
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

  const profileResponse = await prompt({
    id: 'profile',
    kind: 'choice',
    title: 'Workspace profile',
    subtitle: 'Profiles are editable presets. Detection never overrides your selection.',
    badge: 'Step 1 of 4',
    rows: WORKSPACE_PROFILES.map((preset) => ({
      id: preset.id,
      label: preset.label,
      value: preset.id === suggestion.profile ? 'detected' : undefined,
      description: preset.description,
    })),
    initialChoice: existing?.profile ?? suggestion.profile,
  });
  if (profileResponse.kind !== 'submit' || !isWorkspaceProfileId(profileResponse.value)) {
    return cancelled(print);
  }

  const draft = createProjectOnboardingDraft({
    workspaceRoot: root,
    profile: profileResponse.value,
    existing,
    source: options.source,
    now: options.now,
  });
  const edits = await collectProjectOnboardingEdits(prompt, draft);
  if (!edits) return cancelled(print);
  const reviewed = applyProjectOnboardingEdits(draft, edits);
  print(`\n${formatManifestSummary(reviewed)}\n`);

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

  const committed = commitReviewedWorkspaceOnboarding(root, {
    manifest: reviewed,
    expected: review.revision,
  });
  print(chalk.green(`\n✓ Onboarded — wrote ${path.relative(root, committed.manifestPath)}`));
  print(`\n${formatManifestSummary(committed.manifest)}\n`);
  return { status: 'committed', manifest: committed.manifest, manifestPath: committed.manifestPath };
}

export async function collectProjectOnboardingEdits(
  prompt: ProjectOnboardingPrompt,
  draft: WorkspaceManifest,
): Promise<ProjectOnboardingFieldEdits | null> {
  const personaDefault = await requestText(prompt, 'persona-default', 'Default domain persona', draft.persona.default, 'Step 2 of 4 · persona');
  if (personaDefault === null) return null;
  const personasEnabled = await requestList(prompt, 'personas-enabled', 'Enabled domain personas', draft.persona.enabled, 'Step 2 of 4 · persona');
  if (!personasEnabled) return null;
  const orchestrationMode = await requestOrchestrationMode(prompt, draft.orchestration.mode);
  if (!orchestrationMode) return null;
  const orchestrationAvailableRoles = await requestList(
    prompt,
    'orchestration-available',
    'Available orchestration roles',
    draft.orchestration.availableRoles,
    'Step 2 of 4 · orchestration',
  );
  if (!orchestrationAvailableRoles) return null;
  const orchestrationDisabledRoles = await requestList(
    prompt,
    'orchestration-disabled',
    'Disabled orchestration roles',
    draft.orchestration.disabledRoles,
    'Step 2 of 4 · orchestration',
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
  const capabilitiesEnabled = await requestList(prompt, 'capabilities-enabled', 'Available task capabilities', draft.capabilities.enabled, 'Step 2 of 4 · capabilities');
  if (!capabilitiesEnabled) return null;
  const capabilitiesDisabled = await requestList(prompt, 'capabilities-disabled', 'Disabled task capabilities', draft.capabilities.disabled, 'Step 2 of 4 · capabilities');
  if (!capabilitiesDisabled) return null;
  const skillPacks = await requestList(prompt, 'skill-packs', 'Skill packs', draft.skills.packs, 'Step 3 of 4 · skills');
  if (!skillPacks) return null;
  const skillsEnabled = await requestList(prompt, 'skills-enabled', 'Enabled skills', draft.skills.enabled, 'Step 3 of 4 · skills');
  if (!skillsEnabled) return null;
  const skillsDisabled = await requestList(prompt, 'skills-disabled', 'Disabled skills', draft.skills.disabled, 'Step 3 of 4 · skills');
  if (!skillsDisabled) return null;
  const toolProfiles = await requestList(prompt, 'tool-profiles', 'Tool profiles', draft.tools.profiles, 'Step 3 of 4 · tools');
  if (!toolProfiles) return null;
  const toolsDenied = await requestList(prompt, 'tools-denied', 'Denied tools', draft.tools.deny, 'Step 3 of 4 · tools');
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
  return result.kind === 'submit' ? result.value : null;
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
