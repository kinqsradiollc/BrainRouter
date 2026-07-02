/**
 * Shared helpers for the orchestration slash-command handlers.
 *
 * Extracted from cli/commands/orchestration.ts as part of the god-file
 * breakdown. These free functions are used by more than one per-domain
 * handler (resolveDmAddress by /dm; renderWorkerSnapshot by /workers and
 * /fg), so they live here to avoid an import cycle between siblings.
 */

import chalk from 'chalk';
import { callMcpTool } from '@kinqs/brainrouter-core/mcp';
import { readWorkerMeta, readWorkerSummary, readWorkerTranscript } from '@kinqs/brainrouter-core/worker';
import type { CommandContext } from '../_context.js';

export interface DmAddressResolution {
  to: string;
  error?: string;
}

export function isLikelyFullSessionKey(target: string): boolean {
  return target.length >= 32 || target.includes(':child:');
}

export async function resolveDmAddress(mcpClient: CommandContext['mcpClient'], target: string): Promise<DmAddressResolution> {
  const rawTarget = target.trim();
  const res = await callMcpTool<{ sessions: Array<{ sessionKey?: string }> }>(
    mcpClient,
    'session_list',
    { includeStale: true },
  );
  if (res.isError) {
    return { to: rawTarget };
  }

  const sessionKeys = (res.parsed?.sessions ?? [])
    .map((s) => s.sessionKey)
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
  const exact = sessionKeys.find((key) => key === rawTarget);
  if (exact) return { to: exact };

  const matches = sessionKeys.filter((key) => key.startsWith(rawTarget));
  if (matches.length === 1) return { to: matches[0] };
  if (matches.length > 1) {
    const prefixes = matches.map((key) => key.slice(0, 12)).join(', ');
    return {
      to: rawTarget,
      error: `Ambiguous session prefix "${rawTarget}" matched ${matches.length} sessions (${prefixes}). Use more characters.`,
    };
  }
  if (!isLikelyFullSessionKey(rawTarget)) {
    return {
      to: rawTarget,
      error: `No active or recently-seen session matched prefix "${rawTarget}". Use /agents --remote to copy a session prefix.`,
    };
  }
  return { to: rawTarget };
}

/**
 * CLI-BG-DETACH — render a point-in-time snapshot of a worker (status + recent
 * transcript + summary). Shared by `/workers attach <id>` and `/fg <id>`.
 * Workers run detached + persist to disk, so this is a read, not a live stream;
 * re-run to refresh.
 */
export function renderWorkerSnapshot(ws: string, id: string): boolean {
  const w = readWorkerMeta(ws, id);
  if (!w) return false;
  console.log(chalk.bold(`\nWorker ${chalk.cyan(w.id)} ${chalk.gray(`(${w.role})`)} — ${w.status}`));
  console.log(chalk.gray(`  goal: ${w.goal}`));
  const entries = readWorkerTranscript(ws, w.id, 12) as Array<Record<string, any>>;
  if (entries.length) {
    console.log(chalk.gray('  --- recent transcript ---'));
    for (const e of entries) {
      const tag = e.event ? `${e.role}/${e.event}` : e.role;
      const body = e.tool ? `${e.tool}${e.summary ? `: ${String(e.summary).slice(0, 80)}` : ''}` : String(e.content ?? e.error ?? '').slice(0, 120);
      console.log(`  ${chalk.gray(tag)} ${body}`);
    }
  }
  const summary = readWorkerSummary(ws, w.id);
  if (summary) console.log(chalk.gray('\n  --- summary.md ---\n') + summary.slice(0, 1200));
  console.log(chalk.gray('\n  (snapshot — re-run to refresh; workers run in the background)\n'));
  return true;
}
