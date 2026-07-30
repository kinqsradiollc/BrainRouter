import type { Command } from 'commander';
import { applyWorkspaceRoot, findWorkspaceRoot } from '@kinqs/brainrouter-core/workspace';
import { getCliKnobs, setCliKnobOverride } from '@kinqs/brainrouter-core/config';
import {
  createCliRuntimeRunnerClient,
  formatCliRuntimeRunnerSummary,
  summarizeCliRuntimeRunner,
} from '../runtime/runner/runnerClient.js';

export function registerRunnerCommand(program: Command): void {
  const cmd = program
    .command('runner')
    .description('Inspect the configured agent runner client')
    .option('-w, --workspace <path>', 'Workspace root override');

  cmd
    .command('info')
    .description('Show whether the CLI runner client is local or remote')
    .option('--json', 'Emit a single JSON line')
    .action(async (options) => {
      const parentOptions = cmd.opts();
      if (parentOptions.workspace) setCliKnobOverride({ workspaceOverride: parentOptions.workspace });
      const workspace = findWorkspaceRoot();
      applyWorkspaceRoot(workspace.workspaceRoot);
      const knobs = getCliKnobs();
      const client = createCliRuntimeRunnerClient({
        workspaceRoot: workspace.workspaceRoot,
        executeTurn: async () => {
          throw new Error('No turn executor is attached to this runner inspection command.');
        },
      });
      const summary = summarizeCliRuntimeRunner(client, knobs.runtime.remoteUrl);
      process.stdout.write(options.json ? `${JSON.stringify(summary)}\n` : formatCliRuntimeRunnerSummary(summary));
    });
}
