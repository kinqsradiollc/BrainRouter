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
  type WorkspaceManifest,
  type WorkspaceProfileId,
} from '@kinqs/brainrouter-core/workspace';
import { askChoice, askYesNo, getActiveReadline, NoTTYError } from '../../prompt/cliPrompt.js';
import { initAgentMd } from '../../../prompt/initAgentMd.js';

export interface ProfileSuggestion {
  profile: WorkspaceProfileId;
  reasons: string[];
}

/**
 * Deterministic profile suggestion from repo signals. Ordered rules, first
 * match wins; falls back to `custom` when nothing is recognizable. Never
 * throws — unreadable directories just contribute no signal.
 */
export function suggestWorkspaceProfile(workspaceRoot: string): ProfileSuggestion {
  const has = (rel: string): boolean => {
    try { return fs.existsSync(path.join(workspaceRoot, rel)); } catch { return false; }
  };
  const list = (rel = '.'): string[] => {
    try { return fs.readdirSync(path.join(workspaceRoot, rel)); } catch { return []; }
  };
  const rootEntries = list();
  const rootFiles = rootEntries.filter((name) => {
    try { return fs.statSync(path.join(workspaceRoot, name)).isFile(); } catch { return false; }
  });

  // Data science: notebooks are the strongest, least ambiguous signal.
  if (rootFiles.some((name) => name.endsWith('.ipynb')) || has('notebooks') || has('dvc.yaml')) {
    return { profile: 'data-science', reasons: ['notebooks / data-pipeline files present'] };
  }

  // Engineering: any mainstream build/manifest marker.
  const codeMarkers: Array<[string, string]> = [
    ['package.json', 'Node.js (`package.json`)'],
    ['go.mod', 'Go (`go.mod`)'],
    ['Cargo.toml', 'Rust (`Cargo.toml`)'],
    ['pyproject.toml', 'Python (`pyproject.toml`)'],
    ['setup.py', 'Python (`setup.py`)'],
    ['pom.xml', 'Java (`pom.xml`)'],
    ['build.gradle', 'Gradle (`build.gradle`)'],
    ['CMakeLists.txt', 'C/C++ (`CMakeLists.txt`)'],
  ];
  const codeHits = codeMarkers.filter(([marker]) => has(marker)).map(([, label]) => label);
  if (has('src') && codeHits.length === 0) codeHits.push('source tree (`src/`)');
  if (codeHits.length > 0) return { profile: 'engineering', reasons: codeHits };

  // Research: bibliography / paper conventions.
  if (rootFiles.some((name) => name.endsWith('.bib')) || has('papers') || has('references')) {
    return { profile: 'research', reasons: ['bibliography / papers present'] };
  }

  // Writing: a markdown-dominant tree with no code signals.
  const mdCount = rootFiles.filter((name) => name.endsWith('.md')).length;
  if (mdCount >= 3) return { profile: 'writing', reasons: [`markdown-dominant (${mdCount} .md files, no code markers)`] };

  return { profile: 'custom', reasons: ['no recognizable signals — starting empty'] };
}

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

  // Engineering hosts more than one persona — let the user pick the default.
  let overrides: Parameters<typeof createWorkspaceManifest>[0]['overrides'];
  if (profile === 'engineering') {
    try {
      const persona = await askChoice('Default agent persona for this workspace?', [
        { label: 'engineer', description: 'General software engineering — code, tests, reviews, releases.' },
        { label: 'frontend-builder', description: 'Design-system-first frontend building over the same engineering profile.' },
      ]);
      if (persona === 'frontend-builder') {
        overrides = { agents: { default: 'frontend-builder', enabled: ['frontend-builder', 'engineer'] } };
      }
    } catch {
      // Persona pick cancelled → keep the preset default; profile choice stands.
    }
  }

  const manifest = createWorkspaceManifest({
    name: path.basename(workspaceRoot),
    profile,
    by: 'wizard',
    overrides,
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
