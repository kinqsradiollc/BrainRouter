/**
 * USAGE-HISTORY (WS10) — a persistent, cross-session usage tally bucketed by UTC
 * day, stored at `~/.brainrouter/usage-history.json`. Unlike `agent.sessionUsage`
 * (in-memory, one session) this is durable and INDEPENDENT of any session
 * transcript, so the totals survive session delete/archive — the basis for a
 * GitHub-contributions-style heatmap of tokens / requests / turns over a range.
 *
 * Pure-ish: every entry point takes the clock (`nowMs`) explicitly so the daily
 * bucketing is deterministic + unit-testable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getBrainrouterHome } from '../storage/store.js';

export interface DailyUsage {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  turns: number;
  /** §5.6 — prompt-cache reuse, for cross-session token-ROI. Absent on
   *  pre-0.4.16 records, so readers treat a missing value as 0. */
  cachedTokens: number;
  missedTokens: number;
}

type Store = Record<string, DailyUsage>;

function storePath(): string {
  return path.join(getBrainrouterHome(), 'usage-history.json');
}

function read(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf-8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as Store) : {};
  } catch {
    return {};
  }
}

function write(s: Store): void {
  try {
    const p = storePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf-8');
  } catch {
    /* best-effort — usage history is observability, never block a turn on it */
  }
}

/** UTC day key (`YYYY-MM-DD`) for an epoch-ms timestamp. */
export function dayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

const ZERO = (day: string): DailyUsage => ({
  day, promptTokens: 0, completionTokens: 0, calls: 0, turns: 0, cachedTokens: 0, missedTokens: 0,
});

/** Record ONE turn's usage into today's bucket (adds a turn). Durable + session-
 *  independent, so it survives a later session delete/archive. */
export function recordDailyUsage(
  usage: { promptTokens?: number; completionTokens?: number; calls?: number; cachedTokens?: number; missedTokens?: number },
  nowMs: number,
): void {
  const day = dayKey(nowMs);
  const s = read();
  const b = s[day] ?? ZERO(day);
  b.promptTokens += usage.promptTokens ?? 0;
  b.completionTokens += usage.completionTokens ?? 0;
  b.calls += usage.calls ?? 0;
  b.turns += 1;
  // `?? 0` on the bucket too: a pre-0.4.16 record on disk has no cache fields.
  b.cachedTokens = (b.cachedTokens ?? 0) + (usage.cachedTokens ?? 0);
  b.missedTokens = (b.missedTokens ?? 0) + (usage.missedTokens ?? 0);
  s[day] = b;
  write(s);
}

/** The last `days` daily records, OLDEST→NEWEST, gaps filled with zero days (so a
 *  heatmap can render a continuous grid). */
export function readUsageHistory(days: number, nowMs: number): DailyUsage[] {
  const s = read();
  const n = Math.max(1, Math.floor(days));
  const out: DailyUsage[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = dayKey(nowMs - i * 86_400_000);
    out.push(s[day] ?? ZERO(day));
  }
  return out;
}

/** Pure: totals over a set of daily records. Cache fields default to 0 for any
 *  legacy record that predates them. */
export function totalUsage(records: DailyUsage[]): { promptTokens: number; completionTokens: number; calls: number; turns: number; cachedTokens: number; missedTokens: number } {
  return records.reduce(
    (a, r) => ({
      promptTokens: a.promptTokens + r.promptTokens,
      completionTokens: a.completionTokens + r.completionTokens,
      calls: a.calls + r.calls,
      turns: a.turns + r.turns,
      cachedTokens: a.cachedTokens + (r.cachedTokens ?? 0),
      missedTokens: a.missedTokens + (r.missedTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0, calls: 0, turns: 0, cachedTokens: 0, missedTokens: 0 },
  );
}
