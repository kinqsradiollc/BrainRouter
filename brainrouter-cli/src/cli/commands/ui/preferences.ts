/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 *
 * Preference-toggle UI commands split out of ui/index.ts:
 *   /vim /statusline /theme /title /personality /raw /quiet /experimental /keymap
 */

import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { setCliKnobOverride } from '@kinqs/brainrouter-core/config';
import { readPreferences, writePreferences } from '@kinqs/brainrouter-core/session';
import type { CommandContext } from '../_context.js';

export async function tryHandleUiPreferencesCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent } = ctx;
  switch (command) {
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
      const { SEGMENT_NAMES, isKnownSegment } = await import('../../statusline.js');
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
            else if (seg === 'session') parts.push(agent.sessionKey);
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
      // `--quiet` set a one-shot knob override at startup; once the user
      // explicitly toggles in-session their choice wins from now on.
      setCliKnobOverride({ quiet: next });
      const detail = next
        ? 'recall tables, briefing dumps, and tool-completion previews are now hidden.'
        : 'full chrome restored — recall tables, previews, and briefings will print again.';
      console.log(chalk.green(`\n✓ Quiet mode ${next ? 'enabled' : 'disabled'}: ${detail}\n`));
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
  }
  return false;
}
