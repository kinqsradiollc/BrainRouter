import chalk from 'chalk';
import type { CommandContext } from '../_context.js';
import { initAgentMd } from '../../../prompt/initAgentMd.js';
import { runWizard } from '../../ink/wizard/runWizard.js';
import { safeOnboardingError } from './onboardingErrors.js';
import { runProjectOnboarding, suggestWorkspaceProfile } from './projectOnboard.js';

/**
 * `/init` fronts the two distinct setup lifecycles.
 *
 * The CLI has TWO onboardings, and `/init` now fronts the PROJECT one:
 *
 *   - `/init` (bare) — PROJECT onboarding for the current workspace: profile
 *     reviewed editor for agents, capabilities, skills, tools, and memory,
 *     then writes `.brainrouter/workspace.json` only after confirmation. In an
 *     already-onboarded workspace it prints the manifest summary instead.
 *     Cancelling at any step writes nothing.
 *   - `/init --edit` — reopen the same reviewed editor for an existing manifest.
 *   - `/init config` — the GLOBAL first-run wizard (endpoint/model/MCP; the
 *     pre-W2 bare behaviour). The auto-trigger on REPL start (no
 *     `~/.config/brainrouter/config.json`) still calls `runWizard` directly
 *     from `index.ts` — that entry point is unchanged.
 *   - `/init scan` — print the detected profile suggestion + reasons only;
 *     never writes.
 *   - `/init agentmd` — back-compat alias for the 0.3.6 behaviour that only
 *     scaffolds AGENT.md.
 */
export async function tryHandleInitCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, repl } = ctx;
  if (command !== '/init') return false;
  const sub = args[0]?.toLowerCase();

  // Back-compat: explicit subcommand keeps the 0.3.6 one-shot behaviour.
  if (sub === 'agentmd' || sub === 'agent') {
    const result = initAgentMd(agent.workspaceRoot);
    if (result.status === 'created') {
      console.log(chalk.green(`\n✓ Created ${result.path}`));
      console.log(chalk.gray('  Edit it to describe your project — any AGENT.md-aware agent will read it.\n'));
    } else {
      console.log(chalk.yellow(`\nFile already exists: ${result.path}`));
      console.log(chalk.gray('  Run `/init agentmd --overwrite` if you really want to start fresh (TODO).\n'));
    }
    return true;
  }

  // Read-only profile detection — show what bare `/init` would suggest.
  if (sub === 'scan') {
    const suggestion = suggestWorkspaceProfile(agent.workspaceRoot);
    console.log(`\n${chalk.bold('Detected profile')}: ${suggestion.profile}`);
    console.log(chalk.gray(`  ${suggestion.reasons.join('; ')}`));
    console.log(chalk.gray('  Run `/init` to onboard this workspace with it.\n'));
    return true;
  }

  if (sub === '--edit') {
    try {
      await runProjectOnboarding(agent.workspaceRoot, { edit: true });
    } catch (err: any) {
      console.error(chalk.red(`\n/init --edit failed: ${safeOnboardingError(err)}\n`));
    }
    return true;
  }

  // GLOBAL config wizard (the pre-W2 bare behaviour). Ink owns stdin while
  // mounted; the REPL's readline resumes naturally on unmount.
  if (sub === 'config' || sub === 'setup') {
    try {
      const result = await runWizard({
        workspaceRoot: agent.workspaceRoot,
      });
      if (result.config?.llm) {
        // Live-update the in-flight agent so the next turn uses the new
        // model / endpoint without forcing a restart. Keep the wrapper's
        // existing MCP connection — switching MCP needs a restart for now.
        const llm = result.config.llm;
        agent.setModel(llm.model);
        // The agent's internal openai client cached the endpoint at
        // construction time — repl users may need a fresh CLI process
        // for endpoint changes to fully take effect.
        console.log(chalk.gray('  (note: endpoint / API-key changes apply on the next CLI restart)\n'));
      }
      repl.refreshPromptForMode();
    } catch (err: any) {
      console.error(chalk.red(`\n/init config failed: ${safeOnboardingError(err)}\n`));
    }
    return true;
  }

  // Bare `/init` — PROJECT onboarding (prints the summary when already onboarded).
  try {
    await runProjectOnboarding(agent.workspaceRoot);
    console.log(chalk.gray('  Global setup wizard: `/init config` · instruction file: `/init agentmd`\n'));
  } catch (err: any) {
    console.error(chalk.red(`\n/init failed: ${safeOnboardingError(err)}\n`));
  }
  return true;
}
