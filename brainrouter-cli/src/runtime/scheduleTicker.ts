/**
 * In-process ticker that fires due `/schedule` jobs.
 *
 * Singleton per CLI process. Wakes every 30s (override via `cli.scheduleTickMs`
 * in `~/.config/brainrouter/config.json`), reloads the persisted store, fires
 * any jobs whose `nextRun` is now in the past, then advances `nextRun`
 * past `now()` so a missed window only fires ONCE (catch-up
 * idempotency).
 *
 * No daemon — the ticker dies with the REPL. Schedules that miss
 * because the CLI was closed are caught on the next REPL boot via the
 * same "advance past now" rule.
 */

import { loadSchedules, recordFire, removeSchedule, setScheduleEnabled, type ScheduleRecord } from '../state/scheduleStore.js';
import { parseCron, nextCronFire } from './cronParser.js';
import { getCliKnobs } from '../config/config.js';

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 100;

export interface ScheduleTickerOptions {
  workspaceRoot: string;
  sessionKey: string;
  /** Called when a schedule is due. Fire-and-forget. */
  fire: (command: string, schedule: ScheduleRecord) => void;
  /** Override the wake interval. Defaults to env or 30 000 ms. */
  intervalMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
  /** Called when a fire is skipped because the expression is unparseable. */
  onError?: (msg: string) => void;
}

export interface ScheduleTickerHandle {
  stop: () => void;
  /** Force one immediate scan (tests + boot catch-up). */
  tickNow: () => void;
}

let active: ScheduleTickerHandle | null = null;

export function isScheduleTickerRunning(): boolean {
  return active !== null;
}

export function startScheduleTicker(opts: ScheduleTickerOptions): ScheduleTickerHandle {
  if (active) return active;

  const cfgOverride = getCliKnobs().scheduleTickMs;
  const rawInterval = opts.intervalMs ?? (Number.isFinite(cfgOverride) && cfgOverride > 0 ? cfgOverride : DEFAULT_INTERVAL_MS);
  const interval = Math.max(MIN_INTERVAL_MS, rawInterval);
  const now = opts.now ?? (() => Date.now());

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const scan = () => {
    if (stopped) return;
    const t = now();
    let schedules: ScheduleRecord[];
    try {
      schedules = loadSchedules(opts.workspaceRoot);
    } catch (err) {
      opts.onError?.(`load failed: ${(err as Error).message}`);
      return;
    }
    for (const s of schedules) {
      if (!s.enabled) continue;
      if (s.owner !== opts.sessionKey) continue;
      const nextMs = Date.parse(s.nextRun);
      if (!Number.isFinite(nextMs) || nextMs > t) continue;

      try {
        opts.fire(s.command, s);
      } catch (err) {
        opts.onError?.(`fire failed for ${s.id}: ${(err as Error).message}`);
      }

      if (s.kind === 'once') {
        removeSchedule(opts.workspaceRoot, s.id);
        continue;
      }

      // Cron: advance nextRun strictly past `t`. parseCron should always
      // succeed (we validated on add), but tolerate corruption by
      // disabling rather than spinning forever on a past nextRun.
      const cron = parseCron(s.expr);
      if (!cron) {
        opts.onError?.(`cron expression invalid; disabling ${s.id}: ${s.expr}`);
        try {
          setScheduleEnabled(opts.workspaceRoot, s.id, false);
        } catch { /* swallow */ }
        continue;
      }
      const next = nextCronFire(cron, new Date(t));
      recordFire(opts.workspaceRoot, s.id, new Date(t), next.toISOString());
    }
  };

  const tick = () => {
    if (stopped) return;
    scan();
    if (stopped) return;
    timer = setTimeout(tick, interval);
  };

  // Defer the first scan to the next macrotask so the caller finishes
  // wiring (e.g. Ink's `onReady`) before any fire callback runs.
  timer = setTimeout(tick, 0);

  active = {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      active = null;
    },
    tickNow: scan,
  };
  return active;
}
