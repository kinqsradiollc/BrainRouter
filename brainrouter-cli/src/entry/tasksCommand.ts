/**
 * MC-B6 — `brainrouter tasks`: suggested-work starters scanned from the
 * workspace's connected GitHub repo (failing checks, merge conflicts,
 * review threads awaiting the author, labeled issues). Read-only: the
 * scanner only GETs; picking a suggestion hands its ready-to-run prompt to
 * the user (`--pick <n>` prints just the prompt for `brainrouter run "$(…)"`).
 */
import type { Command } from 'commander';
import chalk from 'chalk';

export function registerTasksCommand(program: Command): void {
  program
    .command('tasks [action]')
    .description('Suggested work from the linked GitHub repo: suggest (default) lists one-click starters with ready-to-run prompts')
    .option('--repo <owner/name>', 'Scan this repo instead of the workspace-linked one')
    .option('--pick <n>', 'Print ONLY suggestion #n\'s prompt (for: brainrouter run "$(brainrouter tasks suggest --pick 1)")')
    .option('--json', 'Machine-readable output')
    .action(async (action, options) => {
      const { validateTasksInvocation, formatSuggestedTasksList, pickSuggestedPrompt } =
        await import('../runtime/triggers/tasksCommand.js');
      const act = String(action ?? 'suggest').toLowerCase();

      const gateError = validateTasksInvocation(act, options.pick);
      if (gateError) {
        console.error(chalk.red(gateError));
        process.exitCode = 1;
        return;
      }

      const { getCliKnobs } = await import('@kinqs/brainrouter-core/config');
      const { scanSuggestedTasks } = await import('@kinqs/brainrouter-core/triggers');
      const result = await scanSuggestedTasks(process.cwd(), {
        repo: typeof options.repo === 'string' ? options.repo : undefined,
        mentionHandle: getCliKnobs().triggers.mentionHandle,
      });

      if (result.error) {
        if (options.json) {
          process.stdout.write(JSON.stringify({ repo: result.repo, tasks: [], error: result.error }) + '\n');
        } else {
          console.error(chalk.red(result.error));
        }
        process.exitCode = 1;
        return;
      }

      if (options.pick !== undefined) {
        const prompt = pickSuggestedPrompt(result, Number(options.pick));
        if (prompt === null) {
          console.error(chalk.red(`No suggestion #${options.pick} — the scan found ${result.tasks.length}.`));
          process.exitCode = 1;
          return;
        }
        process.stdout.write(prompt + '\n');
        return;
      }

      if (options.json) {
        process.stdout.write(JSON.stringify({ repo: result.repo, tasks: result.tasks, warnings: result.warnings }) + '\n');
        return;
      }
      console.log(formatSuggestedTasksList(result));
    });
}
