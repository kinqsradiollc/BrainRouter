import chalk from 'chalk';
import type { CommandContext } from './_context.js';
import { initAgentMd } from '../../prompt/initAgentMd.js';
import { runWizard } from '../wizard/runner.js';

/**
 * `/init` slash command — 0.3.7 redesign.
 *
 * Two behaviours under one verb, picked by the first argument:
 *
 *   - `/init` (bare) — re-run the onboarding wizard inside the REPL.
 *     The REPL already owns the readline, so the wizard reuses it
 *     (`ownsReadline: false`). Aborting at any step leaves disk
 *     untouched.
 *   - `/init agentmd` — back-compat alias for the 0.3.6 behaviour
 *     that only scaffolded AGENT.md (the wizard now folds this in as
 *     its final step, but users with muscle memory keep the lever).
 *
 * The auto-trigger on REPL start (when no `~/.config/brainrouter/config.json`
 * exists) calls `runWizard` directly from `index.ts` with
 * `ownsReadline: true`. That's a separate entry point — this slash
 * handler is only for the in-REPL invocation.
 */
export async function tryHandleInitCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, repl } = ctx;
  if (command !== '/init') return false;

  // Back-compat: explicit subcommand keeps the 0.3.6 one-shot behaviour.
  if (args[0]?.toLowerCase() === 'agentmd' || args[0]?.toLowerCase() === 'agent') {
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

  // Wizard mode. The REPL owns stdin / rl; the wizard reuses both.
  try {
    const result = await runWizard({
      ownsReadline: false,
      workspaceRoot: agent.workspaceRoot,
    });
    if (result.config?.llm) {
      // Live-update the in-flight agent so the next turn uses the new
      // model / endpoint without forcing a restart. Keep the wrapper's
      // existing MCP connection — switching MCP needs a restart for
      // now (next item on the polish list).
      const llm = result.config.llm;
      agent.setModel(llm.model);
      // The agent's internal openai client cached the endpoint at
      // construction time — repl users may need a fresh CLI process
      // for endpoint changes to fully take effect.
      console.log(chalk.gray('  (note: endpoint / API-key changes apply on the next CLI restart)\n'));
    }
    repl.refreshPromptForMode();
  } catch (err: any) {
    console.error(chalk.red(`\n/init failed: ${err?.message ?? err}\n`));
  }
  return true;
}
