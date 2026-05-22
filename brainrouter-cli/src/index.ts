#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { loadConfig, saveConfig } from './config/config.js';
import { McpClientWrapper } from './runtime/mcpClient.js';
import { Agent } from './agent/agent.js';
import { startREPL } from './cli/repl.js';
import { applyWorkspaceRoot, findWorkspaceRoot } from './config/workspace.js';

/**
 * Load `.env` files into the CLI's `process.env`.
 *
 * The CLI and the MCP server have separate concerns and now ship separate
 * config files:
 *
 *   - `brainrouter-cli/.env`  — CLI-only knobs (chat LLM, tool loop,
 *                                sandbox, web search, trace log).
 *   - `brainrouter/.env`      — MCP-only knobs (extraction LLM, embeddings,
 *                                reranker, memory engine, server auth).
 *
 * Loading order:
 *   1) `brainrouter-cli/.env` (PRIMARY for CLI process).
 *   2) `brainrouter/.env`     (FALLBACK — only for the LLM credentials, so
 *                              a user who set up only the MCP config still
 *                              gets a working CLI agent and vice versa).
 *
 * Shell env (anything already in `process.env`) wins over both — explicit
 * env > .env file, as is conventional.
 *
 * The MCP child uses `import "dotenv/config"` which resolves relative to
 * `process.cwd()`. The CLI sets the spawned child's cwd to the MCP package
 * directory (see runtime/mcpClient.ts), so `brainrouter/.env` is loaded by
 * the child directly — the CLI does NOT need to pre-load it for the MCP's
 * sake.
 */
/**
 * Vars the CLI process consumes from a sibling `brainrouter/.env` fallback.
 *
 * LLM credentials are deliberately EXCLUDED — `~/.config/brainrouter/config.json`
 * is the canonical source for chat-LLM creds, endpoint, and model (set via
 * `brainrouter login` or `brainrouter config`). Pulling them from `.env` in
 * parallel created a silent precedence bug: env would shadow `config.json`
 * because `loadBrainrouterEnv()` runs at module-load time before
 * `loadConfig()`, and downstream callers like `mcpClient.connect()` check
 * `mergedEnv.BRAINROUTER_LLM_ENDPOINT` before falling back to `llmConfig`.
 *
 * The only var we still allow through the fallback is `BRAINROUTER_API_KEY`
 * — that's MCP-server auth (not LLM), and stdio mode propagates it from the
 * CLI's process.env into the spawned child. If your `config.json` server
 * profile already carries the API key in its `env` block, you don't need
 * this fallback either, and it can go away in a follow-up cleanup.
 *
 * Anything outside this set is a pure MCP-server knob (embedding endpoint,
 * JWT secret, extraction sweep config, prewarming, graph timeouts, admin
 * creds) that just pollutes the CLI's environment with no effect — the MCP
 * child loads `brainrouter/.env` directly via its own `dotenv/config`.
 */
const CLI_FALLBACK_ALLOWLIST = new Set([
  'BRAINROUTER_API_KEY',
]);

function loadEnvFile(file: string, allowlist?: Set<string>): number {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    let count = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Allowlist gate: when loading the MCP fallback file, only adopt vars
      // the CLI actually reads. Primary CLI .env loads pass no allowlist and
      // accept everything (it's the CLI's own config).
      if (allowlist && !allowlist.has(key)) continue;
      if (key && !(key in process.env)) {
        process.env[key] = value;
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function loadBrainrouterEnv(): { primary?: string; fallback?: string; count: number } {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  let count = 0;
  let primary: string | undefined;
  let fallback: string | undefined;

  // PRIMARY: brainrouter-cli/.env (this package's own config).
  // dist/index.js → ../.. = brainrouter-cli/, so .env sits next to package.json.
  const cliCandidates = [
    path.resolve(here, '..', '..', '.env'),                          // monorepo: brainrouter-cli/.env
    path.resolve(here, '..', '..', '..', 'brainrouter-cli', '.env'), // installed/nested
    path.resolve(process.cwd(), 'brainrouter-cli', '.env'),          // running from repo root
  ];
  for (const file of cliCandidates) {
    if (fs.existsSync(file)) {
      primary = file;
      count += loadEnvFile(file);
      break;
    }
  }

  // FALLBACK: brainrouter/.env (MCP-side config). Only used to backstop the
  // LLM credentials so a partial setup still works. The MCP child loads
  // brainrouter/.env on its own anyway via cwd hint, so we don't need to
  // import its server-only knobs (embedding endpoint, JWT secret, sweep
  // intervals, prewarming) — those just clutter the CLI's process.env. The
  // allowlist limits the fallback to vars the CLI actually reads.
  //
  // Only record the fallback in the result when it actually contributed at
  // least one new var. If the primary file already set all the LLM creds,
  // mentioning the fallback path in the startup banner is noise — the user
  // already has the CLI fully configured locally and doesn't need to know
  // a sibling .env was read but ignored.
  const mcpCandidates = [
    path.resolve(here, '..', '..', '..', 'brainrouter', '.env'),
    path.resolve(process.cwd(), 'brainrouter', '.env'),
  ];
  for (const file of mcpCandidates) {
    if (fs.existsSync(file)) {
      const added = loadEnvFile(file, CLI_FALLBACK_ALLOWLIST);
      if (added > 0) {
        fallback = file;
        count += added;
      }
      break;
    }
  }
  return { primary, fallback, count };
}

const envLoadResult = loadBrainrouterEnv();
if (envLoadResult.primary || envLoadResult.fallback) {
  // Something contributed at least one var — show what loaded so the user can
  // trace where runtime knobs (sandbox, timeouts, trace log, web search) are
  // coming from. LLM creds intentionally do NOT flow through this path; they
  // live in ~/.config/brainrouter/config.json.
  const sources: string[] = [];
  if (envLoadResult.primary) sources.push(envLoadResult.primary);
  if (envLoadResult.fallback) sources.push(`${envLoadResult.fallback} (fallback)`);
  const tag = envLoadResult.count > 0
    ? chalk.gray(` (${envLoadResult.count} new var${envLoadResult.count === 1 ? '' : 's'})`)
    : chalk.gray(' (all keys already set in shell)');
  console.error(chalk.gray(`env: loaded ${sources.join(', ')}`) + tag);
}
// No banner when nothing loaded — that's the normal case for users who
// configured the CLI via `brainrouter login` / `brainrouter config`. The old
// "set BRAINROUTER_LLM_API_KEY in your shell" hint contradicted the
// config.json-is-canonical design and confused users who already had a
// fully populated config.

const program = new Command();

program
  .name('brainrouter')
  .description('BrainRouter CLI — Premium interactive terminal-based agent client.')
  .version('0.3.5');

// Chat Command (default)
program
  .command('chat', { isDefault: true })
  .description('Start interactive agent REPL chat session (default)')
  .option('-p, --profile <name>', 'Connection profile name')
  .option('-m, --model <name>', 'LLM model override')
  .option('-w, --workspace <path>', 'Workspace root for files, commands, memory session, and MCP --root')
  .option('--strict-mcp', 'Exit if the MCP server is unreachable (default: continue in offline mode with local tools only)')
  .action(async (options) => {
    if (options.workspace) {
      process.env.BRAINROUTER_WORKSPACE = options.workspace;
    }
    const workspace = findWorkspaceRoot();
    applyWorkspaceRoot(workspace.workspaceRoot);
    console.log(chalk.gray(`Workspace: ${workspace.workspaceRoot} (${workspace.reason})`));

    const config = loadConfig();
    const profileName = options.profile || config.activeServer;
    const configuredServer = config.servers[profileName];

    if (!configuredServer) {
      console.error(chalk.red(`Error: Profile "${profileName}" not found in config.`));
      process.exit(1);
    }

    const serverConfig = { ...configuredServer };

    if (serverConfig.type === 'stdio') {
      const args = serverConfig.args ?? [];
      const rootIndex = args.indexOf('--root');
      serverConfig.args = rootIndex >= 0
        ? [...args.slice(0, rootIndex + 1), workspace.workspaceRoot, ...args.slice(rootIndex + 2)]
        : [...args, '--root', workspace.workspaceRoot];
    }
    config.servers[profileName] = serverConfig;

    const llm = config.llm || {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: ''
    };

    if (options.model) {
      llm.model = options.model;
    }

    const mcpClient = new McpClientWrapper();
    console.log(chalk.gray(`Connecting to MCP server profile "${profileName}"...`));

    try {
      await mcpClient.connect(serverConfig, llm);
      console.log(chalk.green('Successfully connected to BrainRouter MCP Server!'));
    } catch (err: any) {
      // Degraded "offline mode": the MCP server is the cognitive memory layer
      // (recall, skills, capture, citations) — losing it is painful but not
      // fatal. Local tools (read_file, write_file, list_dir, grep_search,
      // run_command, spawn_agent) still work, and the agent's runTurn already
      // try/catches every MCP call. Keep the REPL up so the user can edit
      // code, drive shell commands, and recover when the server comes back.
      // Pass --strict-mcp to flip back to hard-fail (useful in CI).
      console.error(chalk.red(`Failed to connect to MCP server: ${err.message}`));
      if (options.strictMcp) {
        console.error(chalk.gray('--strict-mcp set; exiting.'));
        process.exit(1);
      }
      console.warn(chalk.yellow(
        '⚠️  Continuing in OFFLINE MODE — memory recall, skills, and capture are disabled.\n' +
        '    Local tools (file edits, shell, web fetch, spawn_agent) remain available.\n' +
        '    Start the MCP server and restart the CLI to restore full functionality.\n',
      ));
    }

    const agent = new Agent(mcpClient, llm, {
      workspaceRoot: workspace.workspaceRoot,
      launchCwd: workspace.launchCwd,
    });
    startREPL(agent, mcpClient, config, workspace);
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
    if (options.workspace) process.env.BRAINROUTER_WORKSPACE = options.workspace;
    if (options.timeout) process.env.BRAINROUTER_LLM_TIMEOUT_MS = String(options.timeout);

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
    const profileName = options.profile || config.activeServer;
    const serverConfig = { ...config.servers[profileName] };
    if (!serverConfig) {
      console.error(`Error: Profile "${profileName}" not found.`);
      process.exit(1);
    }
    if (serverConfig.type === 'stdio') {
      const args = serverConfig.args ?? [];
      const rootIndex = args.indexOf('--root');
      serverConfig.args = rootIndex >= 0
        ? [...args.slice(0, rootIndex + 1), workspace.workspaceRoot, ...args.slice(rootIndex + 2)]
        : [...args, '--root', workspace.workspaceRoot];
    }

    const llm = config.llm ?? { provider: 'openai', model: 'gpt-4o-mini', apiKey: '' };
    if (options.model) llm.model = options.model;

    const mcpClient = new McpClientWrapper();
    try {
      await mcpClient.connect(serverConfig, llm);
    } catch (err: any) {
      console.error(`MCP connect failed: ${err.message}`);
      if (options.strictMcp) process.exit(1);
      // Offline mode for one-shot: same rationale as the chat command — local
      // tools still work, MCP-backed calls return error envelopes the agent
      // already tolerates. Useful when piping a quick "read this file and
      // summarize" while the MCP server is down. CI can pass --strict-mcp.
      console.error('Continuing in offline mode (no memory recall / skills). Pass --strict-mcp to exit instead.');
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
      });
      await mcpClient.close();

      // Save to config
      const config = loadConfig();
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
    const config = loadConfig();

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
    if (options.workspace) process.env.BRAINROUTER_WORKSPACE = options.workspace;
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
