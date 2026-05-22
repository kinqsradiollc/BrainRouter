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
 * Load `mcp/.env` (the canonical config home for BRAINROUTER_LLM_*, embedding,
 * reranker, etc.) into the CLI's own `process.env` if not already set.
 *
 * Why this exists: the MCP child uses `import "dotenv/config"`, which resolves
 * relative to whatever `process.cwd()` the child was spawned with — that's
 * the user's launch directory, NOT `mcp/`. So `mcp/.env` was never read by
 * the CLI-spawned MCP child, and the cognitive extractor silently disabled
 * itself because `BRAINROUTER_LLM_API_KEY` was empty.
 *
 * Loading here is the belt: once these vars are in `process.env`, the
 * propagation step in mcpClient.ts (the suspenders) forwards them to the
 * spawned child verbatim. We do not overwrite values already set in the
 * shell — explicit env > .env file, as is conventional.
 */
function loadBrainrouterEnv(): { loaded: string; count: number } | null {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  // dist/index.js → ../.. → repo root. Try common locations.
  const candidates = [
    path.resolve(here, '..', '..', 'mcp', '.env'),       // monorepo layout
    path.resolve(here, '..', '..', '..', 'mcp', '.env'), // installed/nested
    path.resolve(process.cwd(), 'mcp', '.env'),          // running from repo root
    path.resolve(process.cwd(), '.env'),                 // local override
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
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
        // Strip surrounding quotes if present.
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (key && !(key in process.env)) {
          process.env[key] = value;
          count++;
        }
      }
      return { loaded: file, count };
    } catch {
      // Skip silently; the loud diagnostic in mcpClient will warn if nothing reached the child.
    }
  }
  return null;
}

const envLoadResult = loadBrainrouterEnv();
if (envLoadResult) {
  // Visible-but-quiet startup line so users know which .env was picked up.
  const tag = envLoadResult.count > 0 ? chalk.gray(` (${envLoadResult.count} new var${envLoadResult.count === 1 ? '' : 's'})`) : chalk.gray(' (all keys already set in shell)');
  console.error(chalk.gray(`env: loaded ${envLoadResult.loaded}`) + tag);
}

const program = new Command();

program
  .name('brainrouter')
  .description('BrainRouter CLI — Premium interactive terminal-based agent client.')
  .version('0.3.3');

// Chat Command (default)
program
  .command('chat', { isDefault: true })
  .description('Start interactive agent REPL chat session (default)')
  .option('-p, --profile <name>', 'Connection profile name')
  .option('-m, --model <name>', 'LLM model override')
  .option('-w, --workspace <path>', 'Workspace root for files, commands, memory session, and MCP --root')
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
      console.error(chalk.red(`Failed to connect to MCP server: ${err.message}`));
      process.exit(1);
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
      process.exit(1);
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
