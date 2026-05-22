import { execSync } from 'node:child_process';
import { getCliStateFile, readJsonFile, writeJsonFile } from './cliState.js';

/**
 * Lifecycle shell hooks, modeled after Claude Code's PreToolUse / PostToolUse /
 * Stop hook surface. A hook is a shell command string that runs at a specific
 * agent-loop point. Non-zero exit codes from `pre-tool` hooks can block the
 * tool call ("approval gate"); other events are informational.
 *
 * Persisted at <workspace>/.brainrouter/cli/hooks.json so they survive CLI
 * restarts and travel with the project.
 */

export type HookEvent =
  | 'pre-tool'    // Fired before a tool runs; non-zero exit denies the call.
  | 'post-tool'   // Fired after a tool returns; informational.
  | 'pre-turn'    // Fired before each LLM turn.
  | 'post-turn'   // Fired after the assistant's final message of a turn.
  | 'session-start'
  | 'session-end';

export interface Hook {
  id: string;
  event: HookEvent;
  command: string;
  match?: string; // Optional substring match on tool name (for pre-tool / post-tool).
  enabled: boolean;
  createdAt: string;
}

interface HooksFile {
  hooks: Hook[];
}

const EMPTY: HooksFile = { hooks: [] };

export function readHooks(workspaceRoot: string): Hook[] {
  return readJsonFile<HooksFile>(getCliStateFile(workspaceRoot, 'hooks.json'), EMPTY).hooks;
}

export function addHook(workspaceRoot: string, input: { event: HookEvent; command: string; match?: string }): Hook {
  const all = readHooks(workspaceRoot);
  const hook: Hook = {
    id: `hook_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    event: input.event,
    command: input.command,
    match: input.match,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  all.push(hook);
  writeJsonFile(getCliStateFile(workspaceRoot, 'hooks.json'), { hooks: all });
  return hook;
}

export function removeHook(workspaceRoot: string, id: string): boolean {
  const all = readHooks(workspaceRoot);
  const filtered = all.filter((h) => h.id !== id);
  if (filtered.length === all.length) return false;
  writeJsonFile(getCliStateFile(workspaceRoot, 'hooks.json'), { hooks: filtered });
  return true;
}

export function setHookEnabled(workspaceRoot: string, id: string, enabled: boolean): boolean {
  const all = readHooks(workspaceRoot);
  const target = all.find((h) => h.id === id);
  if (!target) return false;
  target.enabled = enabled;
  writeJsonFile(getCliStateFile(workspaceRoot, 'hooks.json'), { hooks: all });
  return true;
}

export interface HookRunResult {
  hook: Hook;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run all enabled hooks for the given event. The CLI uses synchronous spawning
 * with a hard timeout — hooks are meant for fast lifecycle taps (lint, notify,
 * log), not long-running work. A `pre-tool` hook returning non-zero blocks the
 * tool call; other events are advisory.
 */
export function runHooks(
  workspaceRoot: string,
  event: HookEvent,
  context: { tool?: string; payload?: Record<string, unknown> } = {},
  timeoutMs = 5000,
): HookRunResult[] {
  const results: HookRunResult[] = [];
  for (const hook of readHooks(workspaceRoot)) {
    if (!hook.enabled || hook.event !== event) continue;
    if (hook.match && context.tool && !context.tool.includes(hook.match)) continue;
    const env = {
      ...process.env,
      BRAINROUTER_HOOK_EVENT: event,
      BRAINROUTER_HOOK_TOOL: context.tool ?? '',
      BRAINROUTER_HOOK_PAYLOAD: context.payload ? JSON.stringify(context.payload) : '',
    };
    try {
      const stdout = execSync(hook.command, { env, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      results.push({ hook, exitCode: 0, stdout, stderr: '' });
    } catch (err: any) {
      results.push({
        hook,
        exitCode: typeof err.status === 'number' ? err.status : 1,
        stdout: typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString?.() ?? ''),
        stderr: typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString?.() ?? err.message ?? ''),
      });
    }
  }
  return results;
}
