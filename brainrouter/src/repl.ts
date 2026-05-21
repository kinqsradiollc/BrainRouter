import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { Agent } from './agent.js';
import type { McpClientWrapper } from './mcpClient.js';
import type { Config } from './config.js';
import { getConfigPath } from './config.js';
import { LOCAL_TOOLS } from './agent.js';
import { listTranscripts, loadTranscript, readTranscriptEntries } from './sessionStore.js';
import { initAgentMd } from './initAgentMd.js';
import { expandMentions } from './mentions.js';
import { clearGoal, readGoal, setGoal } from './goalStore.js';
import { addHook, readHooks, removeHook, setHookEnabled, type HookEvent } from './hooksStore.js';
import { copyToClipboard } from './clipboard.js';
import { getLoopState, isLoopRunning, parseInterval, startLoop, stopLoop } from './loopRunner.js';
import { randomUUID } from 'node:crypto';
import { formatPlan, readPlan, updatePlan } from './taskStore.js';
import type { WorkspaceInfo } from './workspace.js';
import { listRoles } from './agentRoles.js';
import { formatSessionSummary, getSession, listSessions, reconcileStale } from './orchestrator.js';
import { buildSkillPrompt, resolveSkill, SLASH_TO_SKILL } from './skillRunner.js';
import { callMcpTool, childSessionKey } from './mcpUtils.js';
import { ARTIFACT, artifactRelativePath, createWorkflow, getCurrentWorkflow, listWorkflows, readArtifact, slugify, updateWorkflowStatus } from './workflowArtifacts.js';

const execPromise = promisify(exec);

// Setup marked terminal rendering
marked.use(markedTerminal({
  showSectionPrefix: false,
}));

/**
 * All slash commands the REPL recognizes. Used for tab autocomplete and for
 * the readline completer. Keep alphabetically grouped roughly by surface area.
 */
const SLASH_COMMANDS = [
  '/help', '/status', '/workspace', '/tools', '/skills', '/plan', '/transcript',
  '/doctor', '/config', '/diff', '/commit', '/clear', '/compact', '/exit',
  '/roles', '/agents', '/agent', '/spawn', '/wait',
  '/spec', '/feature-dev', '/review', '/implement-plan', '/skill', '/workflows', '/approve',
  '/memory', '/recall', '/briefing', '/scenes', '/working', '/forget',
  '/init', '/sessions', '/resume', '/model', '/mcp',
  '/goal', '/copy', '/fork', '/rename', '/permissions', '/hooks', '/loop',
] as const;

export function startREPL(agent: Agent, mcpClient: McpClientWrapper, config: Config, workspace?: WorkspaceInfo) {
  console.log(chalk.bold.hex('#CC9166')('\n🧠 BRAINROUTER TERMINAL AGENT CLIENT v0.2.0'));
  console.log(chalk.gray('Midnight Ledger / Obsidian Surface theme active.'));
  console.log(chalk.gray(`Workspace root: ${workspace?.workspaceRoot || process.cwd()}`));
  console.log(chalk.gray('Type ') + chalk.cyan('/help') + chalk.gray(' for commands, or start typing your prompt.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.hex('#CC9166')('brainrouter> '),
    // Tab-completion: complete slash commands when the line begins with "/"
    // and complete workspace file paths when the user is mid-`@mention`.
    completer: (line: string): [string[], string] => {
      const atMatch = line.match(/@([^\s]*)$/);
      if (atMatch) {
        const partial = atMatch[1];
        const candidates = completeWorkspacePath(agent.workspaceRoot, partial);
        return [candidates.map((c) => `@${c}`), `@${partial}`];
      }
      if (line.startsWith('/')) {
        const hits = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(line));
        return [hits.length ? hits : SLASH_COMMANDS.slice(), line];
      }
      return [[], line];
    },
  });

  // Reflect the current access mode in the prompt so the user always knows
  // which "plan mode" they're in. Cycled via Shift+Tab below.
  const refreshPromptForMode = () => {
    const mode = agent.getAccessMode();
    const accent = mode === 'shell' ? chalk.red : mode === 'write' ? chalk.hex('#CC9166') : chalk.green;
    rl.setPrompt(accent(`brainrouter[${mode}]> `));
  };
  refreshPromptForMode();

  // Shift+Tab cycles the access mode (codex calls this "Plan mode").
  // Order: read → write → shell → read …
  if (process.stdin.isTTY) {
    try { (process.stdin as any).setRawMode?.(false); } catch { /* noop */ }
  }
  process.stdin.on('keypress', (_str, key) => {
    if (key && key.name === 'tab' && key.shift) {
      const cycle: Array<'read' | 'write' | 'shell'> = ['read', 'write', 'shell'];
      const current = agent.getAccessMode() as 'read' | 'write' | 'shell';
      const next = cycle[(cycle.indexOf(current) + 1) % cycle.length];
      agent.setAccessMode(next);
      refreshPromptForMode();
      process.stdout.write(`\n${chalk.gray(`Access mode → ${next}`)}\n`);
      rl.prompt();
    }
  });

  rl.prompt();

  let isProcessing = false;

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      const parts = input.split(' ');
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      await handleSlashCommand(command, args, agent, mcpClient, config, rl, {
        refreshPromptForMode,
        isProcessing: () => isProcessing,
      });
      rl.prompt();
      return;
    }

    if (isProcessing) {
      console.log(chalk.yellow('\nA previous turn is still running. Wait for the prompt before sending another message.\n'));
      rl.prompt();
      return;
    }

    isProcessing = true;
    rl.pause();

    // Expand @path/to/file mentions into a fenced context block.
    const { expanded, mentions } = expandMentions(input, agent.workspaceRoot);
    if (mentions.length > 0) {
      console.log(chalk.gray(`📎  Attached ${mentions.length} file${mentions.length === 1 ? '' : 's'}: ${mentions.map((m) => m.token).join(', ')}`));
    }

    // Run agent turn
    const startedAt = Date.now();
    const spinner = ora(chalk.gray('Agent starting...')).start();
    const tickStatus = (status: string) => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const u = agent.lastTurnUsage;
      const tokens = u.calls > 0 ? `  ${u.promptTokens.toLocaleString()}↑ ${u.completionTokens.toLocaleString()}↓` : '';
      spinner.text = chalk.gray(`${status}  ${elapsed}s${tokens}`);
    };
    try {
      const answer = await agent.runTurn(expanded, {
        onStatusUpdate: (status) => tickStatus(status),
        onToolStart: (name, args) => {
          spinner.stop();
          console.log(chalk.gray('🛞  Calling tool: ') + chalk.cyan(name) + chalk.gray(`(${JSON.stringify(args)})`));
        },
        onToolEnd: (name, result) => {
          if (result.success) {
            console.log(chalk.green('✓  Tool ') + chalk.cyan(name) + chalk.green(' completed: ') + chalk.gray(result.summary));
          } else {
            console.log(chalk.red('❌  Tool ') + chalk.cyan(name) + chalk.red(' failed: ') + chalk.yellow(result.summary));
          }
          tickStatus('Thinking');
          spinner.start();
        },
        // Plan ticker: render a compact ✓/⏳/☐ block when update_plan fires.
        onPlanUpdate: (items, explanation) => {
          spinner.stop();
          console.log(chalk.gray('📋  Plan updated:'));
          if (explanation) console.log(chalk.gray(`    ${explanation}`));
          for (const item of items) {
            const mark = item.status === 'completed' ? chalk.green('✓')
              : item.status === 'in_progress' ? chalk.yellow('⏳')
              : chalk.gray('☐');
            const text = item.status === 'completed' ? chalk.gray(item.step) : item.step;
            console.log(`    ${mark} ${text}`);
          }
          tickStatus('Thinking');
          spinner.start();
        },
      });
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const u = agent.lastTurnUsage;
      const tokenSummary = u.calls > 0
        ? chalk.gray(` · ${u.promptTokens.toLocaleString()} in / ${u.completionTokens.toLocaleString()} out across ${u.calls} call${u.calls === 1 ? '' : 's'}`)
        : '';
      spinner.succeed(chalk.green(`Done!${chalk.gray(` ${elapsed}s`)}${tokenSummary}`));

      console.log('\n' + marked.parse(answer) + '\n');
      const warning = agent.takeContradictionWarning();
      if (warning) {
        console.log(chalk.yellow(`⚠️  Memory: ${warning}`));
        console.log(chalk.gray(`    Use /memory or /briefing to investigate, /forget <id> to archive obsolete records.\n`));
      }
    } catch (err: any) {
      spinner.fail(chalk.red('Execution failed'));
      console.error(chalk.red(`\nError: ${err.message}\n`));
    } finally {
      isProcessing = false;
      rl.resume();
    }

    rl.prompt();
  });

  rl.on('SIGINT', async () => {
    console.log(chalk.yellow('\nExiting session...'));
    rl.close();
  });

  rl.on('close', async () => {
    await mcpClient.close();
    console.log(chalk.bold.hex('#CC9166')('Goodbye!\n'));
    process.exit(0);
  });
}

interface ReplContext {
  /** Refresh the readline prompt (color reflects access mode). */
  refreshPromptForMode: () => void;
  /** True while the REPL is mid-turn; loop ticks should defer when set. */
  isProcessing: () => boolean;
}

async function handleSlashCommand(
  command: string,
  args: string[],
  agent: Agent,
  mcpClient: McpClientWrapper,
  config: Config,
  rl: readline.Interface,
  ctx: ReplContext,
) {
  switch (command) {
    case '/help':
      console.log(chalk.bold('\nAvailable Slash Commands:'));
      console.log(`  ${chalk.cyan('/help')}     - Show this help menu`);
      console.log(`  ${chalk.cyan('/status')}   - Show connection status, LLM configuration, and database stats`);
      console.log(`  ${chalk.cyan('/workspace')} - Show active workspace and session identity`);
      console.log(`  ${chalk.cyan('/skills')}   - List loaded BrainRouter skills`);
      console.log(`  ${chalk.cyan('/tools')}    - List local workspace tools and MCP tools exposed to the agent`);
      console.log(`  ${chalk.cyan('/plan')}     - Show the durable CLI task plan`);
      console.log(`  ${chalk.cyan('/roles')}    - List available agent roles for orchestration`);
      console.log(`  ${chalk.cyan('/agents')}   - List child agent sessions`);
      console.log(`  ${chalk.cyan('/agent <id>')} - Show detail and recent transcript of a child agent`);
      console.log(`  ${chalk.cyan('/spawn <role> <prompt>')} - Spawn a child agent`);
      console.log(`  ${chalk.cyan('/wait <id> [ms]')} - Wait for a child agent to finish`);
      console.log(`  ${chalk.cyan('/spec <title>')}      - Produce a spec.md under .brainrouter/cli/workflows/<slug>/ (skill: spec-driven-skill)`);
      console.log(`  ${chalk.cyan('/feature-dev <feat>')} - Multi-agent feature dev: writes spec.md + tasks.md, stops for approval`);
      console.log(`  ${chalk.cyan('/review [scope]')}    - Multi-agent code review; writes review.md to a workflow folder`);
      console.log(`  ${chalk.cyan('/implement-plan')}    - Execute next plan item; appends to walkthrough.md`);
      console.log(`  ${chalk.cyan('/workflows')}         - List durable workflow folders with artifact status`);
      console.log(`  ${chalk.cyan('/approve [slug]')}    - Approve a workflow (default: current) and kick off implementation`);
      console.log(`  ${chalk.cyan('/skill <name> [input]')} - Run any catalogued skill from the skills/ folder via the agent`);
      console.log(`  ${chalk.cyan('/memory <query>')}   - Search BrainRouter long-term memory (memory_search)`);
      console.log(`  ${chalk.cyan('/recall <query>')}   - Explicit cognitive recall (memory_recall) — does not start an LLM turn`);
      console.log(`  ${chalk.cyan('/briefing')}         - Show what was recalled before the most recent turn`);
      console.log(`  ${chalk.cyan('/scenes')}           - List active focus scenes (via memory_recall summary)`);
      console.log(`  ${chalk.cyan('/working')}          - Show the current working-memory canvas`);
      console.log(`  ${chalk.cyan('/forget <recordId>')} - Archive a memory record by ID (memory_update status=archived)`);
      console.log(`  ${chalk.cyan('/transcript [main|sessionKey]')} - Show recent persisted transcript entries`);
      console.log(`  ${chalk.cyan('/doctor')}   - Run config, connection, and tool-surface checks`);
      console.log(`  ${chalk.cyan('/config')}   - View active configuration profile and settings`);
      console.log(`  ${chalk.cyan('/diff')}     - Show unstaged git changes beautifully in the terminal`);
      console.log(`  ${chalk.cyan('/commit')}   - Generate message, stage files, and make git commit using agent`);
      console.log(`  ${chalk.cyan('/clear')}    - Clear chat history for the active session`);
      console.log(`  ${chalk.cyan('/compact')}  - Compact the active session by clearing chat history`);
      console.log(`  ${chalk.cyan('/init')}       - Create AGENT.md in the workspace if not present`);
      console.log(`  ${chalk.cyan('/sessions')}   - List persisted sessions (transcripts) for this workspace`);
      console.log(`  ${chalk.cyan('/resume <id>')} - Resume a previous session by sessionKey`);
      console.log(`  ${chalk.cyan('/model <name>')} - Switch the LLM model in-session`);
      console.log(`  ${chalk.cyan('/mcp')}        - Show the active MCP server and its tool namespaces`);
      console.log(`  ${chalk.cyan('/goal [text|clear]')}  - Set/clear a sticky goal injected into every turn`);
      console.log(`  ${chalk.cyan('/copy')}              - Copy last assistant response to clipboard`);
      console.log(`  ${chalk.cyan('/fork [label]')}      - Fork the current chat into a new session, keep prior context`);
      console.log(`  ${chalk.cyan('/rename <label>')}    - Rename the current session id`);
      console.log(`  ${chalk.cyan('/permissions [read|write|shell]')} - View or set the agent's access mode`);
      console.log(`  ${chalk.cyan('/hooks [list|add|remove|enable|disable]')} - Lifecycle shell hooks`);
      console.log(`  ${chalk.cyan('/loop <interval> <prompt> | /loop stop')} - Repeat a prompt on a cadence`);
      console.log(chalk.gray('\nTips: type @ then a path for file mentions; Tab autocompletes commands and @paths.'));
      console.log(chalk.gray('      Shift+Tab cycles access mode (read → write → shell).'));
      console.log(`  ${chalk.cyan('/exit')}     - Close the MCP connection and exit the CLI\n`);
      break;

    case '/status': {
      console.log(chalk.bold('\n🖥️  BrainRouter Status:'));
      const activeServerName = config.activeServer;
      const server = config.servers[activeServerName];
      console.log(`  Active Server: ${chalk.green(activeServerName)} (Type: ${chalk.cyan(server.type)})`);
      if (server.type === 'http') {
        console.log(`  Endpoint URL:  ${chalk.blue(server.url)}`);
      } else {
        console.log(`  Command:       ${chalk.blue(server.command)} ${server.args?.join(' ') || ''}`);
      }

      const llm = config.llm;
      if (llm) {
        console.log(`  LLM Provider:  ${chalk.green(llm.provider)}`);
        console.log(`  LLM Model:     ${chalk.cyan(llm.model)}`);
        if (llm.endpoint) {
          console.log(`  LLM Endpoint:  ${chalk.blue(llm.endpoint)}`);
        }
      }

      const spinner = ora(chalk.gray('Querying diagnostics & testing latency...')).start();
      try {
        const start = Date.now();
        const testRes = await mcpClient.callTool('list_skills', { scope: 'local' });
        const latency = Date.now() - start;
        spinner.succeed(chalk.green(`Latency check: ${latency}ms`));

        // Diagnostics / memory stats
        const diag = await callMcpTool<any>(mcpClient, 'memory_diagnostics', {});
        if (!diag.isError && diag.parsed) {
          const stats = diag.parsed.databaseStats?.userStats;
          if (stats) {
            console.log(chalk.bold('\n📊 Cognitive Memory Database Stats:'));
            console.log(`  Total Memories:       ${chalk.yellow(stats.totalCount ?? 0)}`);
            console.log(`    - Instructions:     ${chalk.gray(stats.typeCounts?.instruction ?? 0)}`);
            console.log(`    - Codebase Facts:   ${chalk.gray(stats.typeCounts?.codebase_fact ?? 0)}`);
            console.log(`    - Architectures:    ${chalk.gray(stats.typeCounts?.architecture_decision ?? 0)}`);
            console.log(`  Total Focus Scenes:   ${chalk.yellow(stats.totalScenes ?? 0)}`);
            console.log(`  Working Memory Items: ${chalk.yellow(stats.workingMemoryCount ?? 0)}`);
          }
        }
      } catch (err: any) {
        spinner.fail(chalk.red('Failed to fetch diagnostics.'));
        console.warn(chalk.yellow(`  Warning: ${err.message}`));
      }
      console.log();
      break;
    }

    case '/workspace': {
      console.log(chalk.bold('\nWorkspace:'));
      console.log(`  Root:       ${chalk.blue(agent.workspaceRoot)}`);
      console.log(`  Launch CWD: ${chalk.gray(agent.launchCwd)}`);
      console.log(`  Session:    ${chalk.green(agent.sessionKey)}`);
      console.log();
      break;
    }

    case '/skills': {
      const spinner = ora(chalk.gray('Fetching skills...')).start();
      try {
        const res = await callMcpTool<any[]>(mcpClient, 'list_skills', { scope: 'all' });
        spinner.stop();
        if (!res.isError && Array.isArray(res.parsed)) {
          const skillsList = res.parsed;
          console.log(chalk.bold('\n🧠 BrainRouter Skills:'));
          if (skillsList.length > 0) {
            for (const skill of skillsList) {
              console.log(`  • ${chalk.cyan(skill.name)} (${chalk.gray(skill.scope)}) - ${skill.description}`);
            }
          } else {
            console.log(chalk.yellow('  No skills found.'));
          }
        } else {
          console.log(chalk.red('\nFailed to parse skills list response.'));
        }
      } catch (err: any) {
        spinner.fail(chalk.red('Failed to list skills.'));
        console.error(chalk.red(`  Error: ${err.message}`));
      }
      console.log();
      break;
    }

    case '/config': {
      console.log(chalk.bold('\n⚙️  Active Configuration:'));
      console.log(`  File Path: ${chalk.blue(getConfigPath())}\n`);
      
      // Print config without API keys
      const scrubbedConfig = JSON.parse(JSON.stringify(config));
      if (scrubbedConfig.llm?.apiKey) {
        scrubbedConfig.llm.apiKey = 'br_••••••••••••••••';
      }
      for (const s of Object.values(scrubbedConfig.servers)) {
        const srv = s as any;
        if (srv.apiKey) srv.apiKey = 'br_••••••••••••••••';
        if (srv.env?.BRAINROUTER_API_KEY) {
          srv.env.BRAINROUTER_API_KEY = 'br_••••••••••••••••';
        }
      }
      console.log(chalk.gray(JSON.stringify(scrubbedConfig, null, 2)));
      console.log();
      break;
    }

    case '/tools': {
      console.log(chalk.bold('\nLocal Workspace Tools:'));
      for (const tool of LOCAL_TOOLS) {
        console.log(`  ${chalk.cyan(tool.name)} - ${tool.description}`);
      }

      const spinner = ora(chalk.gray('Fetching MCP tools...')).start();
      try {
        const res = await mcpClient.listTools();
        spinner.stop();
        const tools = res.tools || [];
        console.log(chalk.bold('\nMCP Tools:'));
        if (tools.length === 0) {
          console.log(chalk.yellow('  No MCP tools exposed by the active server.'));
        } else {
          for (const tool of tools) {
            console.log(`  ${chalk.cyan(tool.name)} - ${tool.description || 'No description'}`);
          }
        }
      } catch (err: any) {
        spinner.fail(chalk.red('Failed to list MCP tools.'));
        console.warn(chalk.yellow(`  Warning: ${err.message}`));
      }
      console.log();
      break;
    }

    case '/plan': {
      const state = readPlan(agent.workspaceRoot);
      console.log(chalk.bold('\nPlan:'));
      console.log(chalk.gray(formatPlan(state)));
      if (state.updatedAt) {
        console.log(chalk.gray(`Updated: ${state.updatedAt}`));
      }
      console.log();
      break;
    }

    case '/transcript': {
      const requestedSession = args.join(' ').trim();
      const sessionKey = !requestedSession || requestedSession === 'main'
        ? agent.sessionKey
        : requestedSession;
      const entries = readTranscriptEntries(agent.workspaceRoot, sessionKey, 20);
      console.log(chalk.bold(`\nTranscript: ${sessionKey}`));
      if (entries.length === 0) {
        console.log(chalk.yellow('  No transcript entries found.'));
      } else {
        for (const entry of entries) {
          const label = entry.name ? `${entry.role}:${entry.name}` : entry.role;
          const text = formatTranscriptContent(entry.content ?? entry.tool_calls ?? '');
          console.log(`${chalk.gray(entry.timestamp)} ${chalk.cyan(label)} ${chalk.gray(text)}`);
        }
      }
      console.log();
      break;
    }

    case '/doctor': {
      console.log(chalk.bold('\nBrainRouter Doctor:'));
      console.log(`  Config file: ${chalk.blue(getConfigPath())}`);
      console.log(`  Active profile: ${chalk.green(config.activeServer)}`);

      const server = config.servers[config.activeServer];
      if (!server) {
        console.log(chalk.red('  Server profile: missing'));
        break;
      }

      console.log(`  Server profile: ${chalk.green(server.type)}`);
      if (server.type === 'stdio') {
        console.log(`  Launch command: ${chalk.blue(server.command)} ${server.args?.join(' ') || ''}`);
      } else {
        console.log(`  Endpoint: ${chalk.blue(server.url)}`);
      }

      const spinner = ora(chalk.gray('Checking MCP tool surface...')).start();
      try {
        const startedAt = Date.now();
        const res = await mcpClient.listTools();
        const latency = Date.now() - startedAt;
        spinner.succeed(chalk.green(`MCP connection healthy (${latency}ms)`));
        console.log(`  MCP tools: ${chalk.yellow(res.tools?.length ?? 0)}`);
        const toolNames = new Set((res.tools || []).map((tool: any) => tool.name));
        const memoryTools = ['memory_recall', 'memory_capture_turn', 'memory_working_offload'];
        for (const name of memoryTools) {
          const hasTool = toolNames.has(name);
          console.log(`  ${name}: ${hasTool ? chalk.green('available') : chalk.yellow('not exposed')}`);
        }
      } catch (err: any) {
        spinner.fail(chalk.red('MCP connection check failed.'));
        console.warn(chalk.yellow(`  Warning: ${err.message}`));
      }

      const plan = readPlan(agent.workspaceRoot);
      console.log(`  Plan items: ${chalk.yellow(plan.items.length)} (updated: ${chalk.gray(plan.updatedAt || 'never')})`);
      const reconciled = reconcileStale(agent.workspaceRoot);
      if (reconciled > 0) console.log(`  Reconciled ${chalk.yellow(reconciled)} stale child session(s).`);
      const childSessions = listSessions(agent.workspaceRoot);
      console.log(`  Child sessions: ${chalk.yellow(childSessions.length)} total`);
      const orchestrationTools = ['spawn_agent', 'list_agents', 'wait_agent', 'read_agent_transcript', 'close_agent', 'update_plan'];
      for (const tn of orchestrationTools) {
        const has = LOCAL_TOOLS.some((lt: any) => lt.name === tn);
        console.log(`  ${tn}: ${has ? chalk.green('available') : chalk.red('missing')}`);
      }
      console.log();
      break;
    }

    case '/diff': {
      const spinner = ora(chalk.gray('Generating diff...')).start();
      try {
        const { stdout: diffOut } = await execPromise('git diff');
        spinner.stop();
        if (!diffOut.trim()) {
          console.log(chalk.green('\nNo unstaged changes.\n'));
        } else {
          console.log(chalk.bold('\n--- Git Diff (Unstaged) ---'));
          const lines = diffOut.split('\n');
          for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
              console.log(chalk.green(line));
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              console.log(chalk.red(line));
            } else if (line.startsWith('@@')) {
              console.log(chalk.cyan(line));
            } else {
              console.log(line);
            }
          }
          console.log();
        }
      } catch (err: any) {
        spinner.fail(chalk.red(`Failed to run git diff: ${err.message}`));
      }
      break;
    }

    case '/commit': {
      const spinner = ora(chalk.gray('Checking git status...')).start();
      try {
        const { stdout: statusOut } = await execPromise('git status --short');
        if (!statusOut.trim()) {
          spinner.succeed(chalk.green('Working directory clean. Nothing to commit.'));
          break;
        }
        spinner.text = chalk.gray('Generating commit message and staging changes...');
        const { stdout: diffOut } = await execPromise('git diff HEAD');
        
        spinner.stop();
        console.log(chalk.bold('\nGit changes detected:'));
        console.log(chalk.gray(statusOut));

        const prompt = `Based on the following git status and git diff, please create a commit. You should stage the modified/untracked files (using git add) and run git commit with an appropriate conventional commit message. Here is the git status:\n${statusOut}\nHere is the diff:\n${diffOut}`;
        
        const agentSpinner = ora(chalk.gray('Executing agent commit workflow...')).start();
        const answer = await agent.runTurn(prompt, {
          onStatusUpdate: (status) => {
            agentSpinner.text = chalk.gray(status);
          },
          onToolStart: (name, args) => {
            agentSpinner.stop();
            console.log(chalk.gray('🛞  Calling tool: ') + chalk.cyan(name) + chalk.gray(`(${JSON.stringify(args)})`));
          },
          onToolEnd: (name, result) => {
            if (result.success) {
              console.log(chalk.green('✓  Tool ') + chalk.cyan(name) + chalk.green(' completed: ') + chalk.gray(result.summary));
            } else {
              console.log(chalk.red('❌  Tool ') + chalk.cyan(name) + chalk.red(' failed: ') + chalk.yellow(result.summary));
            }
            agentSpinner.start(chalk.gray('Thinking...'));
          }
        });
        agentSpinner.succeed(chalk.green('Commit workflow finished!'));
        console.log('\n' + marked.parse(answer) + '\n');
      } catch (err: any) {
        spinner.fail(chalk.red(`Failed to complete commit command: ${err.message}`));
      }
      break;
    }

    case '/roles': {
      console.log(chalk.bold('\nAvailable Agent Roles:'));
      for (const r of listRoles()) {
        console.log(`  ${chalk.cyan(r.name)} (${chalk.gray(r.defaultAccess)}) - ${r.description}`);
      }
      console.log();
      break;
    }

    case '/agents': {
      reconcileStale(agent.workspaceRoot);
      const sessions = listSessions(agent.workspaceRoot);
      console.log(chalk.bold('\nChild Agent Sessions:'));
      if (sessions.length === 0) {
        console.log(chalk.yellow('  No child agents yet. Use /spawn <role> <prompt> to start one.'));
      } else {
        for (const s of sessions) {
          const colorFn =
            s.status === 'completed' ? chalk.green :
            s.status === 'failed' ? chalk.red :
            s.status === 'stale' ? chalk.yellow :
            s.status === 'closed' ? chalk.gray : chalk.cyan;
          console.log(`  ${colorFn(formatSessionSummary(s))}`);
        }
      }
      console.log();
      break;
    }

    case '/agent': {
      const id = args[0];
      if (!id) { console.log(chalk.red('\nUsage: /agent <id>\n')); break; }
      const s = getSession(agent.workspaceRoot, id);
      if (!s) { console.log(chalk.red(`\nNo session ${id}\n`)); break; }
      console.log(chalk.bold(`\nAgent ${s.id}`));
      console.log(`  Role:    ${chalk.cyan(s.role)} (${s.access})`);
      console.log(`  Status:  ${chalk.yellow(s.status)}`);
      console.log(`  Started: ${chalk.gray(s.startedAt)}`);
      if (s.completedAt) console.log(`  Ended:   ${chalk.gray(s.completedAt)}`);
      if (s.label) console.log(`  Label:   ${s.label}`);
      console.log(`  Prompt:  ${chalk.gray(s.prompt.slice(0, 240))}`);
      if (s.finalOutput) console.log(`\n${chalk.bold('Final output:')}\n${s.finalOutput}`);
      if (s.error) console.log(`\n${chalk.red('Error:')} ${s.error}`);
      const recent = readTranscriptEntries(agent.workspaceRoot, childSessionKey(s.parentSessionKey, s.id), 10);
      if (recent.length > 0) {
        console.log(chalk.bold('\nRecent transcript:'));
        for (const e of recent) {
          const text = formatTranscriptContent(e.content ?? e.tool_calls ?? '');
          console.log(`  ${chalk.gray(e.timestamp)} ${chalk.cyan(e.role)} ${chalk.gray(text)}`);
        }
      }
      console.log();
      break;
    }

    case '/spawn': {
      const role = args[0];
      const prompt = args.slice(1).join(' ').trim();
      if (!role || !prompt) {
        console.log(chalk.red('\nUsage: /spawn <role> <prompt>\n'));
        break;
      }
      await runOrchestrationPrompt(agent, `Use the spawn_agent tool to start a ${role} child agent with this prompt:\n\n${prompt}\n\nReturn the child agent id when done.`);
      break;
    }

    case '/wait': {
      const id = args[0];
      const ms = args[1] ? Number(args[1]) : 120000;
      if (!id) { console.log(chalk.red('\nUsage: /wait <id> [timeoutMs]\n')); break; }
      await runOrchestrationPrompt(agent, `Use the wait_agent tool with id="${id}" and timeoutMs=${ms}. Then summarize the child output for me.`);
      break;
    }

    case '/feature-dev': {
      const feature = args.join(' ').trim();
      if (!feature) { console.log(chalk.red('\nUsage: /feature-dev <feature description>\n')); break; }
      const meta = createWorkflow(agent.workspaceRoot, { title: feature, kind: 'feature-dev' });
      const specPath = artifactRelativePath(agent.workspaceRoot, meta.slug, ARTIFACT.spec);
      const tasksPath = artifactRelativePath(agent.workspaceRoot, meta.slug, ARTIFACT.tasks);
      console.log(chalk.gray(`Workflow folder: ${path.dirname(specPath)}`));
      try {
        updatePlan(agent.workspaceRoot, {
          explanation: `Feature: ${feature}`,
          plan: [
            { step: 'Discovery: clarify scope and constraints', status: 'in_progress' },
            { step: 'Exploration: map relevant code with explorer agents', status: 'pending' },
            { step: 'Architecture: choose design via architect agent', status: 'pending' },
            { step: `Write spec.md to ${specPath}`, status: 'pending' },
            { step: `Write tasks.md to ${tasksPath}`, status: 'pending' },
            { step: 'Implementation: worker agent edits code', status: 'pending' },
            { step: 'Review: reviewer agent inspects diff', status: 'pending' },
            { step: 'Verify: verifier agent runs tests', status: 'pending' },
          ],
        });
      } catch (err: any) {
        console.log(chalk.yellow(`Plan setup warning: ${err.message}`));
      }
      await runSkillCommand(agent, mcpClient, command, feature, [
        '## Required memory-first opening',
        'Run `memory_search` with the feature name AND `memory_graph_query` to surface prior knowledge in this workspace. Pass any recovered record IDs to children via `spawn_agent`\'s `seedRecordIds`.',
        '',
        '## Workflow (mandatory, no shortcuts)',
        `Workflow slug: \`${meta.slug}\`. Folder: \`${path.dirname(specPath)}\`.`,
        '',
        'Phase 1 — Exploration: call `spawn_agent` AT LEAST TWICE in parallel with role=explorer. Different children must cover different parts of the codebase relevant to this feature. Do not narrate exploration yourself; use the tool.',
        '',
        'Phase 2 — Architecture: after explorers complete (use `wait_agent`), call `spawn_agent` with role=architect to produce ≥2 design alternatives and a recommended slice.',
        '',
        `Phase 3 — Persist artifacts: call \`write_file\` to create \`${specPath}\` (the spec) AND \`${tasksPath}\` (the task breakdown). Use the spec-driven-skill structure for \`spec.md\` and the planning-skill structure for \`tasks.md\`. These files are the canonical record — do NOT produce a chat-only plan.`,
        '',
        'Phase 4 — STOP: present a short summary in chat referencing the file paths, then explicitly ask the user to confirm before any `worker` implementation begins.',
      ].join('\n'));
      break;
    }

    case '/spec': {
      const feature = args.join(' ').trim();
      if (!feature) { console.log(chalk.red('\nUsage: /spec <feature title>\n')); break; }
      const meta = createWorkflow(agent.workspaceRoot, { title: feature, kind: 'spec' });
      const specPath = artifactRelativePath(agent.workspaceRoot, meta.slug, ARTIFACT.spec);
      console.log(chalk.gray(`Workflow folder: ${path.dirname(specPath)}`));
      await runSkillCommand(agent, mcpClient, '/spec', feature, [
        '## Goal',
        `Produce a complete specification for: "${feature}".`,
        '',
        '## Mandatory steps',
        '1. Open with `memory_search` for related prior work; cite any recovered record IDs in the spec.',
        '2. Optionally spawn 1–2 `explorer` children to confirm scope before drafting (only if the feature touches unfamiliar code).',
        `3. Call \`write_file\` with path \`${specPath}\` containing the full spec, structured per the spec-driven-skill template (Objective, Commands, Project Structure, Code Style, Testing Strategy, Boundaries).`,
        '4. In chat, summarize the spec in ≤ 10 lines and reference the file path. Ask the user to approve before generating tasks or implementation.',
        '',
        '## Anti-patterns',
        '- Do NOT produce a multi-section spec inline in chat without writing the file.',
        '- Do NOT proceed to task breakdown or implementation until the user explicitly approves.',
      ].join('\n'));
      break;
    }

    case '/review': {
      const scope = args.join(' ').trim() || 'current unstaged and staged changes (git diff HEAD)';
      const meta = createWorkflow(agent.workspaceRoot, { title: `Review: ${scope}`, kind: 'review' });
      const reportPath = artifactRelativePath(agent.workspaceRoot, meta.slug, 'review.md');
      console.log(chalk.gray(`Workflow folder: ${path.dirname(reportPath)}`));
      await runSkillCommand(agent, mcpClient, command, scope, [
        '## Required memory-first opening',
        'Run `memory_search` for similar past reviews and `memory_file_history` for any files touched by this diff. Pass relevant record IDs through `seedRecordIds`.',
        '',
        '## Workflow (mandatory)',
        `Workflow slug: \`${meta.slug}\`. Output file: \`${reportPath}\`.`,
        '',
        'Step 1: call `spawn_agent` THREE times in parallel with role=reviewer and access=read. Focuses:',
        '(a) correctness / bugs / security;',
        '(b) maintainability / readability / design;',
        '(c) conventions / tests / documentation.',
        'Step 2: `wait_agent` on all three.',
        `Step 3: \`write_file\` to \`${reportPath}\` containing a severity-ordered synthesis (blocker / major / minor / nit) with file:line citations.`,
        'Step 4: summarize ≤ 15 lines in chat referencing the file. Do NOT edit reviewed files.',
      ].join('\n'));
      break;
    }

    case '/implement-plan': {
      const plan = readPlan(agent.workspaceRoot);
      const next = plan.items.find(i => i.status === 'pending' || i.status === 'in_progress');
      if (!next) { console.log(chalk.yellow('\nNo pending plan items.\n')); break; }
      // Attach this execution turn to the current workflow if there is one, so
      // walkthrough.md accumulates per workflow rather than per CLI session.
      const currentSlug = getCurrentWorkflow(agent.workspaceRoot);
      const slug = currentSlug ?? createWorkflow(agent.workspaceRoot, { title: next.step, kind: 'implement-plan' }).slug;
      const walkPath = artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.walkthrough);
      console.log(chalk.gray(`Workflow folder: ${path.dirname(walkPath)}`));
      await runSkillCommand(agent, mcpClient, command, `Next plan item: "${next.step}"`, [
        '## Required memory-first opening',
        'Run `memory_search` and `memory_task_state` scoped to this plan item. Seed the `worker` child with the record IDs.',
        '',
        '## Workflow (mandatory)',
        `Workflow slug: \`${slug}\`. Walkthrough file: \`${walkPath}\`.`,
        '',
        'Step 1: `update_plan` to mark this item `in_progress`.',
        'Step 2: `spawn_agent` role=worker access=write with concrete acceptance criteria AND `seedRecordIds`.',
        'Step 3: after the worker completes, `spawn_agent` role=verifier access=shell to run tests/typechecks.',
        `Step 4: append a section to \`${walkPath}\` (use \`read_file\` then \`write_file\`) recording: item name, files changed, verification commands run, PASS/FAIL, follow-ups.`,
        'Step 5: only on PASS, `update_plan` to `completed` AND `memory_task_update` with outcome. On FAIL, keep `in_progress`, surface failing output, `memory_task_update` with blocker.',
      ].join('\n'));
      break;
    }

    case '/approve': {
      const slug = args[0] || getCurrentWorkflow(agent.workspaceRoot);
      if (!slug) {
        console.log(chalk.red('\nNo current workflow. Use /spec or /feature-dev first, or /approve <slug>.\n'));
        break;
      }
      const spec = readArtifact(agent.workspaceRoot, slug, ARTIFACT.spec);
      if (!spec) {
        console.log(chalk.red(`\nWorkflow "${slug}" has no spec.md yet. Run /spec or /feature-dev first.\n`));
        break;
      }
      const next = updateWorkflowStatus(agent.workspaceRoot, slug, 'in-progress');
      if (!next) {
        console.log(chalk.red(`\nWorkflow "${slug}" not found.\n`));
        break;
      }
      console.log(chalk.green(`\n✓ Approved workflow "${slug}". Status: in-progress.`));
      console.log(chalk.gray('Kicking off implementation phase…\n'));
      const tasksPath = artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.tasks);
      const walkPath = artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.walkthrough);
      await runOrchestrationPrompt(agent,
        `The user just approved workflow \`${slug}\`. Begin implementation now.\n\n` +
        `1. If \`${tasksPath}\` does not exist yet, read \`${artifactRelativePath(agent.workspaceRoot, slug, ARTIFACT.spec)}\` and \`write_file\` a complete tasks.md (vertical slices, S/M-sized, with acceptance criteria) before doing anything else.\n` +
        `2. Pick the first pending task from tasks.md and call \`update_plan\` to mark it in_progress.\n` +
        `3. \`spawn_agent\` role=worker access=write to implement it. Pass any relevant recalled record IDs via seedRecordIds.\n` +
        `4. After the worker completes, \`spawn_agent\` role=verifier access=shell to run tests/typechecks.\n` +
        `5. Append a section to \`${walkPath}\` (read+write) recording the outcome.\n` +
        `6. STOP after the first task and ask whether to continue. Do not silently work through every task — the user approves slices, not the whole batch.`,
      );
      break;
    }

    case '/workflows': {
      const workflows = listWorkflows(agent.workspaceRoot);
      console.log(chalk.bold('\nDurable Workflows'));
      if (workflows.length === 0) {
        console.log(chalk.yellow('  (none yet — try /spec or /feature-dev)'));
      } else {
        const currentSlug = getCurrentWorkflow(agent.workspaceRoot);
        for (const w of workflows) {
          const marker = w.slug === currentSlug ? chalk.green(' ← current') : '';
          console.log(`  ${chalk.cyan(w.slug)} [${chalk.gray(w.status)}] ${chalk.gray(w.kind)}${marker}`);
          console.log(`    ${w.title}`);
          const hasSpec = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.spec);
          const hasTasks = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.tasks);
          const hasWalk = !!readArtifact(agent.workspaceRoot, w.slug, ARTIFACT.walkthrough);
          console.log(chalk.gray(`    spec.md:${hasSpec ? '✓' : '·'}  tasks.md:${hasTasks ? '✓' : '·'}  walkthrough.md:${hasWalk ? '✓' : '·'}`));
        }
      }
      console.log();
      break;
    }

    case '/skill': {
      const skillName = args[0];
      const userInput = args.slice(1).join(' ').trim();
      if (!skillName) {
        console.log(chalk.red('\nUsage: /skill <skill-name> [input]\n'));
        console.log(chalk.gray('Mapped slash commands:'));
        for (const [slash, name] of Object.entries(SLASH_TO_SKILL)) {
          console.log(`  ${chalk.cyan(slash.padEnd(18))} → ${chalk.green(name)}`);
        }
        console.log();
        break;
      }
      await runSkillByName(agent, mcpClient, skillName, userInput);
      break;
    }

    case '/memory': {
      const query = args.join(' ').trim();
      if (!query) { console.log(chalk.red('\nUsage: /memory <query>\n')); break; }
      await printMcpCall(mcpClient, 'memory_search', { query, sessionKey: agent.sessionKey }, 'BrainRouter Memory Search');
      break;
    }

    case '/recall': {
      const query = args.join(' ').trim();
      if (!query) { console.log(chalk.red('\nUsage: /recall <query>\n')); break; }
      await printMcpCall(mcpClient, 'memory_recall', { sessionKey: agent.sessionKey, query }, 'Cognitive Recall');
      break;
    }

    case '/briefing': {
      const b = agent.getLastBriefing();
      console.log(chalk.bold('\nLast Memory Briefing'));
      if (b.sources.length === 0) {
        console.log(chalk.yellow('  No briefing has been built yet. Start a turn or use /recall.'));
      } else {
        console.log(`  Sources queried: ${chalk.cyan(b.sources.join(', '))}`);
        console.log(`  Recalled record IDs (${b.recordIds.length}): ${chalk.gray(b.recordIds.slice(0, 10).join(', '))}${b.recordIds.length > 10 ? '…' : ''}`);
      }
      console.log();
      break;
    }

    case '/scenes': {
      await printMcpCall(mcpClient, 'memory_recall', { sessionKey: agent.sessionKey, query: 'list focus scenes' }, 'Active Focus Scenes (via memory_recall)');
      break;
    }

    case '/working': {
      await printMcpCall(mcpClient, 'memory_working_context', { sessionKey: agent.sessionKey, workspacePath: agent.workspaceRoot }, 'Working Memory Canvas');
      break;
    }

    case '/forget': {
      const id = args[0];
      if (!id) { console.log(chalk.red('\nUsage: /forget <recordId>\n')); break; }
      await printMcpCall(mcpClient, 'memory_update', { recordId: id, status: 'archived' }, `Archive memory ${id}`);
      break;
    }

    case '/init': {
      const result = initAgentMd(agent.workspaceRoot);
      if (result.status === 'created') {
        console.log(chalk.green(`\n✓ Created ${result.path}`));
        console.log(chalk.gray('Edit it to describe your project, conventions, and boundaries — every coding agent (BrainRouter, Claude Code, Codex) will read it.\n'));
      } else {
        console.log(chalk.yellow(`\nFile already exists: ${result.path}`));
        console.log(chalk.gray('Open it and edit by hand if you want to refresh it.\n'));
      }
      break;
    }

    case '/sessions': {
      const transcripts = listTranscripts(agent.workspaceRoot);
      console.log(chalk.bold('\nPersisted sessions:'));
      if (transcripts.length === 0) {
        console.log(chalk.yellow('  (none — start chatting and your transcript will appear here)'));
      } else {
        for (const t of transcripts.slice(0, 30)) {
          const when = t.modifiedAt.replace('T', ' ').slice(0, 19);
          const isCurrent = t.sessionKey === agent.sessionKey;
          const tag = isCurrent ? chalk.green(' (current)') : '';
          console.log(`  ${chalk.cyan(t.sessionKey)}${tag}`);
          console.log(`    ${chalk.gray(`${t.turnCount} entries · ${when}`)}`);
          if (t.firstUserMessage) console.log(`    ${chalk.gray(`"${t.firstUserMessage}"`)}`);
        }
        console.log(chalk.gray('\nResume one with: /resume <sessionKey>'));
      }
      console.log();
      break;
    }

    case '/resume': {
      const sessionKey = args.join(' ').trim();
      if (!sessionKey) {
        console.log(chalk.red('\nUsage: /resume <sessionKey>\n'));
        console.log(chalk.gray('Tip: copy a sessionKey from /sessions.\n'));
        break;
      }
      const entries = loadTranscript(agent.workspaceRoot, sessionKey);
      if (entries.length === 0) {
        console.log(chalk.red(`\nNo transcript found for "${sessionKey}".\n`));
        break;
      }
      agent.sessionKey = sessionKey;
      const loaded = agent.loadHistory(entries);
      console.log(chalk.green(`\n✓ Resumed session ${chalk.cyan(sessionKey)} with ${loaded} prior messages.`));
      console.log(chalk.gray('Your next message will continue the conversation.\n'));
      break;
    }

    case '/model': {
      const newModel = args[0];
      if (!newModel) {
        console.log(chalk.bold(`\nCurrent model: ${chalk.cyan(agent.getModel())}`));
        console.log(chalk.gray('Switch with: /model <model-name> (e.g. /model gpt-4o-mini, /model claude-sonnet-4-5)\n'));
        break;
      }
      const previous = agent.getModel();
      agent.setModel(newModel);
      console.log(chalk.green(`\n✓ Model switched: ${chalk.gray(previous)} → ${chalk.cyan(newModel)}\n`));
      break;
    }

    case '/mcp': {
      const profileName = config.activeServer;
      const server = config.servers[profileName];
      console.log(chalk.bold('\nMCP server'));
      console.log(`  Profile: ${chalk.green(profileName)} (${chalk.cyan(server?.type ?? 'unknown')})`);
      if (server?.type === 'http') {
        console.log(`  URL:     ${chalk.blue(server.url)}`);
      } else if (server?.type === 'stdio') {
        console.log(`  Cmd:     ${chalk.blue(server.command)} ${server.args?.join(' ') || ''}`);
      }
      const spinner = ora(chalk.gray('Fetching MCP tool surface...')).start();
      try {
        const res = await mcpClient.listTools();
        const tools = res.tools || [];
        spinner.succeed(chalk.green(`${tools.length} MCP tools available`));
        const namespaces: Record<string, string[]> = {};
        for (const t of tools) {
          const parts = (t.name || '').split('_');
          const ns = parts.length > 1 ? parts[0] : 'misc';
          (namespaces[ns] ||= []).push(t.name);
        }
        for (const ns of Object.keys(namespaces).sort()) {
          console.log(`\n  ${chalk.bold.cyan(ns)} (${namespaces[ns].length})`);
          for (const name of namespaces[ns].sort()) {
            console.log(`    ${chalk.gray('•')} ${name}`);
          }
        }
      } catch (err: any) {
        spinner.fail(chalk.red(`Failed: ${err.message}`));
      }
      console.log();
      break;
    }

    case '/goal': {
      const arg = args.join(' ').trim();
      if (!arg || arg === 'show') {
        const goal = readGoal(agent.workspaceRoot);
        if (!goal) console.log(chalk.yellow('\nNo sticky goal set. Set one with: /goal <text>\n'));
        else console.log(chalk.bold('\nCurrent goal:') + ` ${chalk.cyan(goal.text)}\n` + chalk.gray(`Set ${goal.setAt}\n`));
        break;
      }
      if (arg === 'clear') {
        clearGoal(agent.workspaceRoot);
        agent.refreshSystemPrompt();
        console.log(chalk.green('\n✓ Goal cleared.\n'));
        break;
      }
      const goal = setGoal(agent.workspaceRoot, arg);
      agent.refreshSystemPrompt();
      console.log(chalk.green(`\n✓ Goal set: ${chalk.cyan(goal.text)}\n`));
      console.log(chalk.gray('It will be injected into every turn until /goal clear.\n'));
      break;
    }

    case '/copy': {
      if (!agent.lastAnswer) {
        console.log(chalk.yellow('\nNo response yet to copy.\n'));
        break;
      }
      const result = await copyToClipboard(agent.lastAnswer);
      if (result.ok) {
        console.log(chalk.green(`\n✓ Copied last response to clipboard via ${result.tool} (${agent.lastAnswer.length} chars).\n`));
      } else {
        console.log(chalk.yellow(`\nClipboard tool unavailable (${result.error}). Selecting the text above with your terminal still works.\n`));
      }
      break;
    }

    case '/fork': {
      const label = args.join(' ').trim() || `fork-${new Date().toISOString().slice(11, 19)}`;
      const newKey = `${agent.sessionKey}:fork:${randomUUID().slice(0, 8)}:${label.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
      const previous = agent.sessionKey;
      agent.fork(newKey);
      console.log(chalk.green(`\n✓ Forked session.`));
      console.log(chalk.gray(`  Parent : ${previous}`));
      console.log(chalk.gray(`  New    : ${newKey}`));
      console.log(chalk.gray('  Your next message starts a new transcript while keeping prior context.\n'));
      break;
    }

    case '/rename': {
      const newName = args.join(' ').trim();
      if (!newName) {
        console.log(chalk.red('\nUsage: /rename <new session label>\n'));
        break;
      }
      const safe = newName.replace(/[^A-Za-z0-9._-]+/g, '-');
      const previous = agent.sessionKey;
      const newKey = `${previous.split(':')[0]}:${safe}`;
      agent.sessionKey = newKey;
      agent.refreshSystemPrompt();
      console.log(chalk.green(`\n✓ Session renamed`));
      console.log(chalk.gray(`  Old: ${previous}`));
      console.log(chalk.gray(`  New: ${newKey}`));
      console.log(chalk.gray('  (Future transcript entries land under the new key; existing entries stay under the old.)\n'));
      break;
    }

    case '/permissions': {
      const sub = args[0];
      if (!sub) {
        const mode = agent.getAccessMode();
        console.log(chalk.bold(`\nCurrent access mode: ${chalk.cyan(mode)}`));
        console.log(chalk.gray('  read   — list/grep/read/web only. No file writes, no shell.'));
        console.log(chalk.gray('  write  — read + write_file / edit_file / apply_patch. No shell.'));
        console.log(chalk.gray('  shell  — write + run_command (still confirmed in the REPL).'));
        console.log(chalk.gray('\nSwitch with: /permissions read | write | shell  (or use Shift+Tab to cycle)\n'));
        break;
      }
      if (!['read', 'write', 'shell'].includes(sub)) {
        console.log(chalk.red(`\nUnknown mode "${sub}". Choose: read, write, shell.\n`));
        break;
      }
      agent.setAccessMode(sub as 'read' | 'write' | 'shell');
      ctx.refreshPromptForMode();
      console.log(chalk.green(`\n✓ Access mode → ${chalk.cyan(sub)}\n`));
      break;
    }

    case '/hooks': {
      const sub = args[0];
      if (!sub || sub === 'list') {
        const hooks = readHooks(agent.workspaceRoot);
        console.log(chalk.bold('\nLifecycle hooks'));
        if (hooks.length === 0) {
          console.log(chalk.yellow('  (none)'));
          console.log(chalk.gray('  Add one with: /hooks add <event> <shell-command>  (events: pre-turn, post-turn, pre-tool, post-tool, session-start, session-end)\n'));
        } else {
          for (const h of hooks) {
            const tag = h.enabled ? chalk.green('●') : chalk.gray('○');
            console.log(`  ${tag} ${chalk.cyan(h.id)} ${chalk.gray(h.event)}${h.match ? chalk.gray(` (match: ${h.match})`) : ''}`);
            console.log(`    ${chalk.gray(h.command)}`);
          }
          console.log();
        }
        break;
      }
      if (sub === 'add') {
        const event = args[1] as HookEvent | undefined;
        const command = args.slice(2).join(' ').trim();
        const validEvents: HookEvent[] = ['pre-turn', 'post-turn', 'pre-tool', 'post-tool', 'session-start', 'session-end'];
        if (!event || !validEvents.includes(event) || !command) {
          console.log(chalk.red(`\nUsage: /hooks add <${validEvents.join('|')}> <shell-command>\n`));
          break;
        }
        const created = addHook(agent.workspaceRoot, { event, command });
        console.log(chalk.green(`\n✓ Hook added: ${created.id}\n`));
        break;
      }
      if (sub === 'remove' && args[1]) {
        const ok = removeHook(agent.workspaceRoot, args[1]);
        console.log(ok ? chalk.green(`\n✓ Removed ${args[1]}\n`) : chalk.red(`\nNo hook with id ${args[1]}\n`));
        break;
      }
      if ((sub === 'enable' || sub === 'disable') && args[1]) {
        const ok = setHookEnabled(agent.workspaceRoot, args[1], sub === 'enable');
        console.log(ok ? chalk.green(`\n✓ ${sub === 'enable' ? 'Enabled' : 'Disabled'} ${args[1]}\n`) : chalk.red(`\nNo hook with id ${args[1]}\n`));
        break;
      }
      console.log(chalk.red('\nUsage: /hooks [list | add <event> <cmd> | remove <id> | enable <id> | disable <id>]\n'));
      break;
    }

    case '/loop': {
      const arg0 = args[0];
      if (!arg0 || arg0 === 'status') {
        const state = getLoopState();
        if (!state) console.log(chalk.yellow('\nNo loop running.\n'));
        else {
          console.log(chalk.bold('\nLoop state'));
          console.log(`  Prompt:      ${chalk.cyan(state.prompt)}`);
          console.log(`  Interval:    ${chalk.gray(`${state.intervalMs}ms`)}`);
          console.log(`  Iterations:  ${chalk.gray(state.iterations.toString())}`);
          if (state.lastFiredAt) console.log(`  Last fired:  ${chalk.gray(state.lastFiredAt)}`);
          if (state.lastError) console.log(`  Last error:  ${chalk.red(state.lastError)}`);
          console.log(chalk.gray('\n  Stop with /loop stop\n'));
        }
        break;
      }
      if (arg0 === 'stop') {
        const ok = stopLoop();
        console.log(ok ? chalk.green('\n✓ Loop stopped.\n') : chalk.yellow('\nNo loop was running.\n'));
        break;
      }
      const intervalMs = parseInterval(arg0);
      const loopPrompt = args.slice(intervalMs ? 1 : 0).join(' ').trim();
      if (!intervalMs || !loopPrompt) {
        console.log(chalk.red('\nUsage: /loop <interval> <prompt>'));
        console.log(chalk.gray('  e.g. /loop 30s /review'));
        console.log(chalk.gray('       /loop 5m check the deploy status\n'));
        break;
      }
      const result = startLoop(loopPrompt, intervalMs, async () => {
        // Each tick queues the loop's prompt as if the user typed it. We use
        // the REPL's processing flag to avoid stomping on a turn the user
        // started manually.
        if (ctx.isProcessing()) return;
        console.log(chalk.gray(`\n⟲ Loop tick (iteration ${(getLoopState()?.iterations ?? 0)})`));
        rl.write(`${loopPrompt}\n`);
      });
      if (result.started) {
        console.log(chalk.green(`\n✓ Loop started — "${loopPrompt}" every ${intervalMs}ms.`));
        console.log(chalk.gray('  Stop with /loop stop.\n'));
      } else {
        console.log(chalk.red(`\nLoop not started: ${result.reason}\n`));
      }
      break;
    }

    case '/clear':
    case '/compact':
      agent.clearHistory();
      console.log(chalk.yellow('\nConversation history cleared.\n'));
      break;

    case '/exit':
      rl.close();
      break;

    default:
      console.log(chalk.red(`\nUnknown slash command: ${command}. Type /help for assistance.\n`));
  }
}

async function runSkillCommand(
  agent: Agent,
  mcpClient: McpClientWrapper,
  slashCommand: string,
  userInput: string,
  orchestration?: string,
): Promise<void> {
  const skillName = SLASH_TO_SKILL[slashCommand];
  if (!skillName) {
    console.log(chalk.red(`\nNo skill mapped to ${slashCommand}.\n`));
    return;
  }
  await runSkillByName(agent, mcpClient, skillName, userInput, orchestration);
}

async function runSkillByName(
  agent: Agent,
  mcpClient: McpClientWrapper,
  skillName: string,
  userInput: string,
  orchestration?: string,
): Promise<void> {
  const loader = ora(chalk.gray(`Loading skill: ${skillName}...`)).start();
  let prompt: string;
  try {
    const skill = await resolveSkill(mcpClient, skillName, agent.workspaceRoot, 'full');
    loader.succeed(chalk.green(`Skill loaded: ${skillName} (${skill.source})`));
    prompt = buildSkillPrompt(skill, { input: userInput, orchestration });
  } catch (err: any) {
    loader.fail(chalk.red(`Failed to resolve skill "${skillName}": ${err.message}`));
    return;
  }
  await runOrchestrationPrompt(agent, prompt);
}

async function runOrchestrationPrompt(agent: Agent, prompt: string): Promise<void> {
  const spinner = ora(chalk.gray('Orchestrating...')).start();
  try {
    const answer = await agent.runTurn(prompt, {
      onStatusUpdate: (status) => { spinner.text = chalk.gray(status); },
      onToolStart: (name, args) => {
        spinner.stop();
        console.log(chalk.gray('🛞  ') + chalk.cyan(name) + chalk.gray(` ${JSON.stringify(args).slice(0, 200)}`));
      },
      onToolEnd: (name, result) => {
        if (result.success) {
          console.log(chalk.green('✓  ') + chalk.cyan(name) + chalk.gray(` ${result.summary}`));
        } else {
          console.log(chalk.red('❌  ') + chalk.cyan(name) + chalk.yellow(` ${result.summary}`));
        }
        spinner.start(chalk.gray('Thinking...'));
      },
    });
    spinner.succeed(chalk.green('Done!'));
    console.log('\n' + marked.parse(answer) + '\n');
  } catch (err: any) {
    spinner.fail(chalk.red(`Failed: ${err.message}`));
  }
}

/**
 * Tab-completion source for `@path/to/file` mentions. Given a partial workspace
 * path, return the matching files and directories one level deep. Stays inside
 * the workspace and ignores noise dirs to keep the completion list useful.
 */
function completeWorkspacePath(workspaceRoot: string, partial: string): string[] {
  const ignore = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', '.brainrouter']);
  // Split partial into "dir/" + "prefix" so we only enumerate one directory at a time.
  const lastSlash = partial.lastIndexOf('/');
  const subdir = lastSlash >= 0 ? partial.slice(0, lastSlash + 1) : '';
  const prefix = lastSlash >= 0 ? partial.slice(lastSlash + 1) : partial;
  let absDir: string;
  try {
    absDir = path.resolve(workspaceRoot, subdir || '.');
  } catch {
    return [];
  }
  // Don't escape the workspace.
  if (path.relative(workspaceRoot, absDir).startsWith('..')) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !ignore.has(e.name) && e.name.startsWith(prefix))
    .map((e) => `${subdir}${e.name}${e.isDirectory() ? '/' : ''}`)
    .sort();
}

async function printMcpCall(
  mcpClient: McpClientWrapper,
  toolName: string,
  args: Record<string, unknown>,
  heading: string,
): Promise<void> {
  const spinner = ora(chalk.gray(`${toolName}…`)).start();
  const res = await callMcpTool(mcpClient, toolName, args);
  spinner.stop();
  console.log(chalk.bold(`\n${heading}`));
  if (res.isError) {
    console.log(chalk.red(`  Tool error: ${res.text || '(no message)'}`));
    console.log();
    return;
  }
  if (!res.text.trim()) {
    console.log(chalk.yellow('  (empty result)'));
    console.log();
    return;
  }
  const preview = res.text.length > 4000
    ? res.text.slice(0, 4000) + chalk.gray(`\n…(${res.text.length - 4000} chars truncated)`)
    : res.text;
  console.log(chalk.gray(preview));
  console.log();
}

function formatTranscriptContent(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240);
}
