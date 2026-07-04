import type { Command } from 'commander';
import chalk from 'chalk';
import { setCliKnobOverride } from '@kinqs/brainrouter-core/config';
import { applyWorkspaceRoot, findWorkspaceRoot } from '@kinqs/brainrouter-core/workspace';
import { childConversationJson, formatChildConversationList } from '../runtime/conversations/conversationsCommand.js';

export function registerConversationsCommand(program: Command): void {
  const cmd = program
    .command('conversations')
    .description('Manage openable child conversations for the current workspace')
    .option('-w, --workspace <path>', 'Workspace root override');

  cmd
    .command('list')
    .description('List child conversations')
    .option('--json', 'Emit a single JSON line')
    .action(async (options) => {
      const parentOptions = cmd.opts();
      if (parentOptions.workspace) setCliKnobOverride({ workspaceOverride: parentOptions.workspace });
      const workspace = findWorkspaceRoot();
      applyWorkspaceRoot(workspace.workspaceRoot);
      const { listChildConversations } = await import('@kinqs/brainrouter-core/session');
      const conversations = listChildConversations(workspace.workspaceRoot);
      process.stdout.write(options.json ? childConversationJson(conversations) : formatChildConversationList(conversations));
    });

  cmd
    .command('create')
    .description('Create an openable child conversation record')
    .requiredOption('--parent-session <key>', 'Parent session key')
    .requiredOption('--runtime <id>', 'Parent runtime id')
    .option('--model <model>', 'Model inherited by the child conversation')
    .option('--repo <repo>', 'Repo slug override')
    .option('--branch <branch>', 'Branch override')
    .option('--title <title>', 'Display title')
    .option('--json', 'Emit a single JSON line')
    .action(async (options) => {
      const parentOptions = cmd.opts();
      if (parentOptions.workspace) setCliKnobOverride({ workspaceOverride: parentOptions.workspace });
      const workspace = findWorkspaceRoot();
      applyWorkspaceRoot(workspace.workspaceRoot);
      const { createChildConversation } = await import('@kinqs/brainrouter-core/session');
      const conversation = createChildConversation(workspace.workspaceRoot, {
        parentSessionKey: options.parentSession,
        parentRuntimeId: options.runtime,
        model: options.model,
        repo: options.repo,
        branch: options.branch,
        title: options.title,
      });
      if (options.json) {
        process.stdout.write(JSON.stringify({ conversation }) + '\n');
        return;
      }
      console.log(chalk.green(`Created child conversation ${conversation.id}`));
      console.log(chalk.gray(`Session: ${conversation.sessionKey}`));
    });

  cmd
    .command('close <id>')
    .description('Close a child conversation')
    .option('--json', 'Emit a single JSON line')
    .action(async (id, options) => {
      const parentOptions = cmd.opts();
      if (parentOptions.workspace) setCliKnobOverride({ workspaceOverride: parentOptions.workspace });
      const workspace = findWorkspaceRoot();
      applyWorkspaceRoot(workspace.workspaceRoot);
      const { closeChildConversation } = await import('@kinqs/brainrouter-core/session');
      const conversation = closeChildConversation(workspace.workspaceRoot, id);
      if (options.json) {
        process.stdout.write(JSON.stringify({ conversation: conversation ?? null }) + '\n');
        return;
      }
      if (!conversation) {
        console.error(chalk.red(`No child conversation found for ${id}`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.gray(`Closed child conversation ${conversation.id}`));
    });
}
