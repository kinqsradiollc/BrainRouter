/**
 * MC-B6 — `brainrouter tasks suggest`: pure helpers for the suggested-tasks
 * command (invocation gating, list rendering, prompt picking). The command
 * itself stays a thin shell in `entry/tasksCommand.ts`; everything here is
 * side-effect-free and offline-testable.
 */
import type { SuggestedTask, SuggestedTasksResult } from '@kinqs/brainrouter-core/triggers';

const KIND_TAGS: Record<SuggestedTask['kind'], string> = {
  'failing-checks': 'checks',
  'merge-conflict': 'conflict',
  'unresolved-reviews': 'reviews',
  'labeled-issue': 'issue',
};

/** Null when the invocation is well-formed; a user-facing error otherwise. */
export function validateTasksInvocation(action: string, pick?: unknown): string | null {
  if (action !== 'suggest') {
    return `Unknown tasks action "${action}". Usage: brainrouter tasks suggest [--repo owner/name] [--pick <n>] [--json]`;
  }
  if (pick === undefined) return null;
  const n = Number(pick);
  if (!Number.isInteger(n) || n < 1) return 'Usage: --pick <n> takes the 1-based index from the printed list.';
  return null;
}

/**
 * Select the Nth (1-based) suggestion's ready-to-run prompt — the cheap
 * hand-off: `brainrouter run "$(brainrouter tasks suggest --pick 1)"`.
 * Null when the index is out of range.
 */
export function pickSuggestedPrompt(result: SuggestedTasksResult, pick: number): string | null {
  const task = result.tasks[pick - 1];
  return task ? task.suggestedPrompt : null;
}

/** Human list: numbered suggestions, each with its copy-paste prompt. */
export function formatSuggestedTasksList(result: SuggestedTasksResult): string {
  const lines: string[] = [];
  if (result.tasks.length === 0) {
    lines.push(`No suggested tasks — nothing actionable found in ${result.repo || 'the linked repo'}.`);
  } else {
    lines.push(`Suggested tasks in ${result.repo} (${result.tasks.length}):`);
    result.tasks.forEach((task, index) => {
      const tag = KIND_TAGS[task.kind] ?? task.kind;
      lines.push(`  ${index + 1}. [${tag}] ${task.title}${task.url ? `  ${task.url}` : ''}`);
      lines.push(`     prompt: ${task.suggestedPrompt}`);
    });
    lines.push('');
    lines.push('Start one: brainrouter run "$(brainrouter tasks suggest --pick <n>)" — or paste the prompt into a chat.');
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  return lines.join('\n');
}
