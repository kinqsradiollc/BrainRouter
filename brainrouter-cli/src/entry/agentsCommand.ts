import type { Command } from 'commander';
import chalk from 'chalk';
import { setCliKnobOverride } from '@kinqs/brainrouter-core/config';
import { applyWorkspaceRoot, findWorkspaceRoot } from '@kinqs/brainrouter-core/workspace';

export function registerAgentsCommand(program: Command): void {
  // `brainrouter agents` — list live + recent child sessions without entering the REPL.
  // Lets scripting integrations (tmux-resurrect, status bars, agent pickers) pull
  // the list without an interactive session. `--json` for machine-readable;
  // default is human-readable.
  program
    .command('agents')
    .description('List child agent sessions (workspace-scoped)')
    .option('--json', 'Emit a single JSON line on stdout for scripting')
    .option('-w, --workspace <path>', 'Workspace root override')
    .action(async (options) => {
      if (options.workspace) setCliKnobOverride({ workspaceOverride: options.workspace });
      const workspace = findWorkspaceRoot();
      applyWorkspaceRoot(workspace.workspaceRoot);
      // Reconcile + list happens locally — no MCP needed.
      const { reconcileStale, listSessions } = await import('@kinqs/brainrouter-core/orchestration');
      reconcileStale(workspace.workspaceRoot);
      const sessions = listSessions(workspace.workspaceRoot);
      if (options.json) {
        const payload = sessions.map((s) => ({
          id: s.id,
          role: s.role,
          status: s.status,
          label: s.label,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt,
          completedAt: s.completedAt,
          prompt: s.prompt,
          usage: s.usage,
          parentSessionKey: s.parentSessionKey,
          finalOutputPreview: s.finalOutput ? String(s.finalOutput).slice(0, 280) : undefined,
        }));
        process.stdout.write(JSON.stringify({ sessions: payload }) + '\n');
        return;
      }
      if (sessions.length === 0) {
        console.log(chalk.yellow('No child agents yet.'));
        console.log(chalk.gray('Start one from the REPL with: /spawn <role> <prompt>'));
        return;
      }
      console.log(chalk.bold(`\nChild Agent Sessions (${sessions.length}):`));
      for (const s of sessions) {
        const status = s.status === 'completed' ? chalk.green(s.status)
          : s.status === 'failed' ? chalk.red(s.status)
          : s.status === 'stale' ? chalk.yellow(s.status)
          : s.status === 'closed' ? chalk.gray(s.status) : chalk.cyan(s.status);
        console.log(`  ${status}  ${chalk.cyan(s.id)}  ${chalk.magenta(s.role)}  ${chalk.gray(s.startedAt)}`);
        if (s.prompt) console.log(chalk.gray(`    ${s.prompt.replace(/\s+/g, ' ').slice(0, 100)}`));
      }
      console.log();
    });
}
