import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { Agent } from '@kinqs/brainrouter-core/agent';
import type { McpClientPool as McpClientWrapper } from '@kinqs/brainrouter-core/mcp';
import type { Config } from '@kinqs/brainrouter-core/config';
import type { ReplContext } from '../commands/_context.js';
// ADR-041 A41-7 — the builtin slash-command handlers now live in an ordered,
// walked registry (dispatchRegistry.ts) instead of a hand-written if-chain here.
// Adding a command category is a one-line array insertion there.
import { dispatchBuiltinCommand } from '../commands/dispatchRegistry.js';
import { loadCustomCommands, findCustomCommand, expandCommandBody } from '../../runtime/commands/customCommands.js';

/**
 * All slash commands the REPL recognizes. Used for tab autocomplete and for
 * the readline completer. Keep alphabetically grouped roughly by surface area.
 *
 * The Ink chat REPL (cli/ink/runChat.tsx) consumes this same list for its
 * inline slash palette so both surfaces stay in lockstep as new commands land.
 */
// §ADR-003 — the command catalog moved to core; imported here for the REPL's
// own help renderer AND re-exported so existing CLI importers keep working.
import { SLASH_COMMANDS, HELP_CATEGORIES, type HelpEntry, type HelpCategory } from '@kinqs/brainrouter-core/command';
export { SLASH_COMMANDS, HELP_CATEGORIES, type HelpEntry, type HelpCategory };

export function renderHelp(category?: string): void {
  // Match by key OR by leading char of title (allowing /help m → memory).
  const wantedCategory = category
    ? HELP_CATEGORIES.find((c) => c.key === category || c.title.toLowerCase().startsWith(category))
    : undefined;

  // Special case: show a single category if the user asked for one explicitly.
  if (category && wantedCategory) {
    printHelpCategory(wantedCategory);
    console.log(chalk.gray('\nTry /help to see all categories. Tab autocompletes commands; @ mentions files.\n'));
    return;
  }
  if (category && !wantedCategory) {
    console.log(chalk.red(`\nUnknown help category "${category}". Available:`));
    for (const c of HELP_CATEGORIES) {
      console.log(`  ${chalk.cyan('/help ' + c.key)}  ${chalk.gray(c.title)}`);
    }
    console.log();
    return;
  }

  // No category → decide between full dump and index based on terminal height.
  const totalLines = HELP_CATEGORIES.reduce((n, c) => n + c.entries.length + 2, 0);
  const rows = process.stdout.rows ?? 9999;
  if (rows >= totalLines + 6) {
    // Tall enough — show everything.
    for (const c of HELP_CATEGORIES) printHelpCategory(c);
    console.log(chalk.gray('\nTips: @ mentions files · Tab autocompletes · Shift+Tab cycles access mode (read → write → shell).\n'));
    return;
  }
  // Small terminal — show index + per-category command count.
  console.log(chalk.bold('\nAvailable command categories:'));
  for (const c of HELP_CATEGORIES) {
    console.log(`  ${chalk.cyan('/help ' + c.key.padEnd(14))} ${chalk.gray(`${c.title}  (${c.entries.length} commands)`)}`);
  }
  console.log(chalk.gray('\nYour terminal is short — run /help <category> to drill in. Resize and re-run /help to see all at once.\n'));
}

/**
 * Look up a one-line description for a slash command by walking the
 * help registry. Used to populate the slash-suggest popup. Falls back
 * to a generic placeholder if the command isn't documented (those
 * commands still work — they just won't get a custom description
 * inside the popup until someone adds them to `HELP_CATEGORIES`).
 *
 * Description text in `HELP_CATEGORIES` sometimes carries a parenthesised
 * argument hint (e.g. "/config [key] [value]"); we strip everything
 * after the first space when matching by cmd token so e.g. `/config`
 * matches `cmd: "/config [key] [value]"`.
 */
export function lookupSlashDescription(cmd: string): string {
  for (const cat of HELP_CATEGORIES) {
    for (const entry of cat.entries) {
      const token = entry.cmd.split(/\s+/)[0];
      if (token === cmd) return entry.desc;
    }
  }
  return '(no description)';
}

function printHelpCategory(c: HelpCategory): void {
  console.log(chalk.bold(`\n${c.title}:`));
  // Find max command-column width for alignment.
  const colWidth = Math.min(40, c.entries.reduce((w, e) => Math.max(w, e.cmd.length), 0));
  for (const e of c.entries) {
    console.log(`  ${chalk.cyan(e.cmd.padEnd(colWidth))}  ${chalk.gray(e.desc)}`);
  }
}

export async function handleSlashCommand(
  command: string,
  args: string[],
  agent: Agent,
  mcpClient: McpClientWrapper,
  config: Config,
  rl: readline.Interface,
  ctx: ReplContext,
) {
  // Category dispatch — walk the builtin handler registry first-match-wins. The
  // order (init/config/login first so they shadow the legacy ui.ts fallbacks) is
  // encoded in BUILTIN_COMMAND_HANDLERS; adding a category is an insertion there,
  // not a new branch here.
  const cmdCtx = { command, args, agent, mcpClient, config, rl, repl: ctx };
  if (await dispatchBuiltinCommand(cmdCtx)) return;

  // CC-P4.1 — user-defined markdown slash commands. A file at
  // .brainrouter/commands/<name>.md turns /<name> into a prompt template
  // ($ARGUMENTS / $1..$9 substitution) run as a normal agent turn. Checked
  // AFTER every built-in so a custom file can never shadow a real command.
  const customDef = findCustomCommand(loadCustomCommands(cmdCtx.agent.workspaceRoot), command);
  if (customDef) {
    const prompt = expandCommandBody(customDef.body, cmdCtx.args);
    console.log(chalk.gray(`\n▶ ${command} — ${customDef.description}\n`));
    cmdCtx.repl.runAgentTurn(prompt);
    return;
  }

  // All commands extracted to category files above. Anything that reaches
  // here didn't match any handler.
  console.log(chalk.red(`\nUnknown slash command: ${command}. Type /help for assistance.\n`));
}

/**
 * Tab-completion source for `@path/to/file` mentions. Given a partial workspace
 * path, return the matching files and directories one level deep. Stays inside
 * the workspace and ignores noise dirs to keep the completion list useful.
 */
export function completeWorkspacePath(workspaceRoot: string, partial: string): string[] {
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
