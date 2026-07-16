// `brainrouter chat-sync list | push` — mirror a local CLI conversation up to the
// shared chat-threads API so it shows up cross-surface (dashboard/desktop), and
// list the server threads for your account. This is ADDITIVE + OPT-IN: local
// workspace transcripts stay the source of truth and are never modified. Auth
// reuses the active hosted (`http`) profile's bearer, the same as `brainrouter github`.
import type { Command } from 'commander';
import chalk from 'chalk';
import { setCliKnobOverride } from '@kinqs/brainrouter-core/config';
import { applyWorkspaceRoot, findWorkspaceRoot } from '@kinqs/brainrouter-core/workspace';
import { listTranscripts } from '@kinqs/brainrouter-core/session';
import { pickResumeSession } from '../state/resumePicker.js';
import {
  listServerThreads,
  pushSessionToServer,
  resolveChatSyncTarget,
  type ChatSyncTarget,
  type ServerChatThread,
} from '../runtime/chatSync/chatSyncClient.js';

/** Resolve the account target or print the signed-out message and exit 0 (never crash). */
function requireTarget(): ChatSyncTarget | null {
  const target = resolveChatSyncTarget();
  if ('error' in target) {
    console.log(chalk.yellow(target.error));
    // Signed-out is a normal state, not a failure — leave the exit code at 0.
    return null;
  }
  return target;
}

function formatThreadList(threads: ServerChatThread[]): string {
  if (threads.length === 0) return 'No server chat threads yet.\n';
  const lines = [`Server chat threads (${threads.length}):`];
  for (const t of threads) {
    const when = t.updatedAt ? t.updatedAt.slice(0, 19).replace('T', ' ') : '';
    lines.push(`  ${t.id}  ${when}  ${t.title}`);
  }
  return lines.join('\n') + '\n';
}

export function registerChatSyncCommand(program: Command): void {
  const cmd = program
    .command('chat-sync')
    .description('Sync local CLI conversations to the shared chat-threads API (cross-surface)')
    .option('-w, --workspace <path>', 'Workspace root override');

  cmd
    .command('list')
    .description('List the chat threads on the server for your account')
    .option('--json', 'Emit a single JSON line')
    .action(async (options) => {
      const parentOptions = cmd.opts();
      if (parentOptions.workspace) setCliKnobOverride({ workspaceOverride: parentOptions.workspace });
      const target = requireTarget();
      if (!target) return;
      try {
        const threads = await listServerThreads(target);
        if (options.json) {
          process.stdout.write(JSON.stringify({ threads }) + '\n');
          return;
        }
        process.stdout.write(formatThreadList(threads));
      } catch (err) {
        console.error(chalk.red(`Could not list server threads: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });

  cmd
    .command('push')
    .description('Push a local session up to a server chat thread (creates or updates)')
    .option('--session <key>', 'Session key (exact or unique prefix); defaults to the most recent session')
    .option('--title <title>', 'Override the thread title')
    .option('--json', 'Emit a single JSON line')
    .action(async (options) => {
      const parentOptions = cmd.opts();
      if (parentOptions.workspace) setCliKnobOverride({ workspaceOverride: parentOptions.workspace });

      // Signed-out short-circuit first, so a missing account key always exits 0
      // regardless of the workspace's session state.
      const target = requireTarget();
      if (!target) return;

      const workspace = findWorkspaceRoot();
      applyWorkspaceRoot(workspace.workspaceRoot);

      const transcripts = listTranscripts(workspace.workspaceRoot);
      const pick = pickResumeSession(transcripts, {
        continueLatest: !options.session,
        resumeKey: typeof options.session === 'string' ? options.session : undefined,
      });
      if (!pick.ok) {
        console.error(chalk.red(pick.error));
        process.exitCode = 1;
        return;
      }

      try {
        const outcome = await pushSessionToServer(target, workspace.workspaceRoot, pick.sessionKey, {
          title: typeof options.title === 'string' ? options.title : undefined,
        });
        if (options.json) {
          process.stdout.write(JSON.stringify({ sessionKey: pick.sessionKey, outcome }) + '\n');
          return;
        }
        if (outcome.status === 'skipped') {
          const why = outcome.reason === 'internal'
            ? 'internal/ephemeral session — nothing to sync'
            : 'no user/assistant messages to sync';
          console.log(chalk.gray(`Skipped ${pick.sessionKey}: ${why}.`));
          return;
        }
        const verb = outcome.created ? 'Created' : 'Updated';
        console.log(chalk.green(`✔ ${verb} thread ${outcome.threadId} — ${outcome.messageCount} message${outcome.messageCount === 1 ? '' : 's'}.`));
        console.log(chalk.gray(`  ${outcome.title}`));
      } catch (err) {
        console.error(chalk.red(`Could not push session: ${err instanceof Error ? err.message : String(err)}`));
        process.exitCode = 1;
      }
    });
}
