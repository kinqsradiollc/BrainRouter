/**
 * Minimal 5-field cron parser — `minute hour dom month dow`.
 *
 * Vendored intentionally (no node-cron) to keep the dependency surface
 * small and the semantics predictable. Supports `*`, comma lists,
 * ranges (`1-5`), and steps (`15`, `0-30/10`). No seconds, no Quartz
 * extensions, no `@reboot` macros.
 */

export interface CronExpr {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  raw: string;
}

const FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 },  // day of week (0 or 7 = Sunday)
];

function parseField(raw: string, min: number, max: number): Set<number> | undefined {
  if (raw.length === 0) return undefined;
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    if (!part) return undefined;
    let step = 1;
    let range = part;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      const s = Number(part.slice(slash + 1));
      if (!Number.isInteger(s) || s < 1) return undefined;
      step = s;
      range = part.slice(0, slash);
    }
    let lo: number;
    let hi: number;
    if (range === '*' || range === '') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return undefined;
    } else {
      const v = Number(range);
      if (!Number.isInteger(v)) return undefined;
      lo = v;
      hi = v;
    }
    if (lo < min || hi > max || lo > hi) return undefined;
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out.size > 0 ? out : undefined;
}

export function parseCron(expr: string): CronExpr | undefined {
  if (typeof expr !== 'string') return undefined;
  const trimmed = expr.trim();
  if (!trimmed) return undefined;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return undefined;
  const parsed = fields.map((f, i) => parseField(f, FIELD_RANGES[i].min, FIELD_RANGES[i].max));
  if (parsed.some((p) => !p)) return undefined;
  const [minute, hour, dom, month, dowRaw] = parsed as Set<number>[];
  // Normalize dow: 7 → 0 so Sunday has one representation.
  const dow = new Set<number>();
  for (const v of dowRaw) dow.add(v === 7 ? 0 : v);
  return { minute, hour, dom, month, dow, raw: trimmed };
}

/**
 * First firing instant strictly AFTER `after`. Walks the calendar
 * forward, jumping months/days when fields don't match instead of
 * scanning minute-by-minute.
 */
export function nextCronFire(cron: CronExpr, after: Date): Date {
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const domRestricted = cron.dom.size !== 31;
  const dowRestricted = cron.dow.size !== 7;
  // Safety cap — 8 years of day-level iterations is plenty; if we exhaust
  // it the expression is effectively impossible (e.g. Feb 30).
  for (let i = 0; i < 366 * 8; i++) {
    if (!cron.month.has(d.getMonth() + 1)) {
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = cron.dom.has(d.getDate());
    const dowOk = cron.dow.has(d.getDay());
    // Vixie-cron semantics: when both dom and dow are restricted, EITHER
    // match counts. Otherwise both must match (the unrestricted field is
    // effectively `*` and always matches).
    const dateMatches = domRestricted && dowRestricted ? (domOk || dowOk) : (domOk && dowOk);
    if (!dateMatches) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1);
      d.setMinutes(0, 0, 0);
      continue;
    }
    if (!cron.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  throw new Error(`cron next-fire search exhausted for "${cron.raw}"`);
}
