/**
 * MC-B1 — `brainrouter serve --triggers`: the opt-in trigger-ingress mode.
 * Provider-router v2 also adds `--router` for the local OpenAI-compatible
 * gateway. Default-deny end to end: without a mode flag the command starts nothing;
 * with it, `cli.triggers.enabled` must be explicitly true; the listener
 * binds loopback:8787 unless the user says otherwise; unknown providers
 * 404; unsigned/badly-signed deliveries 401; non-allowlisted repos drop.
 */
import type { Command } from 'commander';
import chalk from 'chalk';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Long-running service modes: --triggers or --router.')
    .option('--triggers', 'Serve POST /triggers/{provider}/events (requires cli.triggers.enabled=true)')
    .option('--router', 'Serve /router/v1 OpenAI-compatible provider-router gateway (requires cli.router.serve=true)')
    .option('--port <n>', 'Override cli.triggers.port (default 8787)')
    .option('--host <host>', 'Override cli.triggers.host (default 127.0.0.1)')
    .action(async (options) => {
      const { getCliKnobs, loadConfig } = await import('@kinqs/brainrouter-core/config');
      const { validateServeInvocation, resolveServeBind, serveStartupWarnings } =
        await import('../runtime/triggers/serveCommand.js');
      if (options.router === true) {
        if (options.triggers === true) {
          console.error(chalk.red('Choose one serve mode at a time: --router or --triggers.'));
          process.exitCode = 1;
          return;
        }
        const config = loadConfig();
        const router = getCliKnobs().router;
        if (router.serve !== true) {
          console.error(chalk.red('Router gateway is disabled (cli.router.serve is false — the default). Set cli.router.serve=true to opt in.'));
          process.exitCode = 1;
          return;
        }
        const rawPort = options.port != null ? parseInt(String(options.port), 10) : NaN;
        const bind = {
          host: typeof options.host === 'string' && options.host.trim() ? options.host.trim() : router.serveHost,
          port: Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65_535 ? rawPort : router.servePort,
        };
        // A key is OPTIONAL on loopback (local dev); an off-loopback bind MUST
        // carry one — an open network port with no auth is never a safe default.
        const loopback = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i.test(bind.host);
        if (!loopback && !router.serveKey) {
          console.error(chalk.red('A gateway key is required when binding to a non-loopback host — set cli.router.serveKey.'));
          process.exitCode = 1;
          return;
        }
        const { startRouterGateway } = await import('@kinqs/brainrouter-core/provider');
        let handle: Awaited<ReturnType<typeof startRouterGateway>>;
        try {
          handle = await startRouterGateway({
            config,
            host: bind.host,
            port: bind.port,
            serveKey: router.serveKey || undefined,
          });
        } catch (error) {
          console.error(chalk.red(`Router gateway failed to start: ${(error as Error).message}`));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`Router gateway listening on http://${handle.host}:${handle.port}`));
        console.log(chalk.gray('  Routes: GET /router/v1/models · POST /router/v1/chat/completions'));
        const shutdown = async () => {
          try { await handle.close(); } catch { /* already down */ }
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        return;
      }
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
      const gitlabSecret = triggers.resolveGitlabTriggerSecret({
        configSecret: knobs.gitlabSecret,
        workspaceRoot,
      });
      const jiraSecret = triggers.resolveJiraTriggerSecret({
        configSecret: knobs.jiraSecret,
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
      const externalSink = triggers.createExternalTriggerSink({
        workspaceRoot,
        mentionHandle: knobs.mentionHandle,
        onResolved: (event, result) => {
          if (result.action === 'enqueued' && result.job) {
            console.log(chalk.cyan(`  trigger → fleet job ${result.job.id} (${event.provider}:${event.repo}${event.number ? `#${event.number}` : ''})`));
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
          secrets: { github: githubSecret, slack: slackSecret, gitlab: gitlabSecret, jira: jiraSecret },
          onEvent: async (event) => {
            await githubSink(event);
            await slackSink(event);
            await externalSink(event);
          },
        });
      } catch (error) {
        console.error(chalk.red(`Trigger ingress failed to start: ${(error as Error).message}`));
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green(`Trigger ingress listening on http://${handle.host}:${handle.port}`));
      console.log(chalk.gray(`  Providers: ${triggers.listTriggerProviders().join(', ')}  ·  route: POST /triggers/{provider}/events`));
      for (const warning of serveStartupWarnings(knobs, { github: githubSecret, slack: slackSecret, gitlab: gitlabSecret, jira: jiraSecret })) {
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
