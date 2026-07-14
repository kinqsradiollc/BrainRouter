import type { Command } from 'commander';
import { isAgentAdapterId, recordHostedAgentHook } from '@kinqs/brainrouter-core/agent';

export function registerAgentHookCommand(program: Command): void {
  program.command('agent-hook')
    .description('Receive a lifecycle event from a hosted agent CLI.')
    .requiredOption('--adapter <id>')
    .requiredOption('--event <name>')
    .option('--session <id>')
    .option('--message <text>')
    .option('--exit-code <code>')
    .action((opts: { adapter: string; event: string; session?: string; message?: string; exitCode?: string }) => {
      if (!isAgentAdapterId(opts.adapter)) throw new Error(`Unknown agent adapter: ${opts.adapter}`);
      recordHostedAgentHook(process.cwd(), {
        adapterId: opts.adapter,
        event: opts.event,
        ...(opts.session ? { sessionId: opts.session } : {}),
        ...(opts.message ? { message: opts.message } : {}),
        ...(opts.exitCode != null ? { exitCode: Number(opts.exitCode) } : {}),
      });
    });
}
