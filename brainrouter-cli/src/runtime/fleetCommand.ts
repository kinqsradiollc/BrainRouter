/**
 * HONK-H4 — `brainrouter fleet` command core.
 *
 * Pure, runtime-free helpers (repo parsing, migration-spec building, status
 * formatting) so the command's logic is unit-testable without argv, a process, or
 * a sandbox. The thin argv/daemon shell lives in `index.ts`; the executor wiring
 * (sandboxed `runShell` → `makeRecipeRunBuild` → `makeFleetBuildExecutor`) is built
 * here too but only invoked by the live `drain` action.
 */
import path from 'node:path';
import { hostname } from 'node:os';
import type { FleetMigrationSpec } from '@kinqs/brainrouter-core/fleet';
import type { FleetSummary } from '@kinqs/brainrouter-core/fleet';
import type { FleetLockRecord } from '@kinqs/brainrouter-core/fleet';

/**
 * HONK-H3.3 — args for the brain's `fleet_snapshot_put` tool. The brain stores
 * the snapshot per (tenant, host) so the dashboard console can read it back.
 */
export function fleetSnapshotPushArgs(summary: FleetSummary, host: string = hostname()): {
  host: string;
  snapshot: FleetSummary;
  jobCount: number;
} {
  return { host, snapshot: summary, jobCount: summary.total };
}

/** Split a `--repos a,b,c` value into absolute repo roots (resolved against cwd). */
export function parseRepoList(raw: string | undefined, cwd: string): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r.length > 0)
        .map((r) => path.resolve(cwd, r)),
    ),
  ];
}

export interface FleetRunArgs {
  repos: string[];
  command: string;
  slug?: string;
  base?: string;
  title?: string;
}

/** Build the migration spec for `enqueueFleetMigration` from parsed run args. */
export function buildMigrationSpec(args: FleetRunArgs): FleetMigrationSpec {
  const slug = args.slug?.trim() || undefined;
  return {
    kind: 'build',
    repos: args.repos,
    input: {
      command: args.command,
      ...(slug ? { slug } : {}),
      ...(args.base?.trim() ? { baseBranch: args.base.trim() } : {}),
      ...(args.title?.trim() ? { title: args.title.trim() } : {}),
    },
    // A slug makes the migration idempotent per repo (re-running won't duplicate).
    idempotencyKey: slug,
  };
}

/** Validate run args, returning the first human-readable error or null. */
export function validateRunArgs(args: { repos: string[]; command?: string }): string | null {
  if (!args.command || !args.command.trim()) return 'A recipe is required: --command "<shell command>".';
  if (args.repos.length === 0) return 'At least one repo is required: --repos <path[,path...]>.';
  return null;
}

/** Human-readable fleet status block. */
export function formatFleetStatus(summary: FleetSummary, lock: FleetLockRecord | null): string {
  const s = summary.byStatus;
  const lines: string[] = [];
  lines.push(`Fleet queue — ${summary.total} job${summary.total === 1 ? '' : 's'}`);
  lines.push(
    `  pending ${s.pending}   running ${s.running}   done ${s.done}   failed ${s.failed}   cancelled ${s.cancelled}`,
  );
  lines.push(lock ? `  runner: pid ${lock.pid} on ${lock.host} (since ${lock.acquiredAt})` : '  runner: none active');
  if (summary.running.length) {
    lines.push('  in flight:');
    for (const j of summary.running) lines.push(`    ${j.id}  ${j.workspaceRoot}`);
  }
  if (summary.recent.length) {
    lines.push('  recent:');
    for (const j of summary.recent) {
      const pr = (j.output as { prUrl?: string } | undefined)?.prUrl;
      lines.push(`    ${j.status.padEnd(9)} ${j.id}  ${j.workspaceRoot}${pr ? `  → ${pr}` : ''}`);
    }
  }
  return lines.join('\n');
}
