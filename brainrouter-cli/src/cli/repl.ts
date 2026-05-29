import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import type { Agent } from '../agent/agent.js';
import type { McpClientPool as McpClientWrapper } from '../runtime/mcpPool.js';
import type { Config } from '../config/config.js';
import type { ReplContext } from './commands/_context.js';
// Category dispatch — extracted slash-command handlers. Each module exports
// a tryHandleX(ctx) that returns true iff it matched the command. Walked
// in order; first match wins, no match falls through to the legacy switch.
import { tryHandleMemoryCommand } from './commands/memory.js';
import { tryHandleUiCommand } from './commands/ui.js';
import { tryHandleWorkflowCommand } from './commands/workflow.js';
import { tryHandleObsCommand } from './commands/obs.js';
import { tryHandleBrainCommand } from './commands/brain.js';
import { tryHandleOrchestrationCommand } from './commands/orchestration.js';
import { tryHandleSessionCommand } from './commands/session.js';
import { tryHandleGuardCommand } from './commands/guard.js';
import { tryHandleMcpCommand } from './commands/mcp.js';
import { tryHandleInitCommand } from './commands/init.js';
import { tryHandleConfigCommand } from './commands/config.js';
import { tryHandleLoginCommand } from './commands/login.js';
import { tryHandleScheduleCommand } from './commands/schedule.js';
import { tryHandleReleaseNotesCommand } from './commands/releaseNotes.js';

/**
 * All slash commands the REPL recognizes. Used for tab autocomplete and for
 * the readline completer. Keep alphabetically grouped roughly by surface area.
 *
 * The Ink chat REPL (cli/ink/runChat.tsx) consumes this same list for its
 * inline slash palette so both surfaces stay in lockstep as new commands land.
 */
export const SLASH_COMMANDS = [
  '/help', '/status', '/workspace', '/where', '/tools', '/skills', '/plan', '/transcript',
  '/doctor', '/config', '/diff', '/commit', '/clear', '/compact', '/exit', '/quit',
  '/roles', '/agents', '/agent', '/spawn', '/wait', '/dm', '/broadcast', '/inbox', '/delegation-policy', '/handoff', '/pack', '/workers',
  '/spec', '/feature-dev', '/grill-me', '/review', '/review-auto', '/simplify', '/implement-plan', '/skill', '/workflow', '/workflows', '/approve',
  '/memory', '/recall', '/briefing', '/refresh-memory', '/scenes', '/working', '/forget', '/brain',
  '/init', '/login', '/sessions', '/resume', '/model', '/mcp',
  '/goal', '/copy', '/fork', '/rename', '/permissions', '/hooks', '/hookify', '/loop', '/schedule',
  '/continue', '/auto-review', '/auto-chain', '/vim', '/statusline', '/quiet', '/release-notes',
  '/handover', '/explain', '/trace', '/failed', '/verify', '/audit',
  '/export', '/import', '/persona', '/skill-hints', '/diagnostics',
  '/tokens', '/watch', '/yolo', '/mode', '/review-policy', '/sandbox', '/kill',
  // workflow & ergonomics commands
  '/theme', '/title', '/personality', '/effort', '/tier', '/new', '/side', '/btw', '/raw',
  '/feedback', '/rollout', '/ps', '/stop', '/logout', '/apps', '/plugins',
  '/experimental', '/memories', '/debug-config', '/mention', '/keymap', '/ide',
] as const;

/**
 * Help categories. Data-driven so /help can render an index on small
 * terminals and a focused page on `/help <category>`. The prior
 * implementation was 95 lines of console.log calls that blew past the
 * scrollback on anything under ~50 rows.
 */
interface HelpEntry { cmd: string; desc: string; }
interface HelpCategory { key: string; title: string; entries: HelpEntry[]; }

const HELP_CATEGORIES: HelpCategory[] = [
  {
    key: 'session',
    title: 'Session & State',
    entries: [
      { cmd: '/status', desc: 'Connection status, LLM config, DB stats' },
      { cmd: '/workspace', desc: 'Active workspace and session identity' },
      { cmd: '/where', desc: 'Single-screen view of workspace, workflow, goal, plan, recall, children' },
      { cmd: '/doctor', desc: 'Config, connection, memory extraction health' },
      { cmd: '/config [key] [value]', desc: 'Settings panel; `/config theme dark` to set; `/config raw` for JSON dump' },
      { cmd: '/login', desc: 'In-REPL MCP profile editor (transport → fields → probe → save)' },
      { cmd: '/clear', desc: 'Clear chat history for the active session' },
      { cmd: '/compact', desc: 'LLM-driven compaction of the active session' },
      { cmd: '/new [label]', desc: 'Start a new chat with a fresh session key' },
      { cmd: '/fork [label]', desc: 'Fork this chat into a new session, keep prior context' },
      { cmd: '/rename <label>', desc: 'Rename the current session' },
      { cmd: '/resume <id>', desc: 'Resume a previous session by sessionKey' },
      { cmd: '/sessions', desc: 'List persisted sessions for this workspace' },
      { cmd: '/side <q>  /btw <q>', desc: 'Ephemeral side conversation in a forked session' },
      { cmd: '/init', desc: 'Re-run the onboarding wizard (Theme → Provider → API key → Model → MCP → AGENT.md)' },
      { cmd: '! <command>', desc: 'Shell escape — run a shell command from the composer (sandboxed when cli.sandbox=on)' },
      { cmd: '/exit  /quit', desc: 'Close MCP connection and exit' },
    ],
  },
  {
    key: 'memory',
    title: 'Memory & Recall',
    entries: [
      { cmd: '/memory <query>', desc: 'Search long-term memory (memory_search)' },
      { cmd: '/recall <query>', desc: 'Explicit cognitive recall (no LLM turn)' },
      { cmd: '/briefing', desc: 'Show what was recalled before the most recent turn' },
      { cmd: '/refresh-memory', desc: 'Clear the pinned memory anchor; next turn re-pins a fresh briefing' },
      { cmd: '/scenes', desc: 'List active focus scenes' },
      { cmd: '/working', desc: 'Show the working-memory canvas' },
      { cmd: '/working reset confirm', desc: 'Clear the canvas' },
      { cmd: '/forget <recordId>', desc: 'Archive a memory record by ID' },
      { cmd: '/memories', desc: 'Manage memory pipeline + consolidate to filesystem' },
      { cmd: '/brain [agents]', desc: 'Brain-agent health: per-agent status, 24h success rate, pending jobs' },
      { cmd: '/brain run <agentId>', desc: 'Manually enqueue a brain-agent run' },
      { cmd: '/brain retry <jobId>', desc: 'Re-arm a failed/cancelled brain job' },
      { cmd: '/handover', desc: 'Generate continuation note for next session' },
      { cmd: '/explain <query>', desc: 'Why recall returned what it did' },
      { cmd: '/failed [area]', desc: 'Past failed attempts for a problem area' },
      { cmd: '/verify <id> [status]', desc: 'Re-verify a memory record' },
      { cmd: '/audit', desc: 'Recent memory audit log' },
      { cmd: '/export [path]', desc: 'Dump memory + evidence + ops to JSON' },
      { cmd: '/import <path>', desc: 'Import a BrainRouter memory envelope' },
      { cmd: '/persona', desc: 'Show active Core Identity; subcommands: refresh, on, off, <name>' },
      { cmd: '/skill-hints <skill> <hints>', desc: 'Register extraction hints' },
      { cmd: '/diagnostics', desc: 'Scrubbed runtime + DB stats bundle' },
    ],
  },
  {
    key: 'workflow',
    title: 'Workflows & Skills',
    entries: [
      { cmd: '/spec <title>', desc: 'Produce spec.md (spec-driven-skill)' },
      { cmd: '/feature-dev <feat>', desc: 'Multi-agent feature dev with spec + tasks' },
      { cmd: '/grill-me [--force] <task>', desc: 'Clarify 2–5 questions before implementing (CLARIFY mode)' },
      { cmd: '/review [scope] [--fix]', desc: 'Multi-agent code review → review.md; --fix applies + verifies surviving fixes' },
      { cmd: '/simplify [scope] [--dry-run]', desc: 'Behavior-preserving code-simplification pass; --dry-run proposes only' },
      { cmd: '/implement-plan', desc: 'Execute next plan item; append walkthrough' },
      { cmd: '/approve [slug]', desc: 'Approve workflow + kick off implementation' },
      { cmd: '/workflows', desc: 'List durable workflow folders' },
      { cmd: '/workflow switch <slug>', desc: 'Refocus on an existing workflow (migrates any session goal into the target)' },
      { cmd: '/workflow pause', desc: 'Pause the current workflow\'s goal' },
      { cmd: '/workflow resume <slug>', desc: 'Switch to <slug> AND resume its goal in one shot' },
      { cmd: '/skill <name> [input]', desc: 'Run any catalogued skill' },
      { cmd: '/skills', desc: 'List installed BrainRouter skills' },
      { cmd: '/plan  /plan clear', desc: 'Show the durable CLI task plan; clear it (drops stale items)' },
      { cmd: '/tools', desc: 'List local + MCP tools available to the agent' },
      { cmd: '/goal [text|clear|complete|pause|resume|budget <n>]', desc: 'Sticky goal' },
      { cmd: '/continue', desc: 'Resume after a loop-limit abort' },
      { cmd: '/loop <interval> <prompt>  /loop stop', desc: 'Repeat a prompt on cadence' },
      { cmd: '/commit', desc: 'Generate message, stage, and git commit' },
      { cmd: '/diff', desc: 'Show git changes (stream-paginated)' },
    ],
  },
  {
    key: 'orchestration',
    title: 'Multi-Agent Orchestration',
    entries: [
      { cmd: '/roles', desc: 'List available agent roles' },
      { cmd: '/agents [--json]', desc: 'List local child-agent sessions in this CLI.' },
      { cmd: '/agents --remote [--watch] [--usage] [--include-stale] [--json]', desc: 'List federated peer CLIs / hosts attached to the same brain (0.4.0 Stage 2).' },
      { cmd: '/dm <sessionKey> <message>', desc: 'Send text to one federated peer; recipient sees a banner above their next prompt (0.4.0 Stage 3).' },
      { cmd: '/broadcast [<clientKind>:*] <message>', desc: 'Send text to every active peer under your userId, or narrow to one clientKind.' },
      { cmd: '/inbox [--peek] [--all]', desc: 'Read this session’s inbox on demand; marks messages delivered unless --peek (0.4.0 Stage 3).' },
      { cmd: '/handoff <target|<kind>:next-idle> [note]', desc: 'Hand your current goal + context to another session (0.4.1 Stage 4).' },
      { cmd: '/handoff list | accept [fromPrefix]', desc: 'List / adopt an inbound goal handoff.' },
      { cmd: '/agent <id> [--full]', desc: 'Detail + recent transcript of a child' },
      { cmd: '/spawn <role> <prompt>', desc: 'Spawn a child agent' },
      { cmd: '/wait <id> [ms]', desc: 'Wait for a child to finish' },
      { cmd: '/kill <agent-id>', desc: 'Stop a running child' },
      { cmd: '/auto-review [on|off]', desc: 'Auto-run reviewer after every worker (alias for /auto-chain review|off)' },
      { cmd: '/auto-chain [review|verify|both|off]', desc: 'Auto-chain review/verify follow-ups after every worker' },
      { cmd: '/delegation-policy [auto|ask-before-spawn|ask-before-write-child|no-children]', desc: 'Gate whether/when the agent may spawn child agents' },
      { cmd: '/ps', desc: 'List background tasks (loop + running children)' },
      { cmd: '/stop', desc: 'Stop the running loop, mark stale children' },
    ],
  },
  {
    key: 'guard',
    title: 'Guardrails & Permissions',
    entries: [
      { cmd: '/permissions [read|write|shell]', desc: 'View or set agent access mode' },
      { cmd: '/mode [planning|fast]', desc: 'Session execution stance (planning asks, fast skips per-call y/N for safe commands)' },
      { cmd: '/review-policy [request|proceed]', desc: 'How the agent treats multi-file approval gates' },
      { cmd: '/yolo [on|off]', desc: 'Alias for `/mode fast` + `/review-policy proceed`' },
      { cmd: '/sandbox [status|add-read|add-write|remove|clear]', desc: 'Sandbox grants' },
      { cmd: '/hooks [list|add|remove|enable|disable]', desc: 'Lifecycle shell hooks' },
      { cmd: '/hookify [list|create|enable|disable|remove]', desc: 'Markdown rule guards' },
      { cmd: '/logout', desc: 'Clear API keys from the active profile' },
    ],
  },
  {
    key: 'obs',
    title: 'Observability',
    entries: [
      { cmd: '/tokens', desc: 'Session token usage + memory-savings estimate' },
      { cmd: '/watch', desc: 'Tail trace log (BRAINROUTER_TRACE_LOG required)' },
      { cmd: '/trace save <desc>  /trace search <q>', desc: 'Debug-trace store' },
      { cmd: '/transcript [main|sessionKey]', desc: 'Recent persisted transcript' },
      { cmd: '/rollout', desc: 'Print the transcript file path' },
      { cmd: '/debug-config', desc: 'Show config layers, env, preferences' },
    ],
  },
  {
    key: 'ui',
    title: 'UI & Ergonomics',
    entries: [
      { cmd: '/theme [auto|light|dark|mono]', desc: 'Markdown output theme' },
      { cmd: '/title <segments>', desc: 'Terminal title (model,session,branch,mode)' },
      { cmd: '/statusline <segments>', desc: 'Prompt (mode,exec,effort,branch,dirty,model,tokens,session,pr,workflow,goal,plan)' },
      { cmd: '/personality <style>', desc: 'concise | standard | detailed | pair-programmer' },
      { cmd: '/effort [low|medium|high|xhigh]', desc: 'Reasoning depth: low=terse, medium=default, high=step-by-step, xhigh=maximum (hardest tasks)' },
      { cmd: '/model [name] [--session]', desc: 'Switch model; --session = this session only (not saved). cli.fallbackModel auto-swaps on model-not-found.' },
      { cmd: '/raw [on|off]', desc: 'Toggle raw scrollback' },
      { cmd: '/quiet [on|off]', desc: 'Hide recall tables, previews, briefings (model prose only)' },
      { cmd: '/vim', desc: 'Toggle vi-mode for the composer' },
      { cmd: '/keymap [json]', desc: 'Show built-in bindings and set overrides' },
      { cmd: '/copy', desc: 'Copy last assistant response to clipboard' },
      { cmd: '/mention [partial]', desc: 'Suggest files for @ mentions' },
      { cmd: '/model <name>', desc: 'Switch the LLM model in-session' },
      { cmd: '/mcp [list|reconnect|tools]', desc: 'MCP profiles, identity tags, online/offline status, reconnect, tool namespaces' },
      { cmd: '/ide', desc: 'Show detected IDE host' },
      { cmd: '/apps  /plugins', desc: 'List workspace skills and plugin folders' },
      { cmd: '/feedback [message]', desc: 'Append feedback entry' },
      { cmd: '/experimental [on|off]', desc: 'Toggle experimental features' },
      { cmd: '/release-notes [version|list]', desc: 'Show changelog for current (or specified) CLI version' },
    ],
  },
];

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
  // Category dispatch — each extracted module returns true iff it matched
  // the command. New categories should be added here as they're extracted
  // from the giant switch below. Long-term goal: shrink the switch to
  // nothing so this dispatch is the only entrypoint.
  const cmdCtx = { command, args, agent, mcpClient, config, rl, repl: ctx };
  // 0.3.7 wizard / config / login dispatchers run first so they shadow
  // the legacy /init + /config handlers in ui.ts (which still ship
  // their old behaviour as fallbacks but are now superseded).
  if (await tryHandleInitCommand(cmdCtx)) return;
  if (await tryHandleConfigCommand(cmdCtx)) return;
  if (await tryHandleLoginCommand(cmdCtx)) return;
  if (await tryHandleMemoryCommand(cmdCtx)) return;
  if (await tryHandleUiCommand(cmdCtx)) return;
  if (await tryHandleWorkflowCommand(cmdCtx)) return;
  if (await tryHandleScheduleCommand(cmdCtx)) return;
  if (await tryHandleReleaseNotesCommand(cmdCtx)) return;
  if (await tryHandleObsCommand(cmdCtx)) return;
  if (await tryHandleBrainCommand(cmdCtx)) return;
  if (await tryHandleOrchestrationCommand(cmdCtx)) return;
  if (await tryHandleSessionCommand(cmdCtx)) return;
  if (await tryHandleGuardCommand(cmdCtx)) return;
  if (await tryHandleMcpCommand(cmdCtx)) return;

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
