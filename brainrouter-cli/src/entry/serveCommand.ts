/**
 * MC-B1 — `brainrouter serve --triggers`: the opt-in trigger-ingress mode.
 * Default-deny end to end: without `--triggers` the command starts nothing;
 * with it, `cli.triggers.enabled` must be explicitly true; the listener
 * binds loopback:8787 unless the user says otherwise; unknown providers
 * 404; unsigned/badly-signed deliveries 401; non-allowlisted repos drop.
 */
import type { Command } from 'commander';
import chalk from 'chalk';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Long-running service modes. Currently: --triggers (inbound webhook ingress → normalized trigger events).')
    .option('--triggers', 'Serve POST /triggers/{provider}/events (requires cli.triggers.enabled=true)')
    .option('--port <n>', 'Override cli.triggers.port (default 8787)')
    .option('--host <host>', 'Override cli.triggers.host (default 127.0.0.1)')
    .action(async (options) => {
      const { getCliKnobs } = await import('@kinqs/brainrouter-core/config');
      const { validateServeInvocation, resolveServeBind, serveStartupWarnings } =
        await import('../runtime/triggers/serveCommand.js');
      const knobs = getCliKnobs().triggers;

      const gateError = validateServeInvocation(
        { triggers: options.triggers === true, port: options.port, host: options.host },
        knobs,
      );
      if (gateError) {
        console.error(chalk.red(gateError));
        process.exitCode = 1;
        return;
      }

      const triggers = await import('@kinqs/brainrouter-core/triggers');
      const workspaceRoot = process.cwd();
      const githubSecret = triggers.resolveGithubTriggerSecret({
        configSecret: knobs.githubSecret,
        workspaceRoot,
      });
      const slackSecret = triggers.resolveSlackTriggerSecret({
        configSecret: knobs.slackSigningSecret,
        workspaceRoot,
      });
      const bind = resolveServeBind({ port: options.port, host: options.host }, knobs);
      const githubSink = triggers.createGithubTriggerSink({
        workspaceRoot,
        mentionHandle: knobs.mentionHandle,
        // MC-B4 — opt-in CI-failure nudge (idempotent per head sha).
        ciNudge: knobs.ciNudge,
        onResolved: (event, result) => {
          if (result.action === 'enqueued' && result.job) {
            console.log(chalk.cyan(`  trigger → fleet job ${result.job.id} (${event.repo}${event.number ? `#${event.number}` : ''})`));
          }
        },
        onNudged: (event, result) => {
          if (result.action === 'nudged') {
            console.log(chalk.cyan(`  trigger → CI-failure nudge posted (${event.repo}${event.number ? `#${event.number}` : ''})`));
          }
        },
      });
      const slackSink = triggers.createSlackTriggerSink({
        workspaceRoot,
        mentionHandle: knobs.mentionHandle,
        onResolved: (event, result) => {
          if (result.action === 'enqueued' && result.job) {
            console.log(chalk.cyan(`  trigger → fleet job ${result.job.id} (${event.repo})`));
          }
        },
      });

      let handle: Awaited<ReturnType<typeof triggers.startTriggerServer>>;
      try {
        handle = await triggers.startTriggerServer({
          enabled: true, // gated above via cli.triggers.enabled
          host: bind.host,
          port: bind.port,
          allowedRepos: knobs.allowedRepos,
          workspaceRoot,
          secrets: { github: githubSecret, slack: slackSecret },
          onEvent: async (event) => {
            await githubSink(event);
            await slackSink(event);
          },
        });
      } catch (error) {
        console.error(chalk.red(`Trigger ingress failed to start: ${(error as Error).message}`));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green(`Trigger ingress listening on http://${handle.host}:${handle.port}`));
      console.log(chalk.gray(`  Providers: ${triggers.listTriggerProviders().join(', ')}  ·  route: POST /triggers/{provider}/events`));
      for (const warning of serveStartupWarnings(knobs, { github: githubSecret, slack: slackSecret })) {
        console.log(chalk.yellow(`  ${warning}`));
      }

      const shutdown = async () => {
        try { await handle.close(); } catch { /* already down */ }
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
