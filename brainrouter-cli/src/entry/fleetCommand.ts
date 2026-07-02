import type { Command } from 'commander';
import chalk from 'chalk';
import { pushFleetSnapshotToBrain } from './shared.js';

export function registerFleetCommand(program: Command): void {
  program
    .command('fleet [action]')
    .description('Background multi-repo migrations: run | status | drain | push (a recipe → one PR per repo)')
    .option('--repos <paths>', 'Comma-separated repo roots (run)')
    .option('--command <cmd>', 'Recipe shell command run in each repo, sandboxed (run)')
    .option('--slug <slug>', 'Migration slug — branch/PR seed + per-repo idempotency key (run)')
    .option('--base <branch>', 'Base branch for the PRs (run)')
    .option('--title <title>', 'PR title override (run)')
    .option('--capacity <n>', 'Max concurrent jobs (drain); default cli.fleetMaxConcurrentJobs')
    .option('--once', 'Drain a single pass and exit (drain)')
    .option('--push', 'Push the snapshot to the brain for the dashboard console (drain)')
    .option('--json', 'Machine-readable output')
    .action(async (action, options) => {
      const { parseRepoList, buildMigrationSpec, validateRunArgs, formatFleetStatus } = await import('../runtime/fleetCommand.js');
      const fleet = await import('@kinqs/brainrouter-core/fleet');
      const act = String(action ?? 'status').toLowerCase();

      if (act === 'run') {
        const repos = parseRepoList(options.repos, process.cwd());
        const err = validateRunArgs({ repos, command: options.command });
        if (err) { console.error(chalk.red(err)); process.exitCode = 1; return; }
        const spec = buildMigrationSpec({ repos, command: options.command, slug: options.slug, base: options.base, title: options.title });
        const { jobs, deduped } = fleet.enqueueFleetMigration(spec);
        if (options.json) {
          process.stdout.write(JSON.stringify({ enqueued: jobs.map((j) => ({ id: j.id, workspaceRoot: j.workspaceRoot })), deduped }) + '\n');
          return;
        }
        console.log(chalk.green(`Enqueued ${jobs.length} fleet job(s)${deduped ? ` (${deduped} already in-flight)` : ''}:`));
        for (const j of jobs) console.log(`  ${chalk.cyan(j.id)}  ${j.workspaceRoot}`);
        console.log(chalk.gray('Drain them with:  brainrouter fleet drain'));
        return;
      }

      if (act === 'status') {
        const summary = fleet.summarizeFleet();
        const lock = fleet.readFleetLock();
        if (options.json) { process.stdout.write(JSON.stringify({ summary, lock }) + '\n'); return; }
        console.log(formatFleetStatus(summary, lock));
        return;
      }

      if (act === 'push') {
        // One-shot: push the current snapshot to the brain (for the dashboard console).
        const res = await pushFleetSnapshotToBrain(fleet.summarizeFleet());
        if (options.json) { process.stdout.write(JSON.stringify(res) + '\n'); return; }
        console.log(res.ok ? chalk.green('Pushed fleet snapshot to the brain.') : chalk.yellow(`Snapshot push skipped: ${res.error}`));
        if (!res.ok) process.exitCode = 1;
        return;
      }

      if (act === 'drain') {
        const { getCliKnobs } = await import('@kinqs/brainrouter-core/config');
        const cap = options.capacity != null ? Math.max(0, parseInt(String(options.capacity), 10) || 0) : getCliKnobs().fleetMaxConcurrentJobs;
        // Sandboxed recipe runner — unattended fleet work must be confined (HONK-H0).
        const runCommand = async (command: string, cwd: string) => {
          const exec = await import('@kinqs/brainrouter-core/exec');
          const cfg = exec.resolveSandboxConfig(cwd, undefined, { forceEnforce: true, scopeSecrets: true });
          const r = await exec.runShell(command, cfg, 120_000);
          return { ok: r.exitCode === 0 && !r.refused, stdout: r.stdout, stderr: r.stderr };
        };
        const executor = fleet.makeFleetBuildExecutor({ runBuild: fleet.makeRecipeRunBuild({ runCommand }) });
        const runner = new fleet.FleetJobRunner({ capacity: cap, executors: { build: executor } });
        const started = runner.start();
        if (!started.acquired) {
          console.error(chalk.yellow('Another fleet runner already owns this host — standing down.'));
          process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`Fleet runner started (capacity ${cap}, reconciled ${started.reconciled}).`));
        // HONK-H3.3 — when --push, periodically post the snapshot to the brain so the
        // dashboard console reflects this host live (best-effort; never blocks drain).
        const pushOnce = async () => {
          if (!options.push) return;
          const res = await pushFleetSnapshotToBrain(fleet.summarizeFleet());
          if (!res.ok) console.error(chalk.gray(`(snapshot push skipped: ${res.error})`));
        };
        if (options.once) {
          await runner.tick();
          const deadline = Date.now() + 30 * 60_000;
          while (runner.activeCount > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
          runner.stop();
          await pushOnce();
          console.log(formatFleetStatus(fleet.summarizeFleet(), fleet.readFleetLock()));
          return;
        }
        console.log(chalk.gray(`Draining… press Ctrl-C to stop.${options.push ? ' (pushing snapshots to the brain)' : ''}`));
        await pushOnce();
        const pushTimer = options.push ? setInterval(() => { void pushOnce(); }, 15_000) : undefined;
        if (pushTimer && 'unref' in pushTimer) (pushTimer as { unref: () => void }).unref();
        await new Promise<void>((resolve) => { process.once('SIGINT', () => { if (pushTimer) clearInterval(pushTimer); runner.stop(); resolve(); }); });
        await pushOnce();
        console.log(chalk.gray('Fleet runner stopped.'));
        return;
      }

      console.error(chalk.red(`Unknown fleet action "${act}". Use: run | status | drain | push.`));
      process.exitCode = 1;
    });
}
