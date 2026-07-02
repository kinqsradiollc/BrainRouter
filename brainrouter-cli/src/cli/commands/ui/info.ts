/**
 * Extracted from cli/commands/ui.ts — informational / misc subcommands.
 *
 * `/copy`, `/apps`, `/plugins`, `/mention`, `/ide`, `/where`, `/help`.
 * Behavior-preserving: bodies moved verbatim.
 */

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { copyToClipboard } from '../../../runtime/clipboard.js';
import { completeWorkspacePath, renderHelp } from '../../repl.js';
import { listFilesystemSkills } from '../../../prompt/skillCatalog.js';
import type { CommandContext } from '../_context.js';

export async function tryHandleUiInfoCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
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
      const skills = listFilesystemSkills(agent.workspaceRoot);
      if (skills.length > 0) {
        console.log(chalk.gray('  Skills'));
        for (const skill of skills) {
          const category = skill.category ? `${skill.category}/` : '';
          console.log(`  • ${chalk.cyan(`${category}${skill.name}`)} (${chalk.gray(skill.scope ?? 'filesystem')})`);
        }
      }
      if (fs.existsSync(pluginsRoot)) {
        const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
        const pluginDirs = entries.filter((entry) => entry.isDirectory());
        if (pluginDirs.length > 0) {
          console.log(chalk.gray('  Plugin folders'));
          for (const entry of pluginDirs) {
            console.log(`  • ${chalk.cyan(path.relative(agent.workspaceRoot, path.join(pluginsRoot, entry.name)))}`);
          }
        }
      }
      console.log();
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
      const { gatherWhereInputs, renderWhere } = await import('../../whereView.js');
      const { resolveDisplayedMcpState } = await import('../../banner.js');
      const { resolveTheme } = await import('../../theme.js');
      const theme = resolveTheme(agent.workspaceRoot);
      const displayedMcp = resolveDisplayedMcpState(config, mcpClient as any);
      const briefing = agent.getLastBriefing();
      const inputs = gatherWhereInputs({
        workspaceRoot: agent.workspaceRoot,
        sessionKey: agent.sessionKey,
        model: agent.getModel(),
        mcpProfile: displayedMcp.profile,
        mcpTransport: displayedMcp.transport,
        mcpOnline: displayedMcp.online,
        mcpIdentity: displayedMcp.identity,
        accessMode: agent.getAccessMode(),
        recalledRecords: agent.getRecalledRecords(),
        briefingSources: briefing.sources,
        briefingSourceStats: briefing.sourceStats,
      });
      console.log('\n' + renderWhere(inputs, theme) + '\n');
      // AUG-A1: surface the active Project (multi-folder scope) if a
      // `.brainrouter/project.json` marker names one.
      const { activeProjectName } = await import('../../../config/project.js');
      const project = activeProjectName(agent.workspaceRoot);
      if (project) {
        console.log(`  Project: ${project}  ${chalk.gray('(recall can widen to this project with scope:project)')}\n`);
      }
      return true;
    }
    case '/help': {
      renderHelp(args[0]?.toLowerCase());
      return true;
    }
  }
  return false;
}
