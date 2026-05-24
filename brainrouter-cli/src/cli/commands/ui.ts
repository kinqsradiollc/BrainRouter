/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import ora from 'ora';
import { LOCAL_TOOLS } from '../../agent/agent.js';
import { callMcpTool } from '../../runtime/mcpUtils.js';
import { listSessions, reconcileStale } from '../../orchestration/orchestrator.js';
import { readPreferences, writePreferences } from '../../state/preferencesStore.js';
import { readPlan } from '../../state/taskStore.js';
import { getConfigPath } from '../../config/config.js';
import { copyToClipboard } from '../../runtime/clipboard.js';
import { initAgentMd } from '../../prompt/initAgentMd.js';
import type { CommandContext } from './_context.js';
import { completeWorkspacePath, renderHelp } from '../repl.js';


export async function tryHandleUiCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/status':
    {
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
      return true;
    }
    case '/workspace':
    {
      console.log(chalk.bold('\nWorkspace:'));
      console.log(`  Root:       ${chalk.blue(agent.workspaceRoot)}`);
      console.log(`  Launch CWD: ${chalk.gray(agent.launchCwd)}`);
      console.log(`  Session:    ${chalk.green(agent.sessionKey)}`);
      console.log();
      return true;
    }
    case '/config':
    {
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
      return true;
    }
    case '/doctor':
    {
      console.log(chalk.bold('\nBrainRouter Doctor:'));
      console.log(`  Config file: ${chalk.blue(getConfigPath())}`);
      console.log(`  Active profile: ${chalk.green(config.activeServer)}`);

      const server = config.servers[config.activeServer];
      if (!server) {
        console.log(chalk.red('  Server profile: missing'));
        return true;
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

      // Memory health: are captures actually being extracted into searchable
      // cognitive records, or are they piling up in sensory_stream? This is
      // the silent failure mode that makes briefings return "0 records" — the
      // CLI shows 💾 Captured after every turn but the LLM the extractor
      // needs may not be configured in the MCP child env.
      try {
        const diagRes = await callMcpTool<any>(mcpClient, 'memory_diagnostics', {});
        const ext = diagRes.parsed?.databaseStats?.userStats?.extraction;
        if (ext) {
          const errs = ext.extractionErrors ?? 0;
          const pending = ext.unextractedCount ?? 0;
          const total = diagRes.parsed?.databaseStats?.userStats?.total ?? 0;
          const headline = errs > 0
            ? chalk.red(`  Memory extraction: DEGRADED — ${errs} consecutive failures`)
            : pending > 5
              ? chalk.yellow(`  Memory extraction: backlog of ${pending} sensory rows pending`)
              : chalk.green(`  Memory extraction: healthy (${total} cognitive records, ${pending} pending)`);
          console.log(headline);
          if (ext.lastErrorMessage) {
            console.log(chalk.gray(`    Last error: ${String(ext.lastErrorMessage).slice(0, 160)}`));
          }
          if (errs > 0 || !diagRes.parsed?.envKeys?.some?.((k: string) => /BRAINROUTER_LLM_API_KEY|OPENAI_API_KEY/.test(k))) {
            console.log(chalk.gray('    Hint: set OPENAI_API_KEY (or BRAINROUTER_LLM_API_KEY) before launching brainrouter so the MCP child can run extraction.'));
          }
        }
      } catch (err: any) {
        console.log(chalk.yellow(`  Memory extraction: unable to query (${err?.message ?? err})`));
      }

      const plan = readPlan(agent.workspaceRoot, agent.sessionKey);
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
      return true;
    }
    case '/init':
    {
      const result = initAgentMd(agent.workspaceRoot);
      if (result.status === 'created') {
        console.log(chalk.green(`\n✓ Created ${result.path}`));
        console.log(chalk.gray('Edit it to describe your project, conventions, and boundaries — any AGENT.md-aware coding agent will read it.\n'));
      } else {
        console.log(chalk.yellow(`\nFile already exists: ${result.path}`));
        console.log(chalk.gray('Open it and edit by hand if you want to refresh it.\n'));
      }
      return true;
    }
    case '/model':
    {
      const newModel = args[0];
      if (!newModel) {
        console.log(chalk.bold(`\nCurrent model: ${chalk.cyan(agent.getModel())}`));
        console.log(chalk.gray('Switch with: /model <model-name> (e.g. /model gpt-4o-mini, /model gpt-5, /model qwen2.5-coder)\n'));
        return true;
      }
      const previous = agent.getModel();
      agent.setModel(newModel);
      console.log(chalk.green(`\n✓ Model switched: ${chalk.gray(previous)} → ${chalk.cyan(newModel)}\n`));
      return true;
    }
    case '/mcp':
    {
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
      return true;
    }
    case '/copy':
    {
      if (!agent.lastAnswer) {
        console.log(chalk.yellow('\nNo response yet to copy.\n'));
        return true;
      }
      const result = await copyToClipboard(agent.lastAnswer);
      if (result.ok) {
        console.log(chalk.green(`\n✓ Copied last response to clipboard via ${result.tool} (${agent.lastAnswer.length} chars).\n`));
      } else {
        console.log(chalk.yellow(`\nClipboard tool unavailable (${result.error}). Selecting the text above with your terminal still works.\n`));
      }
      return true;
    }
    case '/vim':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const next = prefs.editorMode === 'vi' ? 'emacs' : 'vi';
      writePreferences(agent.workspaceRoot, { editorMode: next });
      console.log(chalk.green(`\n✓ Editor mode → ${next}. Restart the CLI to apply.\n`));
      return true;
    }
    case '/statusline':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args.join(' ').trim();
      const { SEGMENT_NAMES, isKnownSegment } = await import('../statusline.js');
      if (!arg) {
        console.log(chalk.bold('\nStatusline'));
        console.log(`  Current: ${chalk.cyan(prefs.statusline)}`);
        console.log(chalk.gray(`  Available segments: ${SEGMENT_NAMES.join(', ')}`));
        console.log(chalk.gray('  Example: /statusline mode,workflow,goal,model,session,plan\n'));
        return true;
      }
      const requested = arg.split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = requested.filter((s) => !isKnownSegment(s));
      if (unknown.length > 0) {
        console.log(chalk.red(`\nUnknown segment(s): ${unknown.join(', ')}. Valid: ${SEGMENT_NAMES.join(', ')}\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { statusline: requested.join(',') });
      ctx.repl.refreshPromptForMode();
      console.log(chalk.green(`\n✓ Statusline set to: ${requested.join(',')}\n`));
      return true;
    }
    case '/theme':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const valid = new Set(['auto', 'light', 'dark', 'mono']);
      if (!arg) {
        console.log(chalk.bold('\nTheme'));
        console.log(`  Current: ${chalk.cyan(prefs.theme)}`);
        console.log(chalk.gray(`  Available: ${Array.from(valid).join(', ')}`));
        console.log(chalk.gray('  Set with: /theme <name>\n'));
        return true;
      }
      if (!valid.has(arg)) {
        console.log(chalk.red(`\nUnknown theme "${arg}". Choose: ${Array.from(valid).join(', ')}\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { theme: arg as any });
      console.log(chalk.green(`\n✓ Theme → ${arg}\n`));
      return true;
    }
    case '/title':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args.join(' ').trim();
      if (!arg) {
        console.log(chalk.bold('\nTerminal title'));
        console.log(`  Current: ${chalk.cyan(prefs.terminalTitle)}`);
        console.log(chalk.gray('  Segments: model, branch, session, mode  (use "off" to disable)'));
        console.log(chalk.gray('  Example: /title model,session\n'));
        return true;
      }
      writePreferences(agent.workspaceRoot, { terminalTitle: arg });
      try {
        if (arg.toLowerCase() !== 'off') {
          const segs = arg.split(',').map((s) => s.trim()).filter(Boolean);
          const parts: string[] = [];
          for (const seg of segs) {
            if (seg === 'model') parts.push(agent.getModel());
            else if (seg === 'session') parts.push(agent.sessionKey.slice(0, 24));
            else if (seg === 'mode') parts.push(agent.getAccessMode());
            else if (seg === 'branch') {
              try { parts.push(execSync('git rev-parse --abbrev-ref HEAD', { cwd: agent.workspaceRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { /* not a git repo */ }
            }
          }
          if (parts.length > 0) process.stdout.write(`\x1b]0;brainrouter · ${parts.join(' · ')}\x07`);
        }
      } catch { /* terminal does not support OSC titles */ }
      console.log(chalk.green(`\n✓ Terminal title → ${arg}\n`));
      return true;
    }
    case '/personality':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const valid = new Set(['concise', 'standard', 'detailed', 'pair-programmer']);
      if (!arg) {
        console.log(chalk.bold('\nPersonality (communication style)'));
        console.log(`  Current: ${chalk.cyan(prefs.personality)}`);
        console.log(chalk.gray(`  Available: ${Array.from(valid).join(', ')}\n`));
        return true;
      }
      if (!valid.has(arg)) {
        console.log(chalk.red(`\nUnknown personality "${arg}". Choose: ${Array.from(valid).join(', ')}\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { personality: arg as any });
      agent.refreshSystemPrompt();
      console.log(chalk.green(`\n✓ Personality → ${arg}. New behavior applies on the next turn.\n`));
      return true;
    }
    case '/raw':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const next = arg ? (arg === 'on' || arg === 'true' || arg === '1') : !prefs.rawScrollback;
      writePreferences(agent.workspaceRoot, { rawScrollback: next });
      console.log(chalk.green(`\n✓ Raw scrollback ${next ? 'enabled' : 'disabled'}. Markdown rendering ${next ? 'OFF' : 'ON'} for next turn.\n`));
      return true;
    }
    case '/quiet':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const next = arg ? (arg === 'on' || arg === 'true' || arg === '1') : !prefs.quiet;
      writePreferences(agent.workspaceRoot, { quiet: next });
      // `--quiet` set a one-shot env override at startup; once the user
      // explicitly toggles in-session their choice wins from now on.
      if (next) {
        process.env.BRAINROUTER_QUIET = '1';
      } else {
        delete process.env.BRAINROUTER_QUIET;
      }
      const detail = next
        ? 'recall tables, briefing dumps, and tool-completion previews are now hidden.'
        : 'full chrome restored — recall tables, previews, and briefings will print again.';
      console.log(chalk.green(`\n✓ Quiet mode ${next ? 'enabled' : 'disabled'}: ${detail}\n`));
      return true;
    }
    case '/apps':
    case '/plugins':
    {
      const skillsRoot = path.join(agent.workspaceRoot, 'skills');
      const pluginsRoot = path.join(agent.workspaceRoot, 'plugins');
      console.log(chalk.bold(`\n${command === '/apps' ? 'Apps' : 'Plugins'}`));
      const roots = [skillsRoot, pluginsRoot].filter((p) => fs.existsSync(p));
      if (roots.length === 0) {
        console.log(chalk.yellow('  No skills/ or plugins/ directory in this workspace.'));
        console.log(chalk.gray('  Drop a folder under skills/<category>/<name>/SKILL.md to register one.\n'));
        return true;
      }
      for (const root of roots) {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          console.log(chalk.cyan(`  ${path.relative(agent.workspaceRoot, path.join(root, entry.name))}`));
        }
      }
      console.log();
      return true;
    }
    case '/experimental':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      const next = arg ? (arg === 'on' || arg === 'true' || arg === '1') : !prefs.experimental;
      writePreferences(agent.workspaceRoot, { experimental: next });
      console.log(chalk.green(`\n✓ Experimental features ${next ? 'enabled' : 'disabled'}.`));
      if (next) console.log(chalk.gray('  Streaming output, theme rendering, and other gated features are now active.\n'));
      else console.log();
      return true;
    }
    case '/mention':
    {
      const partial = args.join(' ').trim();
      console.log(chalk.bold('\nFile mention helper'));
      console.log(chalk.gray('  Inline syntax: write `@path/to/file` in a prompt — the CLI expands it before sending.'));
      const ws = agent.workspaceRoot;
      const suggestions = completeWorkspacePath(ws, partial || '');
      if (suggestions.length === 0) {
        console.log(chalk.yellow('  No files matched.\n'));
        return true;
      }
      console.log(chalk.gray(`  Workspace matches${partial ? ` for "${partial}"` : ''}:`));
      for (const s of suggestions.slice(0, 20)) console.log(`    ${chalk.cyan('@' + s)}`);
      if (suggestions.length > 20) console.log(chalk.gray(`    …and ${suggestions.length - 20} more`));
      console.log();
      return true;
    }
    case '/keymap':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = args.join(' ').trim();
      if (!arg) {
        console.log(chalk.bold('\nKeymap'));
        console.log(chalk.gray('  Current overrides:'));
        console.log(chalk.gray(`    ${prefs.keymap || '(none — defaults)'}`));
        console.log(chalk.bold('\n  Built-in bindings'));
        console.log(chalk.gray('    Shift+Tab       cycle access mode (read → write → shell)'));
        console.log(chalk.gray('    Tab             autocomplete slash commands and @mentions'));
        console.log(chalk.gray('    Ctrl+C          interrupt current turn / exit'));
        console.log(chalk.gray('    /vim            toggle vi-mode for the composer'));
        console.log(chalk.gray('\n  Set custom overrides (JSON map): /keymap {"submit":"ctrl+s"}\n'));
        return true;
      }
      try {
        JSON.parse(arg); // validate
      } catch (err: any) {
        console.log(chalk.red(`\nInvalid JSON: ${err.message}\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { keymap: arg });
      console.log(chalk.green(`\n✓ Keymap overrides saved. Restart the CLI to apply.\n`));
      return true;
    }
    case '/ide':
    {
      const env = process.env;
      console.log(chalk.bold('\nIDE context'));
      const cursor = env.CURSOR_TRACE_ID ? 'Cursor' : null;
      const code = env.VSCODE_INJECTION || env.VSCODE_PID ? 'VS Code' : null;
      const jet = env.JETBRAINS_IDE || env.IDEA_INITIAL_DIRECTORY ? 'JetBrains' : null;
      const detected = [cursor, code, jet].filter(Boolean);
      console.log(`  Detected: ${detected.length > 0 ? chalk.cyan(detected.join(', ')) : chalk.gray('(none — running standalone)')}`);
      console.log(chalk.gray('  Brainrouter reads files via the workspace root; if your IDE has an open selection, paste it with @ mentions or copy/paste.'));
      console.log(chalk.gray('  Tip: configure IDE to launch brainrouter with -w <workspace> so paths match.\n'));
      return true;
    }
    case '/where':
    {
      const { gatherWhereInputs, renderWhere } = await import('../whereView.js');
      const { resolveTheme } = await import('../theme.js');
      const theme = resolveTheme(agent.workspaceRoot);
      const profileName = config.activeServer;
      const server = config.servers[profileName];
      const briefing = agent.getLastBriefing();
      const inputs = gatherWhereInputs({
        workspaceRoot: agent.workspaceRoot,
        sessionKey: agent.sessionKey,
        model: agent.getModel(),
        mcpProfile: profileName,
        mcpTransport: server?.type ?? 'unknown',
        mcpOnline: mcpClient.isConnected(),
        accessMode: agent.getAccessMode(),
        recalledRecords: agent.getRecalledRecords(),
        briefingSources: briefing.sources,
      });
      console.log('\n' + renderWhere(inputs, theme) + '\n');
      return true;
    }
    case '/help': {
      renderHelp(args[0]?.toLowerCase());
      return true;
    }
    case '/test-picker':
    {
      // Manual smoke-test for the ask_user_choice picker UX without going
      // through the agent. Single-select by default; pass `multi` to
      // exercise the checkbox path. The picker's "Other" row is always
      // appended internally, so this also tests the free-text fallback.
      const { askChoice, CancelledChoiceError, NoTTYError } = await import('../cliPrompt.js');
      const multi = args[0]?.toLowerCase() === 'multi';
      const options = [
        { label: 'Apple', description: 'Red, crunchy, classic.' },
        { label: 'Banana', description: 'Yellow, soft, potassium.' },
        { label: 'Cherry', description: 'Small, tart, summer fruit.' },
      ];
      console.log(chalk.gray(
        `\nDemo picker (${multi ? 'multi-select' : 'single-select'}). ` +
        `Try: ↑/↓ to navigate, ${multi ? 'SPACE to toggle, ' : ''}ENTER to confirm, ` +
        `q/Esc to cancel. Pick "Other" to type a free-form answer.\n`,
      ));
      try {
        const result = await askChoice(
          'Which fruit do you want?',
          options,
          { multiSelect: multi, header: 'Demo' },
        );
        console.log('\n' + chalk.green('✓ Picker returned: ') + JSON.stringify(result));
        console.log(chalk.gray('  (this is exactly what the ask_user_choice tool would feed back to the agent)\n'));
      } catch (err) {
        if (err instanceof CancelledChoiceError) {
          console.log('\n' + chalk.yellow('⚠ Picker cancelled by user (Esc/q/Ctrl+C).\n'));
        } else if (err instanceof NoTTYError) {
          console.log('\n' + chalk.red('✗ NoTTYError — stdin isn\'t an interactive TTY.\n'));
        } else {
          console.log('\n' + chalk.red(`✗ Picker errored: ${(err as Error).message}\n`));
        }
      } finally {
        // The picker pauses the parent rl on entry and doesn't auto-resume
        // (that's runAgentTurn's job for tool-driven invocations). For
        // slash-command-driven invocations like this one, the input would
        // otherwise stay paused after the picker exits and the user would
        // think the REPL froze. Resume manually.
        rl.resume();
      }
      return true;
    }
  }
  return false;
}
