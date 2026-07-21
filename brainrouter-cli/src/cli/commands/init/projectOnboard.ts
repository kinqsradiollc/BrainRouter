/**
 * Project onboarding for one workspace.
 *
 * The flow is deliberately split into collect -> review -> commit. Prompting
 * never touches disk, so Skip or cancellation at any step leaves both the
 * manifest and instruction file byte-for-byte unchanged. The production
 * prompt adapter uses the chat overlay when a REPL is mounted and a standalone
 * Ink picker during startup, which lets the same state machine run before an
 * Agent or session exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import chalk from 'chalk';
import {
  WORKSPACE_PROFILES,
  WORKSPACE_MANIFEST_MAX_BYTES,
  WORKSPACE_MANIFEST_RELPATH,
  createWorkspaceManifest,
  isWorkspaceProfileId,
  loadWorkspaceManifest,
  normalizeWorkspaceManifest,
  openWorkspaceFileParentGuard,
  beginWorkspaceManifestClaim,
  assertWorkspaceManifestClaimReceipt,
  endWorkspaceManifestClaim,
  recoverInterruptedWorkspaceManifestClaim,
  recoverInterruptedWorkspaceOnboardingPair,
  removeWorkspaceManifestClaimReceipt,
  resolveWorkspaceFileForWrite,
  saveWorkspaceManifest,
  serializeWorkspaceManifest,
  suggestWorkspaceProfile,
  writeWorkspaceFileAtomic,
  beginWorkspaceOnboardingPairTransaction,
  completeWorkspaceOnboardingPairTransaction,
  endWorkspaceOnboardingPairTransaction,
  markWorkspaceOnboardingInstructionCommitting,
  markWorkspaceOnboardingManifestCommitting,
  recordWorkspaceOnboardingInstructionStaged,
  recordWorkspaceOnboardingInstructionWritten,
  recordWorkspaceOnboardingManifestWritten,
  type WorkspaceManifest,
  type WorkspaceFileParentGuard,
  type WorkspaceFileStagedVersion,
  type WorkspaceManifestClaimTransaction,
  type WorkspaceOnboardingPairTransaction,
  type WorkspaceOnboardSource,
  type WorkspaceProfileId,
} from '@kinqs/brainrouter-core/workspace';
import { runPicker, runTextField, type PickerRow } from '../../ink/prompt/runPicker.js';
import {
  initAgentMd,
  prepareAgentMd,
  type InitAgentMdOptions,
  type InitResult,
} from '../../../prompt/initAgentMd.js';
import { sanitizeTerminalText } from '../../terminalText.js';

// The suggestion logic lives in core so CLI and desktop onboarding cannot
// drift. Re-export it to preserve the public onboarding module surface.
export { suggestWorkspaceProfile, type ProfileSuggestion } from '@kinqs/brainrouter-core/workspace';

export type ProjectOnboardingPromptId =
  | 'start'
  | 'profile'
  | 'agent-default'
  | 'agents-enabled'
  | 'capabilities-enabled'
  | 'capabilities-disabled'
  | 'skill-packs'
  | 'skills-enabled'
  | 'skills-disabled'
  | 'tool-profiles'
  | 'tools-deny'
  | 'agent-md'
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
  | { status: 'committed'; manifest: WorkspaceManifest; manifestPath: string; instruction?: InitResult }
  | { status: 'existing'; manifest: WorkspaceManifest }
  | { status: 'skipped' }
  | { status: 'cancelled' };

export interface ProjectOnboardingOptions {
  edit?: boolean;
  source?: WorkspaceOnboardSource;
  prompt?: ProjectOnboardingPrompt;
  now?: () => string;
  print?: (message: string) => void;
  persistence?: ProjectOnboardingPersistence;
}

export interface ProjectOnboardingPersistence {
  saveManifest(
    workspaceRoot: string,
    manifest: WorkspaceManifest,
    options?: { exclusive?: boolean },
  ): string;
  initInstructions(workspaceRoot: string, options?: InitAgentMdOptions): InitResult;
}

const DEFAULT_PERSISTENCE: ProjectOnboardingPersistence = {
  saveManifest: saveWorkspaceManifest,
  initInstructions: initAgentMd,
};

const PROJECT_INSTRUCTION_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

export interface ProjectOnboardingFilesystemTestEvent {
  stage:
    | 'before-manifest-claim'
    | 'after-manifest-claim'
    | 'after-manifest-replacement'
    | 'before-remove-quarantine';
  target: string;
  quarantine: string;
}

let projectOnboardingFilesystemHookForTests:
  ((event: ProjectOnboardingFilesystemTestEvent) => void) | undefined;

function assertProjectOnboardingTestHooksEnabled(): void {
  const nodeTestContext = process.env.NODE_TEST_CONTEXT;
  if (nodeTestContext !== 'child-v8' && nodeTestContext !== 'child-process') {
    throw new Error('Project onboarding test hooks are unavailable outside a test runtime.');
  }
}

function invokeProjectOnboardingTestHook<Event>(
  hook: ((event: Event) => void) | undefined,
  event: Event,
): void {
  if (!hook) return;
  assertProjectOnboardingTestHooksEnabled();
  hook(event);
}

/** Test seam for deterministic replacements at commit and rollback boundaries. */
export function _setProjectOnboardingFilesystemHookForTests(
  hook?: (event: ProjectOnboardingFilesystemTestEvent) => void,
): void {
  assertProjectOnboardingTestHooksEnabled();
  projectOnboardingFilesystemHookForTests = hook;
}

export interface ProjectOnboardingTransactionTestEvent {
  stage: 'after-instruction-commit' | 'after-manifest-commit';
  workspaceRoot: string;
}

let projectOnboardingTransactionHookForTests:
  ((event: ProjectOnboardingTransactionTestEvent) => void) | undefined;

/** Test seam that simulates process death after one durable pair commit. */
export function _setProjectOnboardingTransactionHookForTests(
  hook?: (event: ProjectOnboardingTransactionTestEvent) => void,
): void {
  assertProjectOnboardingTestHooksEnabled();
  projectOnboardingTransactionHookForTests = hook;
}

/**
 * Parse the legacy numbered profile answer. Kept for compatibility with the
 * baseline `/init` tests and for non-Ink callers that may still use the helper.
 */
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

/** Trim, de-duplicate, and preserve order for comma-separated picker fields. */
export function parseSelectionList(input: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const part of input.split(',')) {
    const value = part.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

/** Human summary used for existing workspaces and the final review screen. */
export function formatManifestSummary(manifest: WorkspaceManifest): string {
  const safe = normalizeWorkspaceManifest(manifest);
  const lines = [
    `${chalk.bold('Workspace')}: ${sanitizeTerminalText(safe.name)}  ${chalk.gray(`(profile: ${sanitizeTerminalText(safe.profile)})`)}`,
    `  default agent: ${sanitizeTerminalText(safe.agents.default) || chalk.gray('(none)')}`,
    `  enabled agents: ${formatList(safe.agents.enabled)}`,
    `  capabilities: ${formatList(safe.capabilities.enabled)}${formatDisabled(safe.capabilities.disabled)}`,
    `  skill packs: ${formatList(safe.skills.packs)}`,
    `  enabled skills: ${formatList(safe.skills.enabled)}${formatDisabled(safe.skills.disabled)}`,
    `  tool profiles: ${formatList(safe.tools.profiles)}${safe.tools.deny.length ? `; denied: ${safe.tools.deny.map(sanitizeTerminalText).join(', ')}` : ''}`,
    `  memory tags: ${formatList(safe.memory.tags)}`,
    `  instructions: ${sanitizeTerminalText(safe.instructions) || chalk.gray('(none)')}`,
    chalk.gray(`  onboarded ${sanitizeTerminalText(safe.onboarded.at) || '(unknown)'} via ${sanitizeTerminalText(safe.onboarded.by)} — edit with /init --edit`),
  ];
  return lines.join('\n');
}

function formatList(values: string[]): string {
  return values.map(sanitizeTerminalText).join(', ') || chalk.gray('(none)');
}

function formatDisabled(values: string[]): string {
  return values.length > 0 ? `; disabled: ${values.map(sanitizeTerminalText).join(', ')}` : '';
}

/** Production prompt adapter: ambient chat overlay or standalone Ink mount. */
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
 * Run create or edit onboarding. Existing workspaces stay completely silent
 * during automatic startup checks; callers must opt into `edit` to prompt.
 */
export async function runProjectOnboarding(
  workspaceRoot: string,
  options: ProjectOnboardingOptions = {},
): Promise<ProjectOnboardingResult> {
  const root = path.resolve(workspaceRoot);
  const manifestTarget = resolveWorkspaceFileForWrite(root, WORKSPACE_MANIFEST_RELPATH);
  recoverInterruptedWorkspaceManifestClaim(root);
  recoverInterruptedWorkspaceOnboardingPair(root);
  const manifestBeforeLoad = inspectFileVersion(manifestTarget);
  const existing = loadWorkspaceManifest(root);
  const manifestAfterLoad = inspectFileVersion(manifestTarget);
  if (!fileVersionsMatch(manifestBeforeLoad, manifestAfterLoad)) {
    throw new Error('Workspace manifest changed while setup was starting. Re-run /init to review the latest version.');
  }
  if (manifestAfterLoad.existed && !existing) {
    throw new Error(
      'Workspace manifest exists but cannot be read safely. Back it up and repair or remove '
      + '.brainrouter/workspace.json before rerunning /init; no project files were written.',
    );
  }
  const manifestAtStart = snapshotFile(manifestTarget, WORKSPACE_MANIFEST_MAX_BYTES);
  if (!fileVersionsMatch(manifestAfterLoad, manifestAtStart)) {
    throw new Error('Workspace manifest changed while setup was starting. Re-run /init to review the latest version.');
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
      ? 'Review the saved profile, capabilities, skills, and tools. Nothing changes until the final confirmation.'
      : `Detected ${suggestion.profile}: ${suggestion.reasons.join('; ')}. You can review every preset before saving.`,
    badge: 'Workspace',
    rows: editing
      ? [
          { id: 'continue', label: 'Review and edit', description: 'Load the current manifest and preserve newer fields' },
          { id: 'cancel', label: 'Cancel', description: 'Leave project files unchanged' },
        ]
      : [
          { id: 'continue', label: 'Start setup', description: 'Profile → capabilities → skills and tools → review' },
          { id: 'skip', label: 'Skip for now', description: 'Start the session without writing project files' },
        ],
    initialChoice: 'continue',
  });
  if (start.kind === 'skip') return skipped(print);
  if (start.kind === 'cancel' || start.value !== 'continue') return cancelled(print);

  const profileDefault = existing?.profile ?? suggestion.profile;
  const profileResponse = await prompt({
    id: 'profile',
    kind: 'choice',
    title: 'Workspace profile',
    subtitle: 'Profiles are editable presets. The detected choice is highlighted; it never overrides your selection.',
    badge: 'Step 1 of 4',
    rows: WORKSPACE_PROFILES.map((preset) => ({
      id: preset.id,
      label: preset.label,
      value: preset.id === suggestion.profile ? 'detected' : undefined,
      description: preset.description,
    })),
    initialChoice: profileDefault,
  });
  if (profileResponse.kind !== 'submit' || !isWorkspaceProfileId(profileResponse.value)) return cancelled(print);

  const profile = profileResponse.value;
  let draft = existing && profile === existing.profile
    ? cloneManifest(existing)
    : createWorkspaceManifest({
        name: existing?.name ?? path.basename(root),
        profile,
        by: options.source ?? 'wizard',
        at: existing?.onboarded.at || options.now?.(),
      });
  if (existing && profile !== existing.profile) {
    draft = {
      ...draft,
      version: existing.version,
      onboarded: { ...existing.onboarded },
      instructions: existing.instructions,
      ...(existing.extra ? { extra: cloneExtra(existing.extra) } : {}),
    };
  }

  const agentDefault = await requestText(prompt, {
    id: 'agent-default',
    title: 'Default domain agent',
    subtitle: 'One default persona for this workspace. Frontend work is an engineer capability, not another agent.',
    badge: 'Step 2 of 4 · agents',
    initialValue: draft.agents.default,
  });
  if (agentDefault === null) return cancelled(print);
  draft.agents.default = agentDefault.trim();

  const agentsEnabled = await requestList(prompt, 'agents-enabled', 'Enabled domain agents', draft.agents.enabled, 'Step 2 of 4 · agents');
  if (agentsEnabled === null) return cancelled(print);
  draft.agents.enabled = agentsEnabled;
  if (draft.agents.default && !draft.agents.enabled.includes(draft.agents.default)) {
    draft.agents.enabled.unshift(draft.agents.default);
  }

  const capabilitiesEnabled = await requestList(
    prompt,
    'capabilities-enabled',
    'Available task capabilities',
    draft.capabilities.enabled,
    'Step 2 of 4 · capabilities',
  );
  if (capabilitiesEnabled === null) return cancelled(print);
  draft.capabilities.enabled = capabilitiesEnabled;

  const capabilitiesDisabled = await requestList(
    prompt,
    'capabilities-disabled',
    'Disabled task capabilities',
    draft.capabilities.disabled,
    'Step 2 of 4 · capabilities',
  );
  if (capabilitiesDisabled === null) return cancelled(print);
  draft.capabilities.disabled = capabilitiesDisabled;
  const disabledCapabilities = new Set(draft.capabilities.disabled);
  draft.capabilities.enabled = draft.capabilities.enabled.filter((id) => !disabledCapabilities.has(id));

  const skillPacks = await requestList(prompt, 'skill-packs', 'Skill packs', draft.skills.packs, 'Step 3 of 4 · skills');
  if (skillPacks === null) return cancelled(print);
  draft.skills.packs = skillPacks;

  const skillsEnabled = await requestList(prompt, 'skills-enabled', 'Enabled starter skills', draft.skills.enabled, 'Step 3 of 4 · skills');
  if (skillsEnabled === null) return cancelled(print);
  draft.skills.enabled = skillsEnabled;

  const skillsDisabled = await requestList(prompt, 'skills-disabled', 'Disabled skills', draft.skills.disabled, 'Step 3 of 4 · skills');
  if (skillsDisabled === null) return cancelled(print);
  draft.skills.disabled = skillsDisabled;
  const disabledSkills = new Set(draft.skills.disabled);
  draft.skills.enabled = draft.skills.enabled.filter((id) => !disabledSkills.has(id));

  const toolProfiles = await requestList(prompt, 'tool-profiles', 'Tool profiles', draft.tools.profiles, 'Step 3 of 4 · tools');
  if (toolProfiles === null) return cancelled(print);
  draft.tools.profiles = toolProfiles;

  const toolsDeny = await requestList(prompt, 'tools-deny', 'Denied tools', draft.tools.deny, 'Step 3 of 4 · tools');
  if (toolsDeny === null) return cancelled(print);
  draft.tools.deny = toolsDeny;

  let writeAgentMd = false;
  const instructionFile = editing ? null : findInstructionFile(root);
  if (!editing && instructionFile) {
    draft.instructions = path.relative(root, instructionFile);
  } else if (!editing) {
    const instructionResponse = await prompt({
      id: 'agent-md',
      kind: 'choice',
      title: 'Project instructions',
      subtitle: 'Optionally scaffold AGENT.md. It is committed together with the manifest only after review.',
      badge: 'Step 4 of 4',
      rows: [
        { id: 'write', label: 'Create AGENT.md', description: 'Generate a starter file from deterministic repository signals' },
        { id: 'keep', label: 'Not now', description: 'Save only the workspace manifest' },
      ],
      initialChoice: 'write',
    });
    if (instructionResponse.kind !== 'submit') return cancelled(print);
    writeAgentMd = instructionResponse.value === 'write';
    draft.instructions = writeAgentMd ? 'AGENT.md' : '';
  }

  // Review and return the exact secret/path-sanitized representation that the
  // manifest writer will persist; untrusted text must never survive in output.
  draft = normalizeWorkspaceManifest(draft);

  print(`\n${chalk.bold('Review workspace setup')}\n${formatManifestSummary(draft)}\n`);
  const confirmation = await prompt({
    id: 'confirm',
    kind: 'choice',
    title: editing ? 'Save workspace changes?' : 'Finish workspace setup?',
    subtitle: writeAgentMd
      ? 'This writes .brainrouter/workspace.json and AGENT.md as one confirmed change.'
      : 'This writes .brainrouter/workspace.json. No other project file changes.',
    badge: 'Confirm',
    rows: [
      { id: 'save', label: editing ? 'Save changes' : 'Finish setup', description: 'Commit the reviewed project configuration' },
      { id: 'cancel', label: 'Cancel', description: 'Leave project files unchanged' },
    ],
    initialChoice: 'save',
  });
  if (confirmation.kind !== 'submit' || confirmation.value !== 'save') return cancelled(print);

  const committed = commitProjectOnboardingWithExpectedManifest(
    root,
    draft,
    writeAgentMd,
    options.persistence ?? DEFAULT_PERSISTENCE,
    manifestAtStart,
  );
  print(chalk.green(`\n✓ Workspace setup saved to ${path.relative(root, committed.manifestPath)}`));
  if (committed.instruction?.status === 'created') {
    print(chalk.green(`✓ Created ${path.relative(root, committed.instruction.path)}`));
  }
  print(`\n${formatManifestSummary(draft)}\n`);
  return { status: 'committed', manifest: draft, ...committed };
}

/**
 * Commit both project files with rollback snapshots and a trusted pair
 * receipt. AGENT.md is written first; startup recovery either restores the
 * pre-commit pair or accepts the fully committed pair after process death.
 */
export function commitProjectOnboarding(
  workspaceRoot: string,
  manifest: WorkspaceManifest,
  writeAgentMd: boolean,
  persistence: ProjectOnboardingPersistence = DEFAULT_PERSISTENCE,
): { manifestPath: string; instruction?: InitResult } {
  return commitProjectOnboardingWithExpectedManifest(
    workspaceRoot,
    manifest,
    writeAgentMd,
    persistence,
  );
}

function commitProjectOnboardingWithExpectedManifest(
  workspaceRoot: string,
  manifest: WorkspaceManifest,
  writeAgentMd: boolean,
  persistence: ProjectOnboardingPersistence,
  expectedManifestSnapshot?: FileSnapshot,
): { manifestPath: string; instruction?: InitResult } {
  const manifestTarget = resolveWorkspaceFileForWrite(workspaceRoot, WORKSPACE_MANIFEST_RELPATH);
  recoverInterruptedWorkspaceManifestClaim(workspaceRoot);
  recoverInterruptedWorkspaceOnboardingPair(workspaceRoot);
  const manifestSnapshot = snapshotFile(manifestTarget, WORKSPACE_MANIFEST_MAX_BYTES);
  if (expectedManifestSnapshot &&
      !fileSnapshotsAreExact(expectedManifestSnapshot, manifestSnapshot)) {
    throw new Error(
      'Workspace manifest changed during setup. No project files were written; re-run /init --edit to review the latest version.',
    );
  }
  const instructionTarget = writeAgentMd
    ? resolveWorkspaceFileForWrite(workspaceRoot, 'AGENT.md')
    : undefined;
  const instructionSnapshot = instructionTarget
    ? snapshotFile(instructionTarget, PROJECT_INSTRUCTION_SNAPSHOT_MAX_BYTES)
    : undefined;
  const preparedInstruction = writeAgentMd ? prepareAgentMd(workspaceRoot) : undefined;
  if (preparedInstruction && instructionTarget) {
    const relativePreparedPath = path.relative(path.resolve(workspaceRoot), path.resolve(preparedInstruction.path));
    let preparedTarget: string;
    try {
      preparedTarget = resolveWorkspaceFileForWrite(workspaceRoot, relativePreparedPath);
    } catch {
      throw new Error('Project instruction writer prepared an unexpected path.');
    }
    if (preparedTarget !== instructionTarget) {
      throw new Error('Project instruction writer prepared an unexpected path.');
    }
  }

  let pairTransaction: WorkspaceOnboardingPairTransaction | undefined;
  if (preparedInstruction && instructionSnapshot) {
    if (preparedInstruction.status === 'exists' && !instructionSnapshot.existed) {
      throw new Error('Project instruction file changed while setup was preparing to commit.');
    }
    pairTransaction = beginWorkspaceOnboardingPairTransaction(workspaceRoot, {
      manifestBefore: manifestSnapshot,
      manifestDesired: serializeWorkspaceManifest(manifest),
      instructionBefore: instructionSnapshot,
      instructionDesired: preparedInstruction.status === 'created'
        ? preparedInstruction.contents
        : instructionSnapshot.contents!,
    });
  }

  const manifestDirectoryExisted = fs.existsSync(path.dirname(manifestTarget));
  const manifestStage: FileWriteStage = { attempted: false, completed: false };
  const instructionStage: FileWriteStage = { attempted: false, completed: false };
  let simulatedCrash = false;
  let filesCommitted = false;
  try {
    let instruction: InitResult | undefined;
    if (writeAgentMd) {
      markWorkspaceOnboardingInstructionCommitting(pairTransaction!);
      instructionStage.attempted = true;
      instruction = persistence.initInstructions(workspaceRoot, {
        onStaged: (staged: WorkspaceFileStagedVersion) => {
          recordWorkspaceOnboardingInstructionStaged(pairTransaction!, staged);
        },
      });
      instructionStage.completed = true;
      let returnedInstructionPath: string;
      try {
        returnedInstructionPath = fs.realpathSync(instruction.path);
      } catch {
        returnedInstructionPath = path.resolve(instruction.path);
      }
      if (!instructionTarget || returnedInstructionPath !== instructionTarget) {
        throw new Error('Project instruction writer returned an unexpected path.');
      }
      const afterInstruction = snapshotFile(
        instructionTarget,
        PROJECT_INSTRUCTION_SNAPSHOT_MAX_BYTES,
      );
      if (!afterInstruction.existed) {
        throw new Error('Project instruction writer reported success without an instruction file.');
      }
      if (instruction.status === 'created') {
        instructionStage.after = afterInstruction;
      }
      recordWorkspaceOnboardingInstructionWritten(
        pairTransaction!,
        instruction.status === 'created' ? 'created' : 'unchanged',
        afterInstruction,
      );
      try {
        invokeProjectOnboardingTestHook(projectOnboardingTransactionHookForTests, {
          stage: 'after-instruction-commit',
          workspaceRoot,
        });
      } catch (error) {
        simulatedCrash = true;
        throw error;
      }
    }

    if (pairTransaction) markWorkspaceOnboardingManifestCommitting(pairTransaction);
    manifestStage.attempted = true;
    const savedManifestPath = saveManifestWithExpectedVersion(
      workspaceRoot,
      manifest,
      persistence,
      manifestTarget,
      manifestSnapshot,
      pairTransaction,
    );
    manifestStage.completed = true;
    manifestStage.after = snapshotFile(manifestTarget, WORKSPACE_MANIFEST_MAX_BYTES);
    if (!manifestStage.after.existed) {
      throw new Error('Workspace manifest writer reported success without creating the manifest.');
    }
    if (path.resolve(savedManifestPath) !== manifestTarget) {
      throw new Error('Workspace manifest writer returned an unexpected path.');
    }
    if (pairTransaction) {
      recordWorkspaceOnboardingManifestWritten(pairTransaction, manifestStage.after!);
      filesCommitted = true;
      try {
        invokeProjectOnboardingTestHook(projectOnboardingTransactionHookForTests, {
          stage: 'after-manifest-commit',
          workspaceRoot,
        });
      } catch (error) {
        simulatedCrash = true;
        throw error;
      }
      completeWorkspaceOnboardingPairTransaction(pairTransaction);
    }
    return { manifestPath: savedManifestPath, instruction };
  } catch (error) {
    if (simulatedCrash || filesCommitted) throw error;
    const rollbackErrors = [
      rollbackWorkspaceFile(
        workspaceRoot,
        WORKSPACE_MANIFEST_RELPATH,
        manifestSnapshot,
        manifestStage,
        WORKSPACE_MANIFEST_MAX_BYTES,
      ),
      instructionSnapshot
        ? rollbackWorkspaceFile(
            workspaceRoot,
            'AGENT.md',
            instructionSnapshot,
            instructionStage,
            PROJECT_INSTRUCTION_SNAPSHOT_MAX_BYTES,
          )
        : undefined,
    ].filter((candidate): candidate is Error => candidate instanceof Error);
    if (!manifestDirectoryExisted) {
      try { fs.rmdirSync(path.dirname(manifestTarget)); } catch { /* a concurrent writer owns the directory */ }
    }
    if (rollbackErrors.length === 0 && pairTransaction) {
      try {
        completeWorkspaceOnboardingPairTransaction(pairTransaction);
      } catch {
        // A trusted receipt is safe to leave behind. The next read retires it
        // after verifying that both workspace files match their before state.
      }
    }
    if (rollbackErrors.length > 0) {
      const original = error instanceof Error ? error : new Error(String(error));
      throw new AggregateError(
        [original, ...rollbackErrors],
        `Workspace setup failed and rollback was incomplete: ${original.message}`,
      );
    }
    throw error;
  } finally {
    if (pairTransaction) endWorkspaceOnboardingPairTransaction(pairTransaction);
  }
}

function saveManifestWithExpectedVersion(
  workspaceRoot: string,
  manifest: WorkspaceManifest,
  persistence: ProjectOnboardingPersistence,
  target: string,
  expected: FileSnapshot,
  pairTransaction?: WorkspaceOnboardingPairTransaction,
): string {
  const guard = expected.existed
    ? openWorkspaceFileParentGuard(workspaceRoot, WORKSPACE_MANIFEST_RELPATH)
    : undefined;
  let transaction: WorkspaceManifestClaimTransaction | undefined;
  try {
    transaction = expected.existed
      ? beginWorkspaceManifestClaim(workspaceRoot, target, {
          mode: expected.mode! & 0o777,
          dev: expected.dev!,
          ino: expected.ino!,
          size: expected.size!,
          mtimeMs: expected.mtimeMs!,
          contents: expected.contents!,
        }, {
          desired: serializeWorkspaceManifest(manifest),
          onboardingPairToken: pairTransaction?.token,
        })
      : undefined;
  } catch (error) {
    guard?.close();
    throw error;
  }
  const claim = transaction?.claim ?? path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.claim`,
  );
  const accessClaim = guard ? guard.siblingPath(path.basename(claim)) : claim;
  let claimed: FileSnapshot | undefined;
  try {
    invokeProjectOnboardingTestHook(projectOnboardingFilesystemHookForTests, {
      stage: 'before-manifest-claim',
      target,
      quarantine: claim,
    });

    if (expected.existed) {
      guard!.assertStable();
      assertWorkspaceManifestClaimReceipt(transaction!);
      fs.renameSync(guard!.accessTarget, accessClaim);
      guard!.fsyncParent();
      guard!.assertStable();
      claimed = snapshotFile(accessClaim, WORKSPACE_MANIFEST_MAX_BYTES);
      invokeProjectOnboardingTestHook(projectOnboardingFilesystemHookForTests, {
        stage: 'after-manifest-claim',
        target,
        quarantine: claim,
      });
      guard!.assertStable();
      if (!fileSnapshotsMatchAcrossRename(expected, claimed)) {
        const recovery = restoreUnexpectedMovedWorkspaceFile(
          guard!.accessTarget,
          accessClaim,
          WORKSPACE_MANIFEST_MAX_BYTES,
          guard,
        );
        if (recovery.restored) removeWorkspaceManifestClaimReceipt(transaction!);
        throw new Error(
          `Workspace manifest changed immediately before save; the concurrent version was ${recovery.message}.`,
        );
      }
    }

    let savedPath: string;
    try {
      guard?.assertStable();
      savedPath = persistence.saveManifest(workspaceRoot, manifest, { exclusive: true });
      guard?.assertStable();
      if (!snapshotFile(guard?.accessTarget ?? target, WORKSPACE_MANIFEST_MAX_BYTES).existed) {
        throw new Error('Workspace manifest writer reported success without creating the manifest.');
      }
      invokeProjectOnboardingTestHook(projectOnboardingFilesystemHookForTests, {
        stage: 'after-manifest-replacement',
        target,
        quarantine: claim,
      });
    } catch (error) {
      if (claimed) {
        // Restore only if the writer left the canonical path absent. Otherwise
        // its partial or a concurrent replacement wins and the claim is kept.
        const recovery = restoreUnexpectedMovedWorkspaceFile(
          guard!.accessTarget,
          accessClaim,
          WORKSPACE_MANIFEST_MAX_BYTES,
          guard,
        );
        if (recovery.restored) Object.assign(expected, recovery.restored);
        if (recovery.restored) removeWorkspaceManifestClaimReceipt(transaction!);
      }
      throw error;
    }

    if (claimed) {
      guard!.assertStable();
      const verifiedClaim = snapshotFile(accessClaim, WORKSPACE_MANIFEST_MAX_BYTES);
      if (!fileSnapshotsAreExact(claimed, verifiedClaim)) {
        throw new Error(`Workspace manifest claim changed during save and is preserved at ${claim}.`);
      }
      fs.unlinkSync(accessClaim);
      guard!.fsyncParent();
      guard!.assertStable();
      removeWorkspaceManifestClaimReceipt(transaction!);
    }
    return savedPath;
  } finally {
    if (transaction) endWorkspaceManifestClaim(transaction);
    guard?.close();
  }
}

async function requestText(
  prompt: ProjectOnboardingPrompt,
  input: Omit<ProjectOnboardingPromptRequest, 'kind'>,
): Promise<string | null> {
  const response = await prompt({ ...input, kind: 'text' });
  return response.kind === 'submit' ? response.value : null;
}

async function requestList(
  prompt: ProjectOnboardingPrompt,
  id: ProjectOnboardingPromptId,
  title: string,
  current: string[],
  badge: string,
): Promise<string[] | null> {
  const response = await requestText(prompt, {
    id,
    title,
    subtitle: 'Comma-separated. Press ENTER to keep the shown value; erase it to select none.',
    badge,
    initialValue: current.join(', '),
  });
  return response === null ? null : parseSelectionList(response);
}

function cloneManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  return {
    ...manifest,
    onboarded: { ...manifest.onboarded },
    agents: { default: manifest.agents.default, enabled: [...manifest.agents.enabled] },
    capabilities: { enabled: [...manifest.capabilities.enabled], disabled: [...manifest.capabilities.disabled] },
    skills: {
      packs: [...manifest.skills.packs],
      enabled: [...manifest.skills.enabled],
      disabled: [...manifest.skills.disabled],
    },
    tools: { profiles: [...manifest.tools.profiles], deny: [...manifest.tools.deny] },
    memory: { tags: [...manifest.memory.tags], captureHint: manifest.memory.captureHint },
    ...(manifest.extra ? { extra: cloneExtra(manifest.extra) } : {}),
  };
}

function cloneExtra(extra: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(extra);
}

function findInstructionFile(workspaceRoot: string): string | undefined {
  for (const name of ['AGENT.md', 'AGENTS.md', 'CLAUDE.md']) {
    const candidate = path.join(workspaceRoot, name);
    let stat: fs.Stats | undefined;
    try { stat = fs.lstatSync(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Unsafe project instruction path: ${candidate}`);
    }
    return candidate;
  }
  return undefined;
}

function skipped(print: (message: string) => void): ProjectOnboardingResult {
  print(chalk.gray('\nWorkspace setup skipped — no project files written.\n'));
  return { status: 'skipped' };
}

function cancelled(print: (message: string) => void): ProjectOnboardingResult {
  print(chalk.gray('\nWorkspace setup cancelled — no project files written.\n'));
  return { status: 'cancelled' };
}

interface FileVersion {
  existed: boolean;
  mode?: number;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}

interface FileSnapshot extends FileVersion {
  contents?: Buffer;
}

interface FileWriteStage {
  attempted: boolean;
  completed: boolean;
  after?: FileSnapshot;
}

function inspectFileVersion(target: string): FileVersion {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe project file: ${target}`);
    return {
      existed: true,
      mode: stat.mode,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false };
    throw error;
  }
}

function snapshotFile(target: string, maxBytes: number): FileSnapshot {
  const before = inspectFileVersion(target);
  if (!before.existed) return before;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`Invalid project file snapshot limit: ${maxBytes}`);
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Unsafe project file: ${target}`);
    }
    if (opened.size > maxBytes) {
      throw new Error(`Project file exceeds ${maxBytes} bytes: ${target}`);
    }

    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (bytesRead <= 0) throw new Error(`Project file changed while it was being read: ${target}`);
      offset += bytesRead;
    }

    const afterDescriptor = fileVersionFromStats(fs.fstatSync(descriptor));
    const afterPath = inspectFileVersion(target);
    if (!fileVersionsMatch(fileVersionFromStats(opened), afterDescriptor) ||
        !fileVersionsMatch(afterDescriptor, afterPath)) {
      throw new Error(`Project file changed while it was being read: ${target}`);
    }
    return { ...afterDescriptor, contents };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fileVersionFromStats(stat: fs.Stats): FileVersion {
  return {
    existed: true,
    mode: stat.mode,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function fileVersionsMatch(left: FileVersion, right: FileVersion): boolean {
  return left.existed === right.existed && (!left.existed || (
    left.mode === right.mode &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  ));
}

function fileSnapshotsAreExact(left: FileSnapshot, right: FileSnapshot): boolean {
  return fileVersionsMatch(left, right) &&
    (!left.existed || left.contents!.equals(right.contents!));
}

function fileSnapshotsMatchAcrossRename(left: FileSnapshot, right: FileSnapshot): boolean {
  if (!left.existed || !right.existed) return false;
  return left.mode === right.mode &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.contents!.equals(right.contents!);
}

function rollbackWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  before: FileSnapshot,
  stage: FileWriteStage,
  maxBytes: number,
): Error | undefined {
  if (!stage.attempted) return undefined;

  let target: string;
  try {
    target = resolveWorkspaceFileForWrite(workspaceRoot, relativePath);
  } catch (error) {
    return new Error(
      `Refusing to roll back ${relativePath} because its path cannot be verified: ${errorMessage(error)}`,
    );
  }
  let current: FileSnapshot;
  try {
    current = snapshotFile(target, maxBytes);
  } catch (error) {
    return new Error(
      `Refusing to roll back ${relativePath} because its current version cannot be verified: ${errorMessage(error)}`,
    );
  }

  if (fileSnapshotsAreExact(before, current)) return undefined;
  if (!stage.completed || !stage.after) {
    return new Error(
      `Refusing to roll back ${relativePath}: a failing writer changed it without an ownership receipt.`,
    );
  }
  if (!fileSnapshotsAreExact(stage.after, current)) {
    return new Error(`Refusing to roll back ${relativePath}: a concurrent writer replaced the committed version.`);
  }

  try {
    const latest = snapshotFile(target, maxBytes);
    if (!fileSnapshotsAreExact(stage.after, latest)) {
      throw new Error(`Concurrent write detected while rolling back ${relativePath}.`);
    }
    if (!before.existed) {
      return removeOwnedWorkspaceFileVersion(
        workspaceRoot,
        target,
        relativePath,
        stage.after,
        maxBytes,
      );
    }
    writeWorkspaceFileAtomic(workspaceRoot, relativePath, before.contents!, {
      mode: before.mode === undefined ? undefined : before.mode & 0o777,
      beforeCommit: () => {
        const latestBeforeCommit = snapshotFile(target, maxBytes);
        if (!fileSnapshotsAreExact(stage.after!, latestBeforeCommit)) {
          throw new Error(`Concurrent write detected while rolling back ${relativePath}.`);
        }
      },
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function removeOwnedWorkspaceFileVersion(
  workspaceRoot: string,
  target: string,
  relativePath: string,
  expected: FileSnapshot,
  maxBytes: number,
): Error | undefined {
  const quarantine = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.rollback`,
  );
  let guard: WorkspaceFileParentGuard;
  try {
    guard = openWorkspaceFileParentGuard(workspaceRoot, relativePath);
    if (guard.canonicalTarget !== target) throw new Error('Workspace rollback target changed.');
  } catch (error) {
    return new Error(`Refusing to remove ${relativePath} during rollback: ${errorMessage(error)}`);
  }
  const accessQuarantine = guard.siblingPath(path.basename(quarantine));
  try {
    invokeProjectOnboardingTestHook(projectOnboardingFilesystemHookForTests, {
      stage: 'before-remove-quarantine',
      target,
      quarantine,
    });
    guard.assertStable();
    fs.renameSync(guard.accessTarget, accessQuarantine);
    guard.fsyncParent();
    guard.assertStable();
  } catch (error) {
    guard.close();
    return new Error(`Refusing to remove ${relativePath} during rollback: ${errorMessage(error)}`);
  }

  let moved: FileSnapshot;
  try {
    moved = snapshotFile(accessQuarantine, maxBytes);
  } catch (error) {
    guard.close();
    return new Error(
      `Refusing to remove ${relativePath}; its rollback quarantine is preserved at ${quarantine}: ${errorMessage(error)}`,
    );
  }
  if (!fileSnapshotsMatchAcrossRename(expected, moved)) {
    const recovery = restoreUnexpectedMovedWorkspaceFile(
      guard.accessTarget,
      accessQuarantine,
      maxBytes,
      guard,
      quarantine,
    );
    guard.close();
    return new Error(
      `Refusing to remove ${relativePath}: a concurrent replacement was moved during rollback (${recovery.message}).`,
    );
  }

  let concurrentTarget: FileSnapshot;
  try {
    guard.assertStable();
    concurrentTarget = snapshotFile(guard.accessTarget, maxBytes);
    const verifiedMoved = snapshotFile(accessQuarantine, maxBytes);
    if (!fileSnapshotsAreExact(moved, verifiedMoved)) {
      return new Error(`Refusing to remove ${relativePath}; its rollback quarantine changed at ${quarantine}.`);
    }
    guard.assertStable();
    fs.unlinkSync(accessQuarantine);
    guard.fsyncParent();
    guard.assertStable();
  } catch (error) {
    return new Error(
      `Refusing to finish removal of ${relativePath}; its rollback quarantine is preserved at ${quarantine}: ${errorMessage(error)}`,
    );
  } finally {
    guard.close();
  }
  return concurrentTarget.existed
    ? new Error(`Rollback removed its owned ${relativePath} version, but a concurrent writer created a replacement.`)
    : undefined;
}

function restoreUnexpectedMovedWorkspaceFile(
  target: string,
  quarantine: string,
  maxBytes: number,
  guard?: Pick<WorkspaceFileParentGuard, 'assertStable' | 'fsyncParent'>,
  displayQuarantine = quarantine,
): { message: string; restored?: FileSnapshot } {
  try {
    guard?.assertStable();
    const current = snapshotFile(target, maxBytes);
    if (current.existed) {
      return { message: `preserved at ${displayQuarantine}; the canonical path is already occupied` };
    }
    guard?.assertStable();
    fs.linkSync(quarantine, target);
    if (guard) guard.fsyncParent();
    else fsyncDirectory(path.dirname(target));
    guard?.assertStable();
    const movedAfterLink = snapshotFile(quarantine, maxBytes);
    const restored = snapshotFile(target, maxBytes);
    if (!fileSnapshotsAreExact(movedAfterLink, restored)) {
      return { message: `preserved at ${displayQuarantine}; the restored link could not be verified` };
    }
    guard?.assertStable();
    fs.unlinkSync(quarantine);
    if (guard) guard.fsyncParent();
    else fsyncDirectory(path.dirname(quarantine));
    guard?.assertStable();
    return {
      message: 'restored to the canonical path',
      restored: snapshotFile(target, maxBytes),
    };
  } catch (error) {
    return { message: `preserved at ${displayQuarantine}; ${errorMessage(error)}` };
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' && code !== 'EISDIR') throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
