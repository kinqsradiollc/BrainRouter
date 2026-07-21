/**
 * PROJECT onboarding (ADR-021 W2) — the second of the CLI's two onboardings.
 *
 * Distinct from the GLOBAL first-run wizard (endpoint/model/MCP, marker at
 * `~/.config/brainrouter/.onboarded`): this flow onboards ONE workspace by
 * writing `.brainrouter/workspace.json` through the core manifest chokepoint.
 * Fully offline — no brain connection. Cancelling at any step writes nothing.
 *
 * The profile SUGGESTION is deterministic (filesystem signals only, no LLM):
 * the wizard shows why it guessed what it guessed, and the user always picks.
 */
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import {
  WORKSPACE_PROFILES,
  createWorkspaceManifest,
  isWorkspaceOnboarded,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  suggestWorkspaceProfile,
  type WorkspaceManifest,
  type WorkspaceProfileId,
} from '@kinqs/brainrouter-core/workspace';
import { askYesNo, getActiveReadline, NoTTYError } from '../../prompt/cliPrompt.js';
import { initAgentMd } from '../../../prompt/initAgentMd.js';

// The suggestion logic moved to core (W3a) so desktop onboarding guesses
// identically; re-exported here to keep this module's surface stable.
export { suggestWorkspaceProfile, type ProfileSuggestion } from '@kinqs/brainrouter-core/workspace';

/**
 * Parse the user's answer to the numbered profile prompt. Accepts an index
 * (1-based), a profile id, or a unique label prefix; empty input takes the
 * suggested default. Returns null for unparseable input (the wizard re-asks).
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

/** Human summary of an existing manifest — the onboarded `/init` output. */
export function formatManifestSummary(manifest: WorkspaceManifest): string {
  const lines = [
    `${chalk.bold('Workspace')}: ${manifest.name}  ${chalk.gray(`(profile: ${manifest.profile})`)}`,
    `  agents: ${manifest.agents.default || chalk.gray('(none)')}${manifest.agents.enabled.length > 1 ? chalk.gray(` +${manifest.agents.enabled.length - 1} enabled`) : ''}`,
    `  capabilities: ${manifest.capabilities.enabled.join(', ') || chalk.gray('(none)')}${manifest.capabilities.disabled.length ? ` (${manifest.capabilities.disabled.length} disabled)` : ''}`,
    `  skills: ${manifest.skills.packs.length} pack(s), ${manifest.skills.enabled.length} enabled${manifest.skills.disabled.length ? `, ${manifest.skills.disabled.length} disabled` : ''}`,
    `  tools:  ${manifest.tools.profiles.join(', ') || chalk.gray('(none)')}`,
    `  memory: ${manifest.memory.tags.join(', ') || chalk.gray('(no tags)')}`,
    chalk.gray(`  onboarded ${manifest.onboarded.at || '(unknown)'} via ${manifest.onboarded.by} — edit .brainrouter/workspace.json or re-run /init scan`),
  ];
  return lines.join('\n');
}

function askLine(question: string): Promise<string> {
  const rl = getActiveReadline();
  if (!rl) throw new NoTTYError('project onboarding needs an interactive terminal');
  return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * Interactive project onboarding. Returns true when a manifest was written.
 * Every step is skippable; aborting (Ctrl+C at a picker, or `q`) writes
 * NOTHING — an un-onboarded workspace stays exactly as it was.
 */
export async function runProjectOnboarding(workspaceRoot: string): Promise<boolean> {
  if (isWorkspaceOnboarded(workspaceRoot)) {
    const manifest = loadWorkspaceManifest(workspaceRoot);
    if (manifest) console.log(`\n${formatManifestSummary(manifest)}\n`);
    return false;
  }

  const suggestion = suggestWorkspaceProfile(workspaceRoot);
  console.log(chalk.bold('\n◆ Project onboarding — what kind of workspace is this?\n'));
  WORKSPACE_PROFILES.forEach((preset, index) => {
    const marker = preset.id === suggestion.profile ? chalk.cyan(' (detected)') : '';
    console.log(`  ${index + 1}. ${chalk.bold(preset.label)}${marker} — ${chalk.gray(preset.description)}`);
  });
  console.log(chalk.gray(`\n  detected: ${suggestion.reasons.join('; ')}`));

  let profile: WorkspaceProfileId | null = null;
  for (let attempt = 0; attempt < 3 && profile === null; attempt += 1) {
    const suggestedIndex = WORKSPACE_PROFILES.findIndex((preset) => preset.id === suggestion.profile) + 1;
    const answer = await askLine(chalk.bold(`\nChoice [${suggestedIndex}] (q to cancel): `));
    if (answer.trim().toLowerCase() === 'q') {
      console.log(chalk.gray('\nCancelled — nothing written.\n'));
      return false;
    }
    profile = resolveProfileAnswer(answer, suggestion.profile);
    if (profile === null) console.log(chalk.yellow('  Enter a number from the list, a profile name, or press ENTER for the default.'));
  }
  if (profile === null) {
    console.log(chalk.gray('\nNo valid choice — nothing written.\n'));
    return false;
  }

  const manifest = createWorkspaceManifest({
    name: path.basename(workspaceRoot),
    profile,
    by: 'wizard',
  });
  const target = saveWorkspaceManifest(workspaceRoot, manifest);
  console.log(chalk.green(`\n✓ Onboarded — wrote ${path.relative(workspaceRoot, target)}`));

  // Fold in the instruction-file scaffold (the 0.3.6 `/init agentmd` step).
  const hasInstructions = ['AGENT.md', 'AGENTS.md', 'CLAUDE.md'].some((name) => fs.existsSync(path.join(workspaceRoot, name)));
  if (!hasInstructions) {
    try {
      if (await askYesNo('Scaffold AGENT.md for this project?', true)) {
        const result = initAgentMd(workspaceRoot);
        if (result.status === 'created') console.log(chalk.green(`✓ Created ${path.relative(workspaceRoot, result.path)}`));
      }
    } catch { /* no TTY for the follow-up — manifest is already written, fine */ }
  }

  console.log(`\n${formatManifestSummary(manifest)}\n`);
  return true;
}
