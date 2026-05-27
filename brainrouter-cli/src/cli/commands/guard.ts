/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import chalk from 'chalk';
import { applyYoloOff, applyYoloOn, readPreferences, writePreferences } from '../../state/preferencesStore.js';
import { addHook, readHooks, removeHook, setHookEnabled, type HookEvent } from '../../state/hooksStore.js';
import { createHookifyRule, deleteHookifyRule, listHookifyRules, toggleHookifyRule } from '../../state/hookifyStore.js';
import { saveConfig, getCliKnobs } from '../../config/config.js';
import type { CommandContext } from './_context.js';


export async function tryHandleGuardCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, agent, mcpClient, config, rl, repl } = ctx;
  // 'ctx' alias to keep references to the old ReplContext name working
  const replCtx = repl;
  switch (command) {
    case '/permissions':
    {
      const sub = args[0];
      if (!sub) {
        const mode = agent.getAccessMode();
        console.log(chalk.bold(`\nCurrent access mode: ${chalk.cyan(mode)}`));
        console.log(chalk.gray('  read   — list/grep/read/web only. No file writes, no shell.'));
        console.log(chalk.gray('  write  — read + write_file / edit_file / apply_patch. No shell.'));
        console.log(chalk.gray('  shell  — write + run_command (still confirmed in the REPL).'));
        console.log(chalk.gray('\nSwitch with: /permissions read | write | shell  (or use Shift+Tab to cycle)\n'));
        return true;
      }
      if (!['read', 'write', 'shell'].includes(sub)) {
        console.log(chalk.red(`\nUnknown mode "${sub}". Choose: read, write, shell.\n`));
        return true;
      }
      agent.setAccessMode(sub as 'read' | 'write' | 'shell');
      ctx.repl.refreshPromptForMode();
      console.log(chalk.green(`\n✓ Access mode → ${chalk.cyan(sub)}\n`));
      return true;
    }
    case '/hooks':
    {
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
        return true;
      }
      if (sub === 'add') {
        const event = args[1] as HookEvent | undefined;
        const command = args.slice(2).join(' ').trim();
        const validEvents: HookEvent[] = ['pre-turn', 'post-turn', 'pre-tool', 'post-tool', 'session-start', 'session-end'];
        if (!event || !validEvents.includes(event) || !command) {
          console.log(chalk.red(`\nUsage: /hooks add <${validEvents.join('|')}> <shell-command>\n`));
          return true;
        }
        const created = addHook(agent.workspaceRoot, { event, command });
        console.log(chalk.green(`\n✓ Hook added: ${created.id}\n`));
        return true;
      }
      if (sub === 'remove' && args[1]) {
        const ok = removeHook(agent.workspaceRoot, args[1]);
        console.log(ok ? chalk.green(`\n✓ Removed ${args[1]}\n`) : chalk.red(`\nNo hook with id ${args[1]}\n`));
        return true;
      }
      if ((sub === 'enable' || sub === 'disable') && args[1]) {
        const ok = setHookEnabled(agent.workspaceRoot, args[1], sub === 'enable');
        console.log(ok ? chalk.green(`\n✓ ${sub === 'enable' ? 'Enabled' : 'Disabled'} ${args[1]}\n`) : chalk.red(`\nNo hook with id ${args[1]}\n`));
        return true;
      }
      console.log(chalk.red('\nUsage: /hooks [list | add <event> <cmd> | remove <id> | enable <id> | disable <id>]\n'));
      return true;
    }
    case '/mode':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      if (!arg) {
        console.log(chalk.bold(`\nExecution mode: ${chalk.cyan(prefs.executionMode)}`));
        console.log(chalk.gray('  planning  — run_command asks before executing; agent leans toward clarify-before-act. (default)'));
        console.log(chalk.gray('  fast      — run_command auto-approves safe commands (dangerous ones still ask); agent jumps to implementation.'));
        console.log(chalk.gray('  Toggle with: /mode planning  |  /mode fast\n'));
        return true;
      }
      if (arg !== 'planning' && arg !== 'fast') {
        console.log(chalk.red(`\nUnknown mode "${arg}". Choose: planning | fast\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { executionMode: arg as 'planning' | 'fast' });
      agent.refreshSystemPrompt();
      ctx.repl.refreshPromptForMode();
      if (arg === 'fast') {
        console.log(chalk.yellow(`\n✓ /mode fast — run_command auto-approves safe commands.`));
        console.log(chalk.gray('   Dangerous commands (rm -rf, sudo, force-push, …) still prompt for confirmation.'));
        console.log(chalk.gray('   Pair with /permissions write (no shell) or BRAINROUTER_SANDBOX=on for tighter guardrails.\n'));
      } else {
        console.log(chalk.green(`\n✓ /mode planning — run_command asks before each shell call.\n`));
      }
      return true;
    }
    case '/review-policy':
    {
      const prefs = readPreferences(agent.workspaceRoot);
      const arg = (args[0] ?? '').toLowerCase();
      if (!arg) {
        console.log(chalk.bold(`\nReview policy: ${chalk.cyan(prefs.reviewPolicy)}`));
        console.log(chalk.gray('  request  — at workflow/multi-file gates, agent surfaces the plan and waits for /approve. (default)'));
        console.log(chalk.gray('  proceed  — agent applies the plan and reports after; use /approve manually for explicit gates.'));
        console.log(chalk.gray('  Toggle with: /review-policy request  |  /review-policy proceed\n'));
        return true;
      }
      if (arg !== 'request' && arg !== 'proceed') {
        console.log(chalk.red(`\nUnknown policy "${arg}". Choose: request | proceed\n`));
        return true;
      }
      writePreferences(agent.workspaceRoot, { reviewPolicy: arg as 'request' | 'proceed' });
      agent.refreshSystemPrompt();
      if (arg === 'proceed') {
        console.log(chalk.yellow(`\n✓ /review-policy proceed — agent will apply plans without halting for prose approval.`));
        console.log(chalk.gray('   /approve still works as an explicit gesture for workflows that need one.\n'));
      } else {
        console.log(chalk.green(`\n✓ /review-policy request — agent will summarize and ask before applying multi-file changes.\n`));
      }
      return true;
    }
    case '/yolo':
    {
      // /yolo is a one-release alias for `/mode fast` + `/review-policy proceed`.
      // We keep it because the muscle memory is established; new docs point to
      // the two split commands for finer control.
      const arg = (args[0] ?? '').toLowerCase();
      if (!arg) {
        const prefs = readPreferences(agent.workspaceRoot);
        const yoloOn = prefs.executionMode === 'fast' && prefs.reviewPolicy === 'proceed';
        console.log(chalk.bold(`\nYolo (alias): ${yoloOn ? chalk.red('ON') : chalk.green('off')}`));
        console.log(chalk.gray('  Shorthand for `/mode fast` + `/review-policy proceed` — flip both axes at once.'));
        console.log(chalk.gray(`  Current state: mode=${prefs.executionMode}, review-policy=${prefs.reviewPolicy}`));
        console.log(chalk.gray('  Use /mode and /review-policy directly for finer control.'));
        console.log(chalk.gray('  Toggle with: /yolo on  |  /yolo off\n'));
        return true;
      }
      const next = arg === 'on' || arg === 'true' || arg === '1';
      if (next) {
        applyYoloOn(agent.workspaceRoot);
        agent.refreshSystemPrompt();
        ctx.repl.refreshPromptForMode();
        console.log(chalk.red('\n⚠  /yolo ON — shorthand for `/mode fast` + `/review-policy proceed`.'));
        console.log(chalk.gray('   run_command will auto-approve safe commands; dangerous ones still prompt.'));
        console.log(chalk.gray('   Agent will apply multi-file plans without the prose "ready?" pause.'));
        console.log(chalk.gray('   Use /mode and /review-policy for finer control next time.\n'));
      } else {
        applyYoloOff(agent.workspaceRoot);
        agent.refreshSystemPrompt();
        ctx.repl.refreshPromptForMode();
        console.log(chalk.green('\n✓ /yolo off — restored /mode planning + /review-policy request.\n'));
      }
      return true;
    }
    case '/sandbox':
    {
      const sub = (args[0] ?? '').toLowerCase();
      const rest = args.slice(1).join(' ').trim();
      const prefs = readPreferences(agent.workspaceRoot);
      const showState = () => {
        const enabled = getCliKnobs().sandbox === 'on';
        console.log(chalk.bold('\nSandbox'));
        console.log(`  Engine:  ${enabled ? chalk.green('on') : chalk.gray('off')} ${chalk.gray('(cli.sandbox in config.json)')}`);
        console.log(`  Platform: ${chalk.cyan(process.platform)} ${chalk.gray(process.platform === 'darwin' ? '(sandbox-exec)' : process.platform === 'linux' ? '(bwrap/firejail)' : '(unsupported — run_command runs unsandboxed)')}`);
        console.log(`  Workspace (always rw): ${chalk.blue(agent.workspaceRoot)}`);
        console.log(chalk.bold('  Read-only grants:'));
        if (prefs.sandboxReadPaths.length === 0) console.log(chalk.gray('    (none)'));
        else for (const p of prefs.sandboxReadPaths) console.log(`    ${chalk.cyan(p)}`);
        console.log(chalk.bold('  Write grants (beyond workspace):'));
        if (prefs.sandboxWritePaths.length === 0) console.log(chalk.gray('    (none)'));
        else for (const p of prefs.sandboxWritePaths) console.log(`    ${chalk.cyan(p)}`);
        console.log(chalk.gray('\n  Subcommands:'));
        console.log(chalk.gray('    /sandbox add-read <path>     grant read-only access'));
        console.log(chalk.gray('    /sandbox add-write <path>    grant read+write access'));
        console.log(chalk.gray('    /sandbox remove <path>       drop a grant (matches either list)'));
        console.log(chalk.gray('    /sandbox clear               drop all persisted grants'));
        console.log(chalk.gray('    /sandbox status              show this view\n'));
      };
      if (!sub || sub === 'status') { showState(); break; }
      const resolveGrant = (p: string): string | null => {
        if (!p) return null;
        const abs = path.resolve(agent.workspaceRoot, p);
        if (!fs.existsSync(abs)) {
          console.log(chalk.yellow(`\n⚠  Path does not exist: ${abs}`));
          console.log(chalk.gray('   Granting anyway — create it later or the sandbox will skip the bind.\n'));
        }
        return abs;
      };
      if (sub === 'add-read') {
        const abs = resolveGrant(rest); if (!abs) { console.log(chalk.red('\nUsage: /sandbox add-read <path>\n')); break; }
        const next = Array.from(new Set([...prefs.sandboxReadPaths, abs]));
        writePreferences(agent.workspaceRoot, { sandboxReadPaths: next });
        console.log(chalk.green(`\n✓ Added read grant: ${abs}\n`));
        return true;
      }
      if (sub === 'add-write') {
        const abs = resolveGrant(rest); if (!abs) { console.log(chalk.red('\nUsage: /sandbox add-write <path>\n')); break; }
        const next = Array.from(new Set([...prefs.sandboxWritePaths, abs]));
        writePreferences(agent.workspaceRoot, { sandboxWritePaths: next });
        console.log(chalk.green(`\n✓ Added write grant: ${abs}\n`));
        return true;
      }
      if (sub === 'remove') {
        const abs = resolveGrant(rest); if (!abs) { console.log(chalk.red('\nUsage: /sandbox remove <path>\n')); break; }
        writePreferences(agent.workspaceRoot, {
          sandboxReadPaths: prefs.sandboxReadPaths.filter((p) => p !== abs),
          sandboxWritePaths: prefs.sandboxWritePaths.filter((p) => p !== abs),
        });
        console.log(chalk.green(`\n✓ Removed grant: ${abs}\n`));
        return true;
      }
      if (sub === 'clear') {
        writePreferences(agent.workspaceRoot, { sandboxReadPaths: [], sandboxWritePaths: [] });
        console.log(chalk.green('\n✓ Cleared all persisted sandbox grants.\n'));
        return true;
      }
      console.log(chalk.red(`\nUnknown /sandbox subcommand "${sub}". Run /sandbox for help.\n`));
      return true;
    }
    case '/logout':
    {
      // Remove the API key from the active server profile. The CLI keeps the
      // profile so a future /login can re-attach credentials.
      const profile = config.activeServer;
      const server = config.servers[profile];
      if (!server) {
        console.log(chalk.red(`\nNo active profile to log out of.\n`));
        return true;
      }
      const removed: string[] = [];
      if ((server as any).apiKey) { delete (server as any).apiKey; removed.push('server.apiKey'); }
      if (config.llm?.apiKey) { (config.llm as any).apiKey = ''; removed.push('llm.apiKey'); }
      if (removed.length === 0) {
        console.log(chalk.gray(`\nNo credentials were set on profile "${profile}".\n`));
        return true;
      }
      const { saveConfig } = await import('../../config/config.js');
      saveConfig(config);
      console.log(chalk.green(`\n✓ Cleared ${removed.join(', ')} from profile "${profile}".`));
      console.log(chalk.gray('  Re-attach with /login.\n'));
      return true;
    }
    case '/hookify':
    {
      const sub = args[0];
      if (!sub || sub === 'list') {
        const rules = listHookifyRules(agent.workspaceRoot);
        console.log(chalk.bold('\nHookify rules'));
        if (rules.length === 0) {
          console.log(chalk.yellow('  (none)'));
          console.log(chalk.gray('  Add with: /hookify create <name>|<event>|<pattern>|<action>|<message>'));
          console.log(chalk.gray('    event   = bash | file | prompt | stop | all'));
          console.log(chalk.gray('    action  = warn | block'));
          console.log(chalk.gray('  Rules live as markdown files in ~/.brainrouter/workspaces/<encoded>/hooks/'));
          console.log(chalk.gray('  (legacy <workspace>/.brainrouter/hooks/ files are auto-migrated on first read).\n'));
        } else {
          for (const r of rules) {
            const tag = r.enabled ? chalk.green('●') : chalk.gray('○');
            console.log(`  ${tag} ${chalk.cyan(r.id)} ${chalk.gray(r.event)} → ${chalk.yellow(r.action)}${r.pattern ? chalk.gray(` (pattern: ${r.pattern})`) : ''}`);
            console.log(chalk.gray(`    ${r.message.split('\n')[0].slice(0, 120)}`));
          }
          console.log();
        }
        return true;
      }
      if (sub === 'create') {
        const raw = args.slice(1).join(' ').trim();
        const parts = raw.split('|').map((p) => p.trim());
        if (parts.length < 5) {
          console.log(chalk.red('\nUsage: /hookify create <name>|<event>|<pattern>|<action>|<message>\n'));
          return true;
        }
        try {
          const created = createHookifyRule(agent.workspaceRoot, {
            name: parts[0],
            event: parts[1] as any,
            pattern: parts[2],
            action: (parts[3] as 'warn' | 'block'),
            message: parts.slice(4).join('|'),
          });
          console.log(chalk.green(`\n✓ Created hookify rule ${created.id} at ${path.relative(agent.workspaceRoot, created.sourcePath)}\n`));
        } catch (err: any) {
          console.log(chalk.red(`\nFailed: ${err.message}\n`));
        }
        return true;
      }
      if (sub === 'enable' || sub === 'disable') {
        const id = args[1];
        if (!id) { console.log(chalk.red(`\nUsage: /hookify ${sub} <id>\n`)); break; }
        const ok = toggleHookifyRule(agent.workspaceRoot, id, sub === 'enable');
        console.log(ok ? chalk.green(`\n✓ ${sub === 'enable' ? 'Enabled' : 'Disabled'} ${id}\n`) : chalk.red(`\nNo rule ${id}\n`));
        return true;
      }
      if (sub === 'remove') {
        const id = args[1];
        if (!id) { console.log(chalk.red(`\nUsage: /hookify remove <id>\n`)); break; }
        const ok = deleteHookifyRule(agent.workspaceRoot, id);
        console.log(ok ? chalk.green(`\n✓ Removed ${id}\n`) : chalk.red(`\nNo rule ${id}\n`));
        return true;
      }
      console.log(chalk.red('\nUsage: /hookify [list | create <spec> | enable <id> | disable <id> | remove <id>]\n'));
      return true;
    }
  }
  return false;
}
