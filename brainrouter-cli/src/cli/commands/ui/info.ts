/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 *
 * Info / utility UI commands split out of ui/index.ts:
 *   /copy /apps /plugins /mention /ide /help
 */

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { copyToClipboard } from '../../../runtime/platform/clipboard.js';
import { completeWorkspacePath, renderHelp } from '../../prompt/repl.js';
import { listFilesystemSkills } from '../../../prompt/skillCatalog.js';
import type { CommandContext } from '../_context.js';

export async function tryHandleUiInfoCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent } = ctx;
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
    case '/help': {
      renderHelp(args[0]?.toLowerCase());
      return true;
    }
  }
  return false;
}
