/**
 * Delegation / auto-chaining policy slash commands — `/delegation-policy`,
 * `/auto-chain`, `/auto-review`. Read + set the workspace preferences that
 * govern whether/when the agent spawns children and chains follow-ups.
 * Extracted verbatim from the former orchestration/index.ts switch.
 */

import chalk from 'chalk';
import { readPreferences, writePreferences } from '@kinqs/brainrouter-core/session';
import { resolveAutoChainMode, isAutoChainMode, resolveDelegationPolicy, isDelegationPolicy } from '@kinqs/brainrouter-core/orchestration';
import type { CommandContext } from '../_context.js';

export async function handleDelegationPolicy(ctx: CommandContext): Promise<boolean> {
  const { args, agent } = ctx;
  const prefs = readPreferences(agent.workspaceRoot);
  const arg = (args[0] ?? '').toLowerCase();
  const current = resolveDelegationPolicy(prefs);
  if (!arg) {
    console.log(chalk.bold(`\nDelegation policy: ${current === 'auto' ? chalk.gray('auto') : chalk.green(current)}`));
    console.log(chalk.gray('  Controls whether/when the agent may spawn child agents:'));
    console.log(chalk.gray('    auto                    — spawn freely (default)'));
    console.log(chalk.gray('    ask-before-spawn        — confirm before any top-level spawn'));
    console.log(chalk.gray('    ask-before-write-child  — confirm before a write/shell child'));
    console.log(chalk.gray('    no-children             — never spawn'));
    console.log(chalk.gray('  Set with: /delegation-policy auto | ask-before-spawn | ask-before-write-child | no-children\n'));
    return true;
  }
  if (!isDelegationPolicy(arg)) {
    console.log(chalk.yellow(`\nUnknown policy "${arg}". Use: auto | ask-before-spawn | ask-before-write-child | no-children\n`));
    return true;
  }
  writePreferences(agent.workspaceRoot, { delegationPolicy: arg });
  console.log(chalk.green(`\n✓ Delegation policy set to ${arg}.\n`));
  return true;
}

export async function handleAutoChain(ctx: CommandContext): Promise<boolean> {
  const { args, agent } = ctx;
  const prefs = readPreferences(agent.workspaceRoot);
  const arg = (args[0] ?? '').toLowerCase();
  const mode = resolveAutoChainMode(prefs);
  if (!arg) {
    console.log(chalk.bold(`\nAuto-chain: ${mode === 'off' ? chalk.gray('off') : chalk.green(mode)}`));
    console.log(chalk.gray('  After a worker finishes, automatically chain follow-up agents on its output:'));
    console.log(chalk.gray('    review  — a reviewer reads the diff for correctness/regressions'));
    console.log(chalk.gray('    verify  — a verifier runs the tests/build to confirm it works'));
    console.log(chalk.gray('    both    — reviewer + verifier'));
    console.log(chalk.gray('    off     — no follow-ups'));
    console.log(chalk.gray('  Set with: /auto-chain review | verify | both | off\n'));
    return true;
  }
  if (!isAutoChainMode(arg)) {
    console.log(chalk.yellow(`\nUnknown mode "${arg}". Use: review | verify | both | off\n`));
    return true;
  }
  // Keep the legacy boolean in sync so older readers stay consistent.
  writePreferences(agent.workspaceRoot, { autoChain: arg, autoReview: arg === 'review' || arg === 'both' });
  console.log(chalk.green(`\n✓ Auto-chain set to ${arg}.\n`));
  return true;
}

export async function handleAutoReview(ctx: CommandContext): Promise<boolean> {
  const { args, agent } = ctx;
  // Thin alias over /auto-chain (MAS-P4-T4): on → review, off → off.
  const prefs = readPreferences(agent.workspaceRoot);
  const arg = (args[0] ?? '').toLowerCase();
  const mode = resolveAutoChainMode(prefs);
  if (!arg) {
    const on = mode === 'review' || mode === 'both';
    console.log(chalk.bold(`\nAuto-review: ${on ? chalk.green('on') : chalk.gray('off')}`) + chalk.gray(`  (auto-chain mode: ${mode})`));
    console.log(chalk.gray('  Alias for /auto-chain review|off. For verify/both, use /auto-chain.\n'));
    return true;
  }
  const next = arg === 'on' || arg === 'true';
  writePreferences(agent.workspaceRoot, { autoChain: next ? 'review' : 'off', autoReview: next });
  console.log(chalk.green(`\n✓ Auto-review ${next ? 'enabled' : 'disabled'}.\n`));
  return true;
}
