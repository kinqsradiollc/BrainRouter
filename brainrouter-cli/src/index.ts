#!/usr/bin/env node

/**
 * Filter out Node.js platform warnings that the user has no way to act on
 * and that scroll real CLI banner content off-screen on short terminals.
 *
 *   - `ExperimentalWarning: SQLite is an experimental feature` — emitted by
 *     `node:sqlite`. The CLI itself no longer imports sqlite, but the
 *     stdio MCP child process does, and its warnings surface on the parent's
 *     stderr. Stable in Node 22+ in practice; the warning is correct but
 *     uninformative.
 *   - `DeprecationWarning: ... dotenv ...` — dotenv@16 prints a teaser for
 *     its hosted product on every load on newer Node releases.
 *
 * BrainRouter's own warnings flow through unchanged. `NODE_NO_WARNINGS=1`
 * would silence those too, so we intercept selectively instead.
 *
 * Two interception points: (1) remove Node's built-in `warning` listener
 * and add our own filtered one — this catches warnings emitted from
 * subprocesses or transitive imports during ESM resolution; (2) replace
 * `process.emitWarning` so future direct callers also get the filter.
 * Both are needed because ESM hoists imports above any code in this file,
 * so an emitWarning override alone misses import-time warnings.
 */
function isSuppressibleWarning(message: string, type: string): boolean {
  const looksExperimental =
    type === 'ExperimentalWarning' ||
    /experimental feature|SQLite is an experimental/i.test(message);
  const looksDotenvNoise =
    /dotenv@\d|dotenvx|dotenv\.org/i.test(message);
  return looksExperimental || looksDotenvNoise;
}

// Detach Node's default warning printer and replace with a filtered one.
// process.listeners returns each Function attached; the default one is a
// single internal listener that does the stderr printing.
for (const listener of process.listeners('warning')) {
  process.removeListener('warning', listener);
}
process.on('warning', (warning: any) => {
  if (isSuppressibleWarning(warning?.message ?? '', warning?.name ?? '')) return;
  // Mirror Node's default formatting for everything else so users see the
  // familiar "(node:PID) <Name>: <message>" shape.
  process.stderr.write(`(node:${process.pid}) ${warning?.name ?? 'Warning'}: ${warning?.message ?? warning}\n`);
});

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
  const message = typeof warning === 'string' ? warning : warning?.message ?? '';
  const type = typeof rest[0] === 'string' ? rest[0]
    : (rest[0] && typeof rest[0] === 'object' && 'type' in rest[0]) ? (rest[0] as any).type
    : (warning instanceof Error ? (warning as any).name : '');
  if (isSuppressibleWarning(message, type)) return;
  return (originalEmitWarning as any)(warning, ...rest);
}) as typeof process.emitWarning;

/**
 * Crash diagnostics — surface ANY exit reason so the user (or we) can
 * see WHY the process died if the REPL ever silently quits. The
 * symptom the user reported was "REPL prints banner, then bash prompt"
 * with no error. If that happens again under any future regression,
 * one of these handlers will catch it and print the cause.
 *
 * `cli.debugExit: true` in `~/.config/brainrouter/config.json` (default off)
 * enables verbose exit tracing including the beforeExit event so we can
 * see whether the event loop drained (= stdin refcount issue) vs explicit
 * process.exit (= bug).
 */
process.on('uncaughtException', (err) => {
  process.stderr.write(`\n[brainrouter] Uncaught exception killed the process:\n${err?.stack ?? err}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason: any) => {
  process.stderr.write(`\n[brainrouter] Unhandled promise rejection killed the process:\n${reason?.stack ?? reason}\n`);
  process.exit(1);
});

import fs from 'node:fs';
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { loadConfig, loadOrInitConfig, saveConfig, getConfigPath, getCliKnobs, setCliKnobOverride } from './config/config.js';

if (getCliKnobs().debugExit) {
  process.on('beforeExit', (code) => {
    process.stderr.write(`[brainrouter:debug] beforeExit code=${code} (event loop drained — likely Ink stdin.unref leak)\n`);
  });
  process.on('exit', (code) => {
    process.stderr.write(`[brainrouter:debug] exit code=${code}\n`);
  });
}
import { McpClientWrapper } from './runtime/mcpClient.js';
import { McpClientPool, selectMcpServerIds } from './runtime/mcpPool.js';
import { setKnownMcpServerIds } from './cli/ink/toolFormat.js';
import type { ServerConfig } from './config/config.js';
import { Agent } from './agent/agent.js';
import { runChat } from './cli/ink/runChat.js';
import { applyWorkspaceRoot, findWorkspaceRoot } from './config/workspace.js';
import { runWizard, isOnboarded } from './cli/ink/runWizard.js';

// The CLI deliberately does NOT load any `.env` file. Source of truth for
// runtime config is `~/.config/brainrouter/config.json` (LLM creds, MCP
// server profiles, theme, etc.), set interactively via the wizard / `/login`
// / `/config`. The MCP server is a separate concern and loads its own
// `server.env` from its own working directory — that's the server's
// business, not the CLI's. Shell env (real `process.env`) still flows
// through normally for everything that reads it (e.g. `OPENAI_API_KEY`
// fallback inside `callOpenAI`).

const program = new Command();

program
  .name('brainrouter')
  .description('BrainRouter CLI — Premium interactive terminal-based agent client.')
  .version('0.3.8');

// Chat Command (default)
program
  .command('chat', { isDefault: true })
  .description('Start interactive agent REPL chat session (default)')
  .option('-p, --profile <name>', 'Connection profile name')
  .option('-m, --model <name>', 'LLM model override')
  .option('-w, --workspace <path>', 'Workspace root for files, commands, memory session, and MCP --root')
  .option('--strict-mcp', 'Exit if the MCP server is unreachable (default: continue in offline mode with local tools only)')
  .option('--quiet', 'Suppress recall tables, briefing dumps, and tool-completion previews (model prose only). Toggle in-session with /quiet.')
  .action(async (options) => {
    if (options.workspace) {
      setCliKnobOverride({ workspaceOverride: options.workspace });
    }
    if (options.quiet) {
      // Quiet mode is durable in preferences, but `--quiet` should turn it
      // on for THIS session without permanently flipping the user's saved
      // setting. Set an in-process knob override that the REPL checks.
      setCliKnobOverride({ quiet: true });
    }
    const workspace = findWorkspaceRoot();
    applyWorkspaceRoot(workspace.workspaceRoot);
    // Workspace path + detection reason intentionally NOT printed here — the
    // boxed startup banner shows the workspace row, and `/workspace` exposes
    // the launch CWD + detection reason on demand. Keeping a duplicate
    // stale-chrome line above the banner undermines the banner-first design.

    // 0.3.7 — first-run auto-trigger. When no config exists OR the
    // onboarded marker is missing, drop the user straight into the
    // wizard before constructing the Agent / MCP client. This replaces
    // the pre-0.3.7 "Error: No BrainRouter config found ... run
    // `brainrouter login`" exit-with-error path. The wizard owns its
    // own readline for the wizard's lifetime; when it returns we
    // continue into the REPL with the freshly-saved config.
    if (!fs.existsSync(getConfigPath()) || !isOnboarded()) {
      try {
        const wizardResult = await runWizard({
          workspaceRoot: workspace.workspaceRoot,
        });
        if (wizardResult.state.aborted) {
          console.error(chalk.gray('Wizard aborted before saving — exiting. Run `brainrouter` again any time to retry.'));
          process.exit(0);
        }
      } catch (err: any) {
        console.error(chalk.red(`Wizard failed: ${err?.message ?? err}`));
        process.exit(1);
      }
    }

    const config = loadConfig();

    // 0.3.7 — multi-MCP support. Third-party MCPs are additive and all
    // connect concurrently. BrainRouter MCPs are different: users may store
    // several BrainRouter profiles (local/staging/remote/self-hosted), but
    // only one brain should be active at a time. `activeServer` selects that
    // BrainRouter profile when it points at one; otherwise we use the first
    // configured BrainRouter profile. `--profile <name>` still scopes the run
    // to exactly one server for explicit single-server mode.
    const requestedProfile = options.profile as string | undefined;
    const allServerIds = Object.keys(config.servers);
    if (allServerIds.length === 0) {
      console.error(chalk.red('Error: No MCP server profiles in config.'));
      console.error(chalk.gray('Run `/login` inside the REPL or `brainrouter login` to add a profile.'));
      process.exit(1);
    }
    if (requestedProfile && !config.servers[requestedProfile]) {
      console.error(chalk.red(`Error: Profile "${requestedProfile}" not found in config.`));
      console.error(chalk.gray(`Available profiles: ${allServerIds.join(', ')}.`));
      process.exit(1);
    }
    const targetIds = selectMcpServerIds(config.servers, config.activeServer, requestedProfile);

    // Pre-process each target's serverConfig to thread workspaceRoot
    // into the stdio `--root` arg shape the MCP server expects.
    const targetServers: Record<string, ServerConfig> = {};
    for (const id of targetIds) {
      const cloned = { ...config.servers[id] };
      if (cloned.type === 'stdio') {
        const args = cloned.args ?? [];
        const rootIndex = args.indexOf('--root');
        cloned.args = rootIndex >= 0
          ? [...args.slice(0, rootIndex + 1), workspace.workspaceRoot, ...args.slice(rootIndex + 2)]
          : [...args, '--root', workspace.workspaceRoot];
      }
      targetServers[id] = cloned;
      config.servers[id] = cloned;
    }

    const llm = config.llm || {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: ''
    };

    if (options.model) {
      llm.model = options.model;
    }

    // Connect everyone concurrently — offline servers don't block.
    // "Connecting..." status lines intentionally dropped (see prior
    // comment); the banner's per-server row is the success signal.
    const mcpClient = new McpClientPool();
    const statuses = await mcpClient.connectAll(targetServers, llm, { timeoutMs: 5_000 });
    // Register live server ids for Ink tool-name display so multi-word
    // server names (e.g. `my_server`) don't get mis-stripped by the
    // single-underscore prefix regex.
    setKnownMcpServerIds(mcpClient.getServerIds());
    const failures = statuses.filter((s) => s.status === 'failed');
    if (failures.length === statuses.length) {
      // Every server failed — equivalent to the pre-0.3.7 "MCP
      // unreachable" path; same --strict-mcp semantics apply.
      const summary = failures.map((s) => `${s.serverId}: ${s.error ?? 'unknown error'}`).join('\n  ');
      console.error(chalk.red(`Failed to connect to any MCP server:\n  ${summary}`));
      if (options.strictMcp) {
        console.error(chalk.gray('--strict-mcp set; exiting.'));
        process.exit(1);
      }
      // Falls through to offline-mode REPL — banner shows the warning.
    } else if (failures.length > 0) {
      // Partial failure — surface the failing server names without
      // exiting; user can /mcp reconnect <id> later.
      const failed = failures.map((s) => s.serverId).join(', ');
      console.error(chalk.yellow(`⚠ ${failures.length} of ${statuses.length} MCP servers offline: ${failed}. Other servers connected; use /mcp to inspect.`));
    }

    const agent = new Agent(mcpClient, llm, {
      workspaceRoot: workspace.workspaceRoot,
      launchCwd: workspace.launchCwd,
    });
    // Federation Stage 2 (FED-S2-T2/T3): claim a row in the brain's
    // active_sessions registry + heartbeat every 30s. Resolves to null
    // (no-op) when the brain pre-dates Stage 2 — older brains keep
    // working unchanged. The federation sessionKey is per-workspace
    // and persisted (NOT the same as agent.sessionKey, which is the
    // chat session and rotates per-launch) so clean restarts refresh
    // the registry row instead of stacking ghosts.
    const { attachFederation, resolveFederationSessionKey } = await import(
      './runtime/federationRegistration.js'
    );
    const federationKey = resolveFederationSessionKey(workspace.workspaceRoot);
    agent.setFederationSessionKey(federationKey);
    const federation = await attachFederation({
      mcpClient,
      sessionKey: federationKey,
      workspaceRoot: workspace.workspaceRoot,
      clientKind: 'brainrouter-cli',
      // Federation Stage 3: render incoming text messages as a banner
      // above the next prompt. The poller fires every 5 s; `text`-kind
      // is the only kind we surface in 0.4.0, other kinds stay in the
      // inbox for Stage 4 / multi-agent Phase 2 consumers.
      onInboxText: async (messages) => {
        const { renderIncomingMessages } = await import('./cli/incomingBanner.js');
        renderIncomingMessages(messages);
      },
    });
    // Hard-kill safety net: Ctrl-C, SIGTERM, and `process.exit` paths
    // skip the `finally` below. Best-effort unregister on signal so a
    // mid-tool-call kill doesn't leave a ghost waiting for the brain's
    // 5-min sweeper. Errors are swallowed by `stop()` itself.
    const onSignal = () => { void federation?.stop(); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      await runChat({ agent, mcpClient, config, workspace });
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await federation?.stop();
    }
  });

// One-shot non-interactive run — pipe-friendly for scripting/CI.
//   brainrouter run "summarize the changes in src/"
//   echo "what is this repo?" | brainrouter run -
//   brainrouter run --print "..."        → print answer only
//   brainrouter run --json "..."         → JSON-line with answer + usage
program
  .command('run [prompt...]')
  .description('Run a single agent turn non-interactively and print the answer (use "-" to read prompt from stdin)')
  .option('-p, --profile <name>', 'Connection profile name')
  .option('-m, --model <name>', 'LLM model override')
  .option('-w, --workspace <path>', 'Workspace root')
  .option('--print', 'Print the answer text only, no chrome')
  .option('--json', 'Emit one JSON line { answer, usage, durationMs, sessionKey }')
  .option('--session <key>', 'Resume a specific sessionKey')
  .option('--timeout <ms>', 'LLM request timeout in ms')
  .option('--strict-mcp', 'Exit if the MCP server is unreachable (default: continue in offline mode with local tools only)')
  .action(async (promptParts: string[], options) => {
    if (options.workspace) setCliKnobOverride({ workspaceOverride: options.workspace });
    if (options.timeout) {
      const ms = Number(options.timeout);
      if (Number.isFinite(ms) && ms > 0) setCliKnobOverride({ llmTimeoutMs: ms });
    }

    let prompt = (promptParts ?? []).join(' ').trim();
    if (prompt === '-' || !prompt) {
      // Read from stdin
      prompt = await new Promise<string>((resolve) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { buf += chunk; });
        process.stdin.on('end', () => resolve(buf.trim()));
      });
    }
    if (!prompt) {
      console.error('Error: no prompt provided (pass as args or via stdin).');
      process.exit(2);
    }

    // Reject slash commands in headless mode. The REPL handles them via
    // handleSlashCommand, but `run` skips straight to agent.runTurn — so a
    // user piping `/help` or `/sessions` was silently routed to the LLM and
    // got back a confused chat response instead of a real CLI error.
    // Headless mode now exits with a real error instead of consuming a turn.
    if (prompt.startsWith('/')) {
      const cmdName = prompt.split(/\s+/)[0];
      console.error(
        `Error: slash commands are not supported in 'run' (headless) mode. ` +
        `"${cmdName}" must be invoked from the interactive REPL (run \`brainrouter\` with no args).`,
      );
      console.error(`Hint: if you meant to send "${cmdName}" as a literal prompt, escape it with a leading space.`);
      process.exit(2);
    }

    const workspace = findWorkspaceRoot();
    applyWorkspaceRoot(workspace.workspaceRoot);

    const config = loadConfig();
    // Multi-MCP: like `chat`, connect third-party servers concurrently but
    // only one BrainRouter MCP profile at a time. `--profile <name>` scopes
    // to exactly one.
    const requestedProfile = options.profile as string | undefined;
    const allServerIds = Object.keys(config.servers);
    if (allServerIds.length === 0) {
      console.error('Error: No MCP server profiles in config.');
      process.exit(1);
    }
    if (requestedProfile && !config.servers[requestedProfile]) {
      console.error(`Error: Profile "${requestedProfile}" not found.`);
      process.exit(1);
    }
    const targetIds = selectMcpServerIds(config.servers, config.activeServer, requestedProfile);
    const targetServers: Record<string, ServerConfig> = {};
    for (const id of targetIds) {
      const cloned = { ...config.servers[id] };
      if (cloned.type === 'stdio') {
        const args = cloned.args ?? [];
        const rootIndex = args.indexOf('--root');
        cloned.args = rootIndex >= 0
          ? [...args.slice(0, rootIndex + 1), workspace.workspaceRoot, ...args.slice(rootIndex + 2)]
          : [...args, '--root', workspace.workspaceRoot];
      }
      targetServers[id] = cloned;
    }

    const llm = config.llm ?? { provider: 'openai', model: 'gpt-4o-mini', apiKey: '' };
    if (options.model) llm.model = options.model;

    const mcpClient = new McpClientPool();
    const statuses = await mcpClient.connectAll(targetServers, llm, { timeoutMs: 5_000 });
    // Register live server ids for Ink tool-name display so multi-word
    // server names (e.g. `my_server`) don't get mis-stripped by the
    // single-underscore prefix regex.
    setKnownMcpServerIds(mcpClient.getServerIds());
    const allFailed = statuses.length > 0 && statuses.every((s) => s.status === 'failed');
    if (allFailed) {
      const summary = statuses.map((s) => `${s.serverId}: ${s.error ?? 'unknown'}`).join('; ');
      console.error(`MCP connect failed (all servers): ${summary}`);
      if (options.strictMcp) process.exit(1);
      // Offline mode for one-shot: same rationale as the chat command — local
      // tools still work, MCP-backed calls return error envelopes the agent
      // already tolerates. Useful when piping a quick "read this file and
      // summarize" while the MCP server is down. CI can pass --strict-mcp.
      console.error('Continuing in offline mode (no memory recall / skills). Pass --strict-mcp to exit instead.');
    } else {
      const failed = statuses.filter((s) => s.status === 'failed');
      if (failed.length > 0) {
        process.stderr.write(`[mcp] ${failed.length} of ${statuses.length} servers offline: ${failed.map((f) => f.serverId).join(', ')}\n`);
      }
    }

    const agent = new Agent(mcpClient, llm, {
      workspaceRoot: workspace.workspaceRoot,
      launchCwd: workspace.launchCwd,
      sessionKey: options.session,
    });

    const startedAt = Date.now();
    let answer = '';
    try {
      answer = await agent.runTurn(prompt, {
        onStatusUpdate: () => {},
        onToolStart: (name) => { if (!options.print && !options.json) process.stderr.write(`  · ${name}\n`); },
        onToolEnd: () => {},
      });
    } catch (err: any) {
      console.error(`run failed: ${err.message}`);
      await mcpClient.close();
      process.exit(1);
    }
    const durationMs = Date.now() - startedAt;
    await mcpClient.close();

    if (options.json) {
      process.stdout.write(JSON.stringify({
        answer,
        sessionKey: agent.sessionKey,
        usage: agent.lastTurnUsage,
        durationMs,
      }) + '\n');
    } else {
      process.stdout.write(answer + (answer.endsWith('\n') ? '' : '\n'));
      if (!options.print) {
        const u = agent.lastTurnUsage;
        process.stderr.write(`\n[done · ${Math.round(durationMs / 1000)}s · ${u.promptTokens} in / ${u.completionTokens} out across ${u.calls} call${u.calls === 1 ? '' : 's'}]\n`);
      }
    }
    process.exit(0);
  });

// Login Command
program
  .command('login')
  .description('Configure and authenticate connection to a hosted HTTP/SSE BrainRouter server')
  .action(async () => {
    console.log(chalk.bold.hex('#CC9166')('\n🔑 hosted BrainRouter Authentication Setup'));

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'url',
        message: 'Enter BrainRouter HTTP/SSE MCP Endpoint URL:',
        default: 'http://localhost:3747/mcp',
        validate: (input) => {
          try {
            new URL(input);
            return true;
          } catch {
            return 'Please enter a valid URL (e.g. http://localhost:3747/mcp)';
          }
        }
      },
      {
        type: 'input',
        name: 'apiKey',
        message: 'Enter Authorization / API Key (leave empty if none):',
      },
      {
        type: 'input',
        name: 'profileName',
        message: 'Enter profile name to save this connection as:',
        default: 'hosted-team',
        validate: (input) => input.trim() ? true : 'Profile name cannot be empty.'
      }
    ]);

    const mcpClient = new McpClientWrapper();
    const spinner = inquirer.ui.BottomBar ? null : console.log(chalk.gray('Testing connection...'));
    
    try {
      await mcpClient.connect({
        type: 'http',
        url: answers.url,
        apiKey: answers.apiKey || undefined
      }, undefined, answers.profileName);
      await mcpClient.close();

      // Save to config — `loadOrInitConfig` lets first-run users build a
      // fresh config.json instead of hitting the strict no-config error.
      const config = loadOrInitConfig();
      config.servers[answers.profileName] = {
        type: 'http',
        url: answers.url,
        apiKey: answers.apiKey || undefined
      };
      config.activeServer = answers.profileName;
      saveConfig(config);

      console.log(chalk.green(`\n✔ Successfully connected and saved profile "${answers.profileName}"!`));
      console.log(`Set "${answers.profileName}" as the active connection profile.\n`);
    } catch (err: any) {
      console.error(chalk.red(`\n✖ Connection test failed: ${err.message}`));
      console.log(chalk.yellow('No profile changes were saved. Check the URL and credentials and try again.\n'));
    }
  });

// Config Command
program
  .command('config')
  .description('Interactively configure your LLM provider and MCP servers')
  .action(async () => {
    // `loadOrInitConfig` because this command IS the first-run setup
    // wizard — it must work even when no config.json exists yet.
    const config = loadOrInitConfig();

    const menu = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Select configuration action:',
        choices: [
          'Configure LLM Provider',
          'Configure Server Profile',
          'Set Active Server Profile',
          'View Configuration',
          'Cancel'
        ]
      }
    ]);

    if (menu.action === 'Configure LLM Provider') {
      const llmAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'apiKey',
          message: 'Enter LLM API Key (leave blank to use system env variables or local endpoints):',
          default: config.llm?.apiKey || ''
        },
        {
          type: 'input',
          name: 'model',
          message: 'Enter LLM Model (e.g. gpt-4o-mini, llama3):',
          default: config.llm?.model || 'gpt-4o-mini'
        },
        {
          type: 'input',
          name: 'endpoint',
          message: 'Enter Custom API Endpoint URL (optional, e.g. for Ollama/LM Studio):',
          default: config.llm?.endpoint || ''
        }
      ]);

      config.llm = {
        provider: 'openai',
        apiKey: llmAnswers.apiKey,
        model: llmAnswers.model,
        endpoint: llmAnswers.endpoint || undefined
      };
      saveConfig(config);
      console.log(chalk.green('\n✔ LLM configuration updated successfully!\n'));

    } else if (menu.action === 'Configure Server Profile') {
      const typeAnswer = await inquirer.prompt([
        {
          type: 'list',
          name: 'type',
          message: 'Select connection type:',
          choices: ['stdio', 'http']
        }
      ]);

      let serverOpts: any = { type: typeAnswer.type };

      if (typeAnswer.type === 'stdio') {
        const stdioAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'command',
            message: 'Enter executable command (e.g., node, npx):',
            default: 'node'
          },
          {
            type: 'input',
            name: 'args',
            message: 'Enter space-separated arguments (e.g. dist/index.js --root .):',
          }
        ]);
        serverOpts.command = stdioAnswers.command;
        serverOpts.args = stdioAnswers.args.trim() ? stdioAnswers.args.split(' ') : [];
      } else {
        const httpAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'url',
            message: 'Enter Server URL (e.g., http://localhost:3747/mcp):',
            default: 'http://localhost:3747/mcp'
          },
          {
            type: 'input',
            name: 'apiKey',
            message: 'Enter API authorization key (if any):'
          }
        ]);
        serverOpts.url = httpAnswers.url;
        serverOpts.apiKey = httpAnswers.apiKey || undefined;
      }

      const nameAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'name',
          message: 'Enter profile name for this server:',
          default: 'custom-server'
        }
      ]);

      config.servers[nameAnswer.name] = serverOpts;
      saveConfig(config);
      console.log(chalk.green(`\n✔ Server profile "${nameAnswer.name}" saved successfully!\n`));

    } else if (menu.action === 'Set Active Server Profile') {
      const activeChoices = Object.keys(config.servers);
      if (activeChoices.length === 0) {
        console.log(chalk.red('\nNo server profiles exist. Create one first.\n'));
        return;
      }

      const activeAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'active',
          message: 'Select active server profile:',
          choices: activeChoices,
          default: config.activeServer
        }
      ]);

      config.activeServer = activeAnswers.active;
      saveConfig(config);
      console.log(chalk.green(`\n✔ Active server profile set to "${activeAnswers.active}"!\n`));

    } else if (menu.action === 'View Configuration') {
      console.log(chalk.bold('\n⚙️  Current configuration:'));
      const scrubbed = JSON.parse(JSON.stringify(config));
      if (scrubbed.llm?.apiKey) scrubbed.llm.apiKey = 'br_••••••••';
      for (const s of Object.values(scrubbed.servers)) {
        const srv = s as any;
        if (srv.apiKey) srv.apiKey = 'br_••••••••';
        if (srv.env?.BRAINROUTER_API_KEY) srv.env.BRAINROUTER_API_KEY = 'br_••••••••';
      }
      console.log(chalk.gray(JSON.stringify(scrubbed, null, 2)));
      console.log();
    }
  });

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
    const { reconcileStale, listSessions } = await import('./orchestration/orchestrator.js');
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

program.parse(process.argv);
