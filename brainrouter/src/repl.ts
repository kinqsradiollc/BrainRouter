import readline from 'node:readline';
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
import { readTranscriptEntries } from './sessionStore.js';
import { formatPlan, readPlan, updatePlan } from './taskStore.js';
import type { WorkspaceInfo } from './workspace.js';
import { listRoles } from './agentRoles.js';
import { formatSessionSummary, getSession, listSessions, reconcileStale } from './orchestrator.js';
import { buildSkillPrompt, resolveSkill, SLASH_TO_SKILL } from './skillRunner.js';
import { callMcpTool, childSessionKey } from './mcpUtils.js';
import { ARTIFACT, artifactRelativePath, createWorkflow, getCurrentWorkflow, listWorkflows, readArtifact, slugify } from './workflowArtifacts.js';

const execPromise = promisify(exec);

// Setup marked terminal rendering
marked.use(markedTerminal({
  showSectionPrefix: false,
}));

export function startREPL(agent: Agent, mcpClient: McpClientWrapper, config: Config, workspace?: WorkspaceInfo) {
  console.log(chalk.bold.hex('#CC9166')('\n🧠 BRAINROUTER TERMINAL AGENT CLIENT v0.2.0'));
  console.log(chalk.gray('Midnight Ledger / Obsidian Surface theme active.'));
  console.log(chalk.gray(`Workspace root: ${workspace?.workspaceRoot || process.cwd()}`));
  console.log(chalk.gray('Type ') + chalk.cyan('/help') + chalk.gray(' for commands, or start typing your prompt.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.hex('#CC9166')('brainrouter> ')
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

      await handleSlashCommand(command, args, agent, mcpClient, config, rl);
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

    // Run agent turn
    const spinner = ora(chalk.gray('Agent starting...')).start();
    try {
      const answer = await agent.runTurn(input, {
        onStatusUpdate: (status) => {
          spinner.text = chalk.gray(status);
        },
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
          spinner.start(chalk.gray('Thinking...'));
        },
      });
      spinner.succeed(chalk.green('Done!'));

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

async function handleSlashCommand(
  command: string,
  args: string[],
  agent: Agent,
  mcpClient: McpClientWrapper,
  config: Config,
  rl: readline.Interface
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
