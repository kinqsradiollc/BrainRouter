/**
 * ADR-057 — `suggest_task`: record an out-of-scope follow-up the agent noticed,
 * so it surfaces to the user as a one-click starter instead of derailing the
 * current turn. A deterministic write to the workspace suggestion store; the
 * model gets a one-line confirmation, and the current work is untouched.
 */
import type { BuiltinToolHandler } from './registry.js';
import { addAgentSuggestion } from '../../../triggers/suggestionStore.js';

export const suggestionHandlers: Record<string, BuiltinToolHandler> = {
  suggest_task: async ({ args, host }) => {
    const record = addAgentSuggestion(
      host.workspaceRoot,
      {
        title: String(args.title ?? ''),
        suggestedPrompt: String(args.prompt ?? ''),
        ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
        ...(args.worktree === true ? { worktree: true } : {}),
      },
      host.sessionKey,
    );
    return `Suggested follow-up recorded: “${record.title}”. It is in the desktop's Tasks → Suggestions; the user can start it in a new session${record.worktree ? ' or a worktree' : ''}, or dismiss it. The current work was not changed.`;
  },
};
