/**
 * Shared helpers for the orchestration slash-command handlers.
 *
 * Extracted from the former orchestration/index.ts god file so the
 * per-domain handler modules (workers/agents/spawn/federation/policy/
 * background) can reuse them without an import cycle back through the
 * thin index barrel.
 */

import chalk from 'chalk';
import { callMcpTool } from '@kinqs/brainrouter-core/mcp';
import { readWorkerMeta, readWorkerSummary, readWorkerTranscript } from '@kinqs/brainrouter-core/worker';
import type { CommandContext } from '../_context.js';
import type { FederationHandle } from '../../../runtime/federation/federationRegistration.js';

export interface DmAddressResolution {
  to: string;
  error?: string;
}

export async function resolveDmAddress(
  mcpClient: CommandContext['mcpClient'],
  target: string,
  federation?: FederationHandle | null,
): Promise<DmAddressResolution> {
  const rawTarget = target.trim();
  if (federation) {
    const resolved = await federation.resolveTarget(rawTarget);
    return resolved.route
      ? { to: resolved.route.sessionKey }
      : { to: rawTarget, error: resolved.error ?? `No active session matched "${rawTarget}".` };
  }
  const res = await callMcpTool<{ sessions: Array<{ sessionKey?: string }> }>(
    mcpClient,
    'session_list',
    { includeStale: true },
  );
  if (res.isError) {
    return {
      to: rawTarget,
      error: `Session discovery failed; no message was queued. Try again when the session list is available.`,
    };
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
  return {
    to: rawTarget,
    error: `No active session matched "${rawTarget}". Refresh /agents --remote and choose an exact key or unique prefix.`,
  };
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
