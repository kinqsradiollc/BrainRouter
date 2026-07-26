/** Bounded workspace scan plus editable, confirmation-only CLI review. */
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import {
  completeWorkspaceOnboardingWithModel,
} from '@kinqs/brainrouter-core/agent';
import type { Config, LLMConfig } from '@kinqs/brainrouter-core/config';
import {
  buildWorkspaceOnboardingPreview,
  buildWorkspaceOnboardingSources,
  commitReviewedWorkspaceOnboarding,
  inspectWorkspaceOnboardingReview,
  isWorkspaceProfileId,
  loadWorkspaceManifest,
  normalizeWorkspaceManifest,
  previewReviewedWorkspaceInstruction,
  proposeWorkspaceOnboarding,
  workspaceProfilesForOnboarding,
  workspaceManifestPath,
  type AssistedOnboardingOptions,
  type AssistedOnboardingResult,
  type WorkspaceOnboardingModelCompletion,
  type WorkspaceOnboardingProposal,
  type WorkspaceOnboardingReviewRevision,
} from '@kinqs/brainrouter-core/workspace';
import { computeReviewChunks } from '@kinqs/brainrouter-core/write';
import {
  collectProjectOnboardingEdits,
  formatManifestSummary,
  promptProjectOnboarding,
  type ProjectOnboardingOptions,
  type ProjectOnboardingPrompt,
  type ProjectOnboardingResult,
} from './projectOnboard.js';
import {
  createProjectOnboardingDraft,
  finalizeCatalogReviewedProjectOnboarding,
} from './onboardingDraft.js';

export interface ProjectOnboardingScanOptions {
  prompt?: ProjectOnboardingPrompt;
  print?: (message: string) => void;
  propose?: (options: AssistedOnboardingOptions) => Promise<AssistedOnboardingResult>;
  config?: Config;
  getConfig?: () => Config;
}

export interface ProjectOnboardingAgentOptions extends Omit<ProjectOnboardingScanOptions, 'propose'> {
  /** Test seam; production uses the shared forced-tool model adapter. */
  complete?: WorkspaceOnboardingModelCompletion;
}

/**
 * Make one bounded proposal call through the active session model, then use
 * the same editable, stale-safe review and commit boundary as `/init scan`.
 */
export async function runProjectOnboardingAgent(
  workspaceRoot: string,
  llm: LLMConfig,
  description?: string,
  options: ProjectOnboardingAgentOptions = {},
): Promise<ProjectOnboardingResult> {
  const {
    complete = (request) => completeWorkspaceOnboardingWithModel(llm, request),
    ...reviewOptions
  } = options;
  const userDescription = description?.trim();
  return runProjectOnboardingScan(workspaceRoot, {
    ...reviewOptions,
    propose: (proposalOptions) => proposeWorkspaceOnboarding({
      ...proposalOptions,
      ...(userDescription ? { description: userDescription } : {}),
      complete,
    }),
  });
}

/**
 * Build one bounded deterministic proposal, then route it through the same
 * editable, stale-safe confirmation boundary used by assisted setup. The scan
 * and every prompt are read-only; only the final confirmation may commit.
 */
export async function runProjectOnboardingScan(
  workspaceRoot: string,
  options: ProjectOnboardingScanOptions = {},
): Promise<ProjectOnboardingResult> {
  const root = path.resolve(workspaceRoot);
  const reviewBefore = inspectWorkspaceOnboardingReview(root);
  const existing = loadWorkspaceManifest(root);
  if (!existing && fs.existsSync(workspaceManifestPath(root))) {
    throw new Error(
      'Workspace manifest exists but cannot be read safely. Repair or remove .brainrouter/workspace.json before retrying; no project files were written.',
    );
  }

  const result = await (options.propose ?? proposeWorkspaceOnboarding)({
    workspaceRoot: root,
    selectedInstructionPath: 'AGENT.md',
  });
  const review = inspectWorkspaceOnboardingReview(root);
  if (!sameRevision(reviewBefore.revision, review.revision)) {
    throw new Error('Workspace setup changed during the scan. Re-run workspace onboarding to review the latest version.');
  }

  const proposal: WorkspaceOnboardingProposal = {
    ...result.proposal,
    manifest: normalizeWorkspaceManifest({
      ...result.proposal.manifest,
      ...(existing ? {
        version: existing.version,
        name: existing.name,
        onboarded: existing.onboarded,
      } : {}),
      ...(existing?.extra ? { extra: existing.extra } : {}),
    }),
  };
  const print = options.print ?? console.log;
  print(formatScanSummary(result));
  return reviewProjectOnboardingProposal(root, proposal, review.revision, {
    prompt: options.prompt,
    print,
    config: options.config,
    getConfig: options.getConfig,
  });
}

/** Review and optionally commit one already validated proposal. */
export async function reviewProjectOnboardingProposal(
  workspaceRoot: string,
  proposal: WorkspaceOnboardingProposal,
  expected: WorkspaceOnboardingReviewRevision,
  options: Pick<ProjectOnboardingOptions, 'prompt' | 'print' | 'config' | 'getConfig'> = {},
): Promise<ProjectOnboardingResult> {
  const root = path.resolve(workspaceRoot);
  const prompt = options.prompt ?? promptProjectOnboarding;
  const print = options.print ?? console.log;
  const sources = buildWorkspaceOnboardingSources(
    root,
    options.getConfig?.() ?? options.config,
  );
  const catalog = sources.catalog;
  const start = await prompt({
    id: 'start',
    kind: 'choice',
    title: proposal.source === 'model' ? 'Review assisted workspace setup' : 'Review workspace scan',
    subtitle: `${proposal.reasons.join('; ')}. Nothing changes until the final confirmation.`,
    badge: 'Workspace proposal',
    rows: [
      { id: 'continue', label: 'Review and edit', description: 'Inspect every proposed field' },
      { id: 'cancel', label: 'Cancel', description: 'Leave project files unchanged' },
    ],
    initialChoice: 'continue',
  });
  if (start.kind !== 'submit' || start.value !== 'continue') return cancelled(print);

  const profileResponse = await prompt({
    id: 'profile',
    kind: 'choice',
    title: 'Workspace profile',
    subtitle: 'The scan is a starting point. You control the saved profile.',
    badge: 'Step 1 of 4',
    rows: workspaceProfilesForOnboarding().map((preset) => ({
      id: preset.id,
      label: preset.label,
      value: preset.id === proposal.manifest.profile ? 'proposed' : undefined,
      description: preset.description,
    })),
    initialChoice: proposal.manifest.profile,
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
    existing: proposal.manifest,
    source: 'agent',
  });
  const edits = await collectProjectOnboardingEdits(prompt, draft, catalog);
  if (!edits) return cancelled(print);
  const reviewed = finalizeCatalogReviewedProjectOnboarding(draft, edits, catalog);
  print(`\n${formatManifestSummary(reviewed, buildWorkspaceOnboardingPreview(
    reviewed,
    catalog,
    sources.orchestrationProfiles,
  ))}\n`);

  let instruction: WorkspaceOnboardingProposal['instruction'];
  if (proposal.instruction && proposal.instruction.path !== 'AGENT.md') {
    throw new Error('Unsupported workspace instruction proposal path.');
  }
  if (proposal.instruction && reviewed.instructions === proposal.instruction.path) {
    const preview = previewReviewedWorkspaceInstruction(root, {
      expected,
      instruction: {
        path: 'AGENT.md',
        contents: proposal.instruction.contents,
      },
    });
    if (preview.original === preview.proposed) {
      print(chalk.gray('\nAGENT.md already matches the proposal; no instruction-file write is needed.\n'));
    } else {
      print(`\n${chalk.bold('Proposed AGENT.md change')}\n${formatInstructionDiff(preview.original, preview.proposed)}\n`);
      const instructionResponse = await prompt({
        id: 'instruction-change',
        kind: 'choice',
        title: 'Include the reviewed AGENT.md change?',
        subtitle: 'Rejecting this change keeps the current file and still lets you save the manifest.',
        badge: 'Step 4 of 4 · instruction diff',
        rows: [
          { id: 'apply', label: 'Include change', description: 'Commit it atomically with the manifest' },
          { id: 'keep', label: 'Keep current file', description: 'Save only the workspace manifest' },
          { id: 'cancel', label: 'Cancel', description: 'Leave all project files unchanged' },
        ],
        initialChoice: 'apply',
      });
      if (instructionResponse.kind !== 'submit' || instructionResponse.value === 'cancel') {
        return cancelled(print);
      }
      if (instructionResponse.value === 'apply') instruction = proposal.instruction;
    }
  }

  const confirm = await prompt({
    id: 'confirm',
    kind: 'choice',
    title: 'Apply this workspace proposal?',
    subtitle: instruction
      ? 'This writes the manifest and reviewed AGENT.md change as one recoverable update.'
      : 'This writes only .brainrouter/workspace.json.',
    badge: 'Final confirmation',
    rows: [
      { id: 'save', label: 'Apply proposal', description: instruction ? 'Manifest + AGENT.md' : 'Workspace manifest' },
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
    expected,
    ...(instruction ? { instruction: { path: 'AGENT.md', contents: instruction.contents } } : {}),
  });
  print(chalk.green(`\n✓ Onboarded — wrote ${path.relative(root, committed.manifestPath)}`));
  if (committed.instructionPath) print(chalk.green(`✓ Updated ${committed.instructionPath}`));
  print(`\n${formatManifestSummary(committed.manifest, buildWorkspaceOnboardingPreview(
    committed.manifest,
    currentSources.catalog,
    currentSources.orchestrationProfiles,
  ))}\n`);
  return { status: 'committed', manifest: committed.manifest, manifestPath: committed.manifestPath };
}

export function formatInstructionDiff(original: string, proposed: string): string {
  const lines = ['--- a/AGENT.md', '+++ b/AGENT.md'];
  const originalLines = original.split('\n');
  const proposedLines = proposed.split('\n');
  // Keep the line-level LCS below a small fixed matrix. Large, newline-dense
  // proposals remain fully reviewable as one bounded replacement.
  if (originalLines.length * proposedLines.length > 250_000) {
    lines.push(...originalLines.map((line) => `-${line}`));
    lines.push(...proposedLines.map((line) => `+${line}`));
    return lines.join('\n');
  }
  for (const chunk of computeReviewChunks(original, proposed)) {
    if (chunk.op === 'equal') {
      lines.push(...prefixDiffLines(chunk.original, ' '));
      continue;
    }
    if (chunk.op === 'delete' || chunk.op === 'replace') {
      lines.push(...prefixDiffLines(chunk.original, '-'));
    }
    if (chunk.op === 'insert' || chunk.op === 'replace') {
      lines.push(...prefixDiffLines(chunk.revised, '+'));
    }
  }
  return lines.join('\n');
}

function formatScanSummary(result: AssistedOnboardingResult): string {
  const { stats, stoppedBy } = result.scan;
  const limit = stoppedBy.length > 0 ? `; limits: ${stoppedBy.join(', ')}` : '';
  return [
    `\n${chalk.bold('Workspace scan')}: ${stats.filesRead} files, ${stats.entriesVisited} entries, ${stats.bytesRead} bytes${limit}`,
    `${chalk.bold('Proposal source')}: ${proposalSourceLabel(result)}\n`,
  ].join('\n');
}

function proposalSourceLabel(result: AssistedOnboardingResult): string {
  if (result.proposal.source === 'model') return 'managed model';
  if (!result.modelAttempted) return 'deterministic scan';
  switch (result.fallbackReason) {
    case 'model-timeout': return 'deterministic fallback (model timed out)';
    case 'invalid-model-output': return 'deterministic fallback (model response was invalid)';
    case 'model-error': return 'deterministic fallback (model request failed)';
    default: return 'deterministic fallback (model unavailable)';
  }
}

function prefixDiffLines(value: string, prefix: ' ' | '-' | '+'): string[] {
  return value.split('\n').map((line) => `${prefix}${line}`);
}

function sameRevision(
  left: WorkspaceOnboardingReviewRevision,
  right: WorkspaceOnboardingReviewRevision,
): boolean {
  return left.root === right.root && left.manifest === right.manifest && left.instruction === right.instruction;
}

function cancelled(print: (message: string) => void): ProjectOnboardingResult {
  print(chalk.gray('\nCancelled — nothing written.\n'));
  return { status: 'cancelled' };
}
