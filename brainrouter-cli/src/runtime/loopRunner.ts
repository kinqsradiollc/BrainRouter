/**
 * Lightweight repeating-prompt runner for `/loop`.
 *
 * Only one loop runs at a time per CLI process. Callers register a function
 * to invoke on each tick; the runner schedules with setTimeout (not
 * setInterval) so a long-running iteration doesn't pile up. Tick errors are
 * captured but don't kill the loop; that's the point of a loop.
 */

export interface LoopState {
  prompt: string;
  intervalMs: number;
  startedAt: string;
  iterations: number;
  lastFiredAt?: string;
  lastError?: string;
}

let active: { state: LoopState; cancel: () => void } | null = null;

export function isLoopRunning(): boolean {
  return active !== null;
}

export function getLoopState(): LoopState | null {
  return active?.state ?? null;
}

export function startLoop(
  prompt: string,
  intervalMs: number,
  tick: (state: LoopState) => Promise<void>,
): { started: boolean; reason?: string } {
  if (active) {
    return { started: false, reason: 'a loop is already running — use /loop stop first' };
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
    return { started: false, reason: 'interval must be at least 1000ms' };
  }
  const state: LoopState = {
    prompt,
    intervalMs,
    startedAt: new Date().toISOString(),
    iterations: 0,
  };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      state.iterations += 1;
      state.lastFiredAt = new Date().toISOString();
      try {
        await tick(state);
        state.lastError = undefined;
      } catch (err: any) {
        state.lastError = err?.message ?? String(err);
      }
      scheduleNext();
    }, state.intervalMs);
  };

  active = {
    state,
    cancel: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      active = null;
    },
  };
  scheduleNext();
  return { started: true };
}

export function stopLoop(): boolean {
  if (!active) return false;
  active.cancel();
  return true;
}

/** Parse a duration like "5s", "10m", "1h". Returns ms or undefined. */
export function parseInterval(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(raw.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (match[2] ?? 's').toLowerCase();
  const mul = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return Math.round(n * mul);
}
