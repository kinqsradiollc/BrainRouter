/**
 * ADR-060 D2 — one iCalendar (RFC 5545) parser, pure and browser-safe.
 *
 * Every calendar product speaks this format: Google's "secret address in iCal
 * format", iCloud's shared-calendar link, Outlook's published calendar, and the
 * `.ics` file each of them exports. This parses what those actually emit —
 * not the whole RFC — and expands recurrences ONLY inside the window it was
 * asked for, so a "forever" rule stays bounded. Anything it does not
 * understand is skipped and counted in `failures`, never guessed.
 *
 * No time-zone database ships with it: `TZID`s resolve through
 * `Intl.DateTimeFormat`, with a small map for the Windows names Outlook uses.
 * An unresolvable zone falls back to the calendar's `X-WR-TIMEZONE`, then UTC,
 * and the event records which zone it was read in. No I/O anywhere here.
 */

export interface IcsEvent {
  /** `UID`, stable across refreshes of the same feed. */
  uid: string;
  /** For an occurrence of a recurring event: the occurrence's original start (ISO). */
  recurrenceId?: string;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  organizer?: string;
  /** UTC instant, ISO 8601. For an all-day event: midnight of that day in the event's zone. */
  start: string;
  /** UTC instant, ISO 8601, exclusive. */
  end: string;
  allDay: boolean;
  /** The IANA zone the wall-clock times were read in, when one applied. */
  timeZone?: string;
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  sequence?: number;
  lastModified?: string;
}

export interface IcsParseResult {
  calendarName?: string;
  calendarTimeZone?: string;
  /** `X-APPLE-CALENDAR-COLOR` / `COLOR` when the feed declares one. */
  color?: string;
  events: IcsEvent[];
  /** Human-readable notes on what was skipped and why. */
  failures: string[];
}

export interface IcsParseOptions {
  /** ISO instants; occurrences outside [windowStart, windowEnd) are not produced. */
  windowStart: string;
  windowEnd: string;
  /** Upper bound on occurrences per recurring event inside the window. */
  maxOccurrences?: number;
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

/* ------------------------------------------------------------------ lines */

/** RFC 5545 §3.1 — a line that starts with a space or tab continues the previous one. */
function unfoldIcsLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out.filter((line) => line.length > 0);
}

/** `NAME;P=1;Q="a:b":value` → { name, params, value }. Parameters may be quoted. */
function parseIcsProperty(line: string): Property | null {
  let i = 0;
  let inQuotes = false;
  for (; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [rawName, ...rawParams] = splitUnquoted(head, ';');
  const name = (rawName ?? '').trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

function splitUnquoted(text: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === sep && !inQuotes) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** TEXT values escape `\n`, `\,`, `\;`, `\\` (RFC 5545 §3.3.11). */
function unescapeText(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/* ------------------------------------------------------------- time zones */

/** The Windows zone names Outlook writes, for the zones people in our markets use. */
const WINDOWS_ZONES: Record<string, string> = {
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'W. Australia Standard Time': 'Australia/Perth',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'China Standard Time': 'Asia/Shanghai',
  'India Standard Time': 'Asia/Kolkata',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Warsaw',
  'Central European Standard Time': 'Europe/Belgrade',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
};

const zoneCache = new Map<string, Intl.DateTimeFormat | null>();

/** An `Intl` formatter for the zone, or null when the runtime does not know it. */
function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  const cached = zoneCache.get(zone);
  if (cached !== undefined) return cached;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { fmt = null; }
  zoneCache.set(zone, fmt);
  return fmt;
}

/** Resolve a TZID to an IANA zone Intl knows: as written, else the Windows map, else null. */
function resolveIcsZone(tzid: string | undefined): string | null {
  if (!tzid) return null;
  // As written; then the Windows name; then every suffix after a '/' (Evolution
  // and some CalDAV servers prefix the IANA name with a namespace path).
  const suffixes = tzid.split('/').map((_, i, parts) => parts.slice(i).join('/')).filter(Boolean);
  const candidates = [tzid, WINDOWS_ZONES[tzid], ...suffixes].filter((z): z is string => Boolean(z));
  for (const zone of candidates) if (zoneFormatter(zone)) return zone;
  return null;
}

/** Wall-clock fields of a UTC instant, as seen in `zone`. */
function wallClockIn(zone: string, instantMs: number): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const parts = zoneFormatter(zone)!.formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour') % 24, mm: get('minute'), ss: get('second') };
}

/** The UTC instant of a wall-clock time in `zone`. Two passes settle DST edges. */
function zonedWallClockToUtc(zone: string, y: number, m: number, d: number, hh: number, mm: number, ss: number): number {
  const asUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = asUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallClockIn(zone, guess);
    const seenUtc = Date.UTC(seen.y, seen.m - 1, seen.d, seen.hh, seen.mm, seen.ss);
    guess += asUtc - seenUtc;
  }
  return guess;
}

/* ------------------------------------------------------------ date values */

interface ParsedDate {
  /** UTC ms. */
  ms: number;
  allDay: boolean;
  zone?: string;
}

/** `20260914`, `20260914T093000`, `20260914T093000Z`, with an optional TZID param. */
function parseDateValue(prop: Property, defaultZone: string | null, failures: string[], label: string): ParsedDate | null {
  const v = prop.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || prop.params.VALUE === 'DATE') {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) { failures.push(`${label}: unreadable date "${v}"`); return null; }
    return { ms: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) { failures.push(`${label}: unreadable date-time "${v}"`); return null; }
  const [y, mo, d, hh, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const ss = Number(m[6] ?? '0');
  if (m[7] === 'Z') return { ms: Date.UTC(y, mo - 1, d, hh, mi, ss), allDay: false };
  const zone = resolveIcsZone(prop.params.TZID) ?? defaultZone;
  if (!zone) return { ms: Date.UTC(y, mo - 1, d, hh, mi, ss), allDay: false, zone: 'UTC' };
  if (prop.params.TZID && !resolveIcsZone(prop.params.TZID)) failures.push(`${label}: unknown zone "${prop.params.TZID}", read in ${zone}`);
  return { ms: zonedWallClockToUtc(zone, y, mo, d, hh, mi, ss), allDay: false, zone };
}

/** `P1D`, `PT1H30M`, `P2W`, `-PT15M` → milliseconds. */
function parseIcsDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const [w, d, h, mi, s] = [m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x ?? '0'));
  return sign * (((w * 7 + d) * 24 * 3600 + h * 3600 + mi * 60 + s) * 1000);
}

/* ------------------------------------------------------------- recurrence */

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  untilMs?: number;
  byDay?: Array<{ ordinal: number; day: number }>; // day: 0=SU … 6=SA
  byMonthDay?: number[];
  byMonth?: number[];
  weekStart: number;
}

const DAY_CODES: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRule(value: string, failures: string[], label: string): Rule | null {
  const parts: Record<string, string> = {};
  for (const kv of value.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
  }
  const freq = parts.FREQ as Rule['freq'] | undefined;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    failures.push(`${label}: recurrence "${parts.FREQ ?? '?'}" is not supported; only the first occurrence is kept`);
    return null;
  }
  const rule: Rule = { freq, interval: Math.max(1, Number(parts.INTERVAL ?? '1') || 1), weekStart: DAY_CODES[parts.WKST ?? 'MO'] ?? 1 };
  if (parts.COUNT) rule.count = Number(parts.COUNT);
  if (parts.UNTIL) {
    const u = parts.UNTIL;
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(u);
    if (m) rule.untilMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? '23'), Number(m[5] ?? '59'), Number(m[6] ?? '59'));
  }
  if (parts.BYDAY) {
    rule.byDay = parts.BYDAY.split(',').map((tok) => {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok.trim());
      return m ? { ordinal: Number(m[1] ?? '0'), day: DAY_CODES[m[2]!]! } : null;
    }).filter((x): x is { ordinal: number; day: number } => x !== null);
  }
  if (parts.BYMONTHDAY) rule.byMonthDay = parts.BYMONTHDAY.split(',').map(Number).filter((n) => Number.isInteger(n));
  if (parts.BYMONTH) rule.byMonth = parts.BYMONTH.split(',').map(Number).filter((n) => n >= 1 && n <= 12);
  return rule;
}

/** Day-of-week (0=SU) of a wall-clock date. */
function weekday(y: number, m: number, d: number): number { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function daysInMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/**
 * Occurrence starts (as wall-clock {y,m,d}) for a rule from a first occurrence,
 * bounded by the window end, COUNT, UNTIL and `maxOccurrences`. Wall-clock
 * arithmetic keeps a 9:00 meeting at 9:00 across a DST change, which is what
 * every calendar app does.
 */
function expandRule(rule: Rule, first: { y: number; m: number; d: number }, wallToMs: (y: number, m: number, d: number) => number, windowEndMs: number, max: number): Array<{ y: number; m: number; d: number }> {
  const out: Array<{ y: number; m: number; d: number }> = [];
  const push = (y: number, m: number, d: number): boolean => {
    const ms = wallToMs(y, m, d);
    if (rule.untilMs !== undefined && ms > rule.untilMs) return false;
    if (ms >= windowEndMs) return false;
    out.push({ y, m, d });
    return !(rule.count !== undefined && out.length >= rule.count) && out.length < max;
  };
  const addDays = (y: number, m: number, d: number, n: number): { y: number; m: number; d: number } => {
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  };
  let cursor = { ...first };
  let safety = 0;
  if (rule.freq === 'DAILY') {
    for (;;) { if (!push(cursor.y, cursor.m, cursor.d)) break; cursor = addDays(cursor.y, cursor.m, cursor.d, rule.interval); if (++safety > 100_000) break; }
  } else if (rule.freq === 'WEEKLY') {
    const days = rule.byDay?.length ? rule.byDay.map((b) => b.day) : [weekday(first.y, first.m, first.d)];
    // Walk week by week from the week containing `first`, emitting the chosen weekdays (≥ first).
    const firstMs = Date.UTC(first.y, first.m - 1, first.d);
    const startOfWeekOffset = (weekday(first.y, first.m, first.d) - rule.weekStart + 7) % 7;
    let weekStart = addDays(first.y, first.m, first.d, -startOfWeekOffset);
    let go = true;
    for (; go;) {
      for (let i = 0; i < 7 && go; i += 1) {
        const day = addDays(weekStart.y, weekStart.m, weekStart.d, i);
        if (!days.includes(weekday(day.y, day.m, day.d))) continue;
        if (Date.UTC(day.y, day.m - 1, day.d) < firstMs) continue;
        go = push(day.y, day.m, day.d);
      }
      weekStart = addDays(weekStart.y, weekStart.m, weekStart.d, 7 * rule.interval);
      if (++safety > 20_000) break;
    }
  } else if (rule.freq === 'MONTHLY') {
    let y = first.y; let m = first.m;
    let go = true;
    for (; go;) {
      const candidates: number[] = [];
      if (rule.byMonthDay?.length) for (const md of rule.byMonthDay) { const dim = daysInMonth(y, m); const d = md > 0 ? md : dim + md + 1; if (d >= 1 && d <= dim) candidates.push(d); }
      else if (rule.byDay?.length) {
        for (const { ordinal, day } of rule.byDay) {
          const dim = daysInMonth(y, m);
          const matches: number[] = [];
          for (let d = 1; d <= dim; d += 1) if (weekday(y, m, d) === day) matches.push(d);
          if (ordinal === 0) candidates.push(...matches);
          else { const pick = ordinal > 0 ? matches[ordinal - 1] : matches[matches.length + ordinal]; if (pick) candidates.push(pick); }
        }
      } else if (first.d <= daysInMonth(y, m)) candidates.push(first.d);
      for (const d of [...new Set(candidates)].sort((a, b) => a - b)) {
        if (Date.UTC(y, m - 1, d) < Date.UTC(first.y, first.m - 1, first.d)) continue;
        go = push(y, m, d);
        if (!go) break;
      }
      m += rule.interval; while (m > 12) { m -= 12; y += 1; }
      if (++safety > 5_000) break;
    }
  } else {
    let y = first.y;
    let go = true;
    for (; go;) {
      const months = rule.byMonth?.length ? rule.byMonth : [first.m];
      for (const m of months) {
        const d = Math.min(first.d, daysInMonth(y, m));
        if (Date.UTC(y, m - 1, d) < Date.UTC(first.y, first.m - 1, first.d)) continue;
        go = push(y, m, d);
        if (!go) break;
      }
      y += rule.interval;
      if (++safety > 1_000) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ parse */

interface RawEvent { props: Property[] }

function collectComponents(lines: string[], failures: string[]): { calendar: Property[]; events: RawEvent[] } {
  const calendar: Property[] = [];
  const events: RawEvent[] = [];
  const stack: string[] = [];
  let current: RawEvent | null = null;
  for (const line of lines) {
    const prop = parseIcsProperty(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      const kind = prop.value.trim().toUpperCase();
      stack.push(kind);
      if (kind === 'VEVENT') current = { props: [] };
      continue;
    }
    if (prop.name === 'END') {
      const kind = prop.value.trim().toUpperCase();
      stack.pop();
      if (kind === 'VEVENT' && current) { events.push(current); current = null; }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === 'VEVENT' && current) current.props.push(prop);
    else if (top === 'VCALENDAR') calendar.push(prop);
    // VTIMEZONE, VALARM, VTODO … are ignored (zones resolve through Intl).
  }
  if (stack.length) failures.push(`unbalanced components: ${stack.join(' > ')} never ended`);
  return { calendar, events };
}

function first(props: Property[], name: string): Property | undefined { return props.find((p) => p.name === name); }
function all(props: Property[], name: string): Property[] { return props.filter((p) => p.name === name); }

/** Parse a feed or file. Pure. */
export function parseIcs(text: string, options: IcsParseOptions): IcsParseResult {
  const failures: string[] = [];
  const windowStartMs = Date.parse(options.windowStart);
  const windowEndMs = Date.parse(options.windowEnd);
  const max = options.maxOccurrences ?? 400;
  const { calendar, events: raw } = collectComponents(unfoldIcsLines(text), failures);
  const calendarName = first(calendar, 'X-WR-CALNAME')?.value.trim() || first(calendar, 'NAME')?.value.trim() || undefined;
  const calendarTimeZone = resolveIcsZone(first(calendar, 'X-WR-TIMEZONE')?.value.trim()) ?? undefined;
  const color = first(calendar, 'X-APPLE-CALENDAR-COLOR')?.value.trim() || first(calendar, 'COLOR')?.value.trim() || undefined;

  // Overrides (RECURRENCE-ID) replace the occurrence they name; index them by uid + original start.
  const overrides = new Map<string, IcsEvent>();
  const masters: Array<{ ev: IcsEvent; rule: Rule | null; exdates: Set<number>; startWall: { y: number; m: number; d: number; hh: number; mm: number; ss: number }; durationMs: number; startZone: string | null }> = [];

  for (const [index, item] of raw.entries()) {
    const uid = first(item.props, 'UID')?.value.trim() || `no-uid-${index}`;
    const label = `event ${uid}`;
    const summary = unescapeText(first(item.props, 'SUMMARY')?.value ?? '').trim();
    const dtstart = first(item.props, 'DTSTART');
    if (!dtstart) { failures.push(`${label}: no DTSTART; skipped`); continue; }
    const start = parseDateValue(dtstart, calendarTimeZone ?? null, failures, label);
    if (!start) continue;
    const dtend = first(item.props, 'DTEND');
    const duration = first(item.props, 'DURATION');
    let durationMs: number;
    if (dtend) {
      const end = parseDateValue(dtend, start.zone ?? calendarTimeZone ?? null, failures, label);
      durationMs = end ? Math.max(0, end.ms - start.ms) : (start.allDay ? 86_400_000 : 0);
    } else if (duration) {
      durationMs = Math.max(0, parseIcsDuration(duration.value) ?? 0);
    } else {
      durationMs = start.allDay ? 86_400_000 : 0;
    }
    const statusRaw = first(item.props, 'STATUS')?.value.trim().toUpperCase();
    const status = statusRaw === 'CONFIRMED' || statusRaw === 'TENTATIVE' || statusRaw === 'CANCELLED' ? statusRaw : undefined;
    const base: IcsEvent = {
      uid,
      summary: summary || '(no title)',
      start: new Date(start.ms).toISOString(),
      end: new Date(start.ms + durationMs).toISOString(),
      allDay: start.allDay,
      ...(start.zone ? { timeZone: start.zone } : {}),
      ...(first(item.props, 'DESCRIPTION') ? { description: unescapeText(first(item.props, 'DESCRIPTION')!.value).trim() } : {}),
      ...(first(item.props, 'LOCATION') ? { location: unescapeText(first(item.props, 'LOCATION')!.value).trim() } : {}),
      ...(first(item.props, 'URL') ? { url: first(item.props, 'URL')!.value.trim() } : {}),
      ...(first(item.props, 'ORGANIZER') ? { organizer: (first(item.props, 'ORGANIZER')!.params.CN || first(item.props, 'ORGANIZER')!.value.replace(/^mailto:/i, '')).trim() } : {}),
      ...(status ? { status } : {}),
      ...(first(item.props, 'SEQUENCE') ? { sequence: Number(first(item.props, 'SEQUENCE')!.value) } : {}),
      ...(first(item.props, 'LAST-MODIFIED') ? { lastModified: isoOf(first(item.props, 'LAST-MODIFIED')!.value) } : {}),
    };

    const recurrenceId = first(item.props, 'RECURRENCE-ID');
    if (recurrenceId) {
      const original = parseDateValue(recurrenceId, start.zone ?? calendarTimeZone ?? null, failures, label);
      if (original) overrides.set(`${uid} ${original.ms}`, { ...base, recurrenceId: new Date(original.ms).toISOString() });
      continue;
    }

    const rrule = first(item.props, 'RRULE');
    const rule = rrule ? parseRule(rrule.value, failures, label) : null;
    const exdates = new Set<number>();
    for (const ex of all(item.props, 'EXDATE')) {
      for (const one of ex.value.split(',')) {
        const parsed = parseDateValue({ ...ex, value: one }, start.zone ?? calendarTimeZone ?? null, failures, label);
        if (parsed) exdates.add(parsed.ms);
      }
    }
    const zone = start.zone ?? null;
    const wall = zone ? wallClockIn(zone, start.ms) : (() => { const t = new Date(start.ms); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes(), ss: t.getUTCSeconds() }; })();
    masters.push({ ev: base, rule, exdates, startWall: wall, durationMs, startZone: zone });
  }

  const events: IcsEvent[] = [];
  const inWindow = (startMs: number, endMs: number): boolean => endMs > windowStartMs && startMs < windowEndMs;
  for (const master of masters) {
    const { ev, rule, exdates, startWall, durationMs, startZone } = master;
    const wallToMs = (y: number, m: number, d: number): number => (ev.allDay
      ? Date.UTC(y, m - 1, d)
      : startZone ? zonedWallClockToUtc(startZone, y, m, d, startWall.hh, startWall.mm, startWall.ss) : Date.UTC(y, m - 1, d, startWall.hh, startWall.mm, startWall.ss));
    if (!rule) {
      const startMs = Date.parse(ev.start);
      const override = overrides.get(`${ev.uid} ${startMs}`);
      const chosen = override ?? ev;
      if (inWindow(Date.parse(chosen.start), Date.parse(chosen.end))) events.push(chosen);
      continue;
    }
    const occurrences = expandRule(rule, { y: startWall.y, m: startWall.m, d: startWall.d }, wallToMs, windowEndMs, max);
    if (occurrences.length >= max) failures.push(`event ${ev.uid}: recurrence capped at ${max} occurrences in the window`);
    for (const occ of occurrences) {
      const startMs = wallToMs(occ.y, occ.m, occ.d);
      if (exdates.has(startMs)) continue;
      const override = overrides.get(`${ev.uid} ${startMs}`);
      const instance: IcsEvent = override ?? {
        ...ev,
        recurrenceId: new Date(startMs).toISOString(),
        start: new Date(startMs).toISOString(),
        end: new Date(startMs + durationMs).toISOString(),
      };
      if (inWindow(Date.parse(instance.start), Date.parse(instance.end))) events.push(instance);
    }
  }
  // Overrides whose master was outside the window (or unknown) still count if they fall inside it.
  for (const [key, override] of overrides) {
    const [uid] = key.split(' ');
    const claimed = events.some((e) => e.uid === uid && e.recurrenceId === override.recurrenceId);
    if (!claimed && inWindow(Date.parse(override.start), Date.parse(override.end))) events.push(override);
  }
  events.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
  return { ...(calendarName ? { calendarName } : {}), ...(calendarTimeZone ? { calendarTimeZone } : {}), ...(color ? { color } : {}), events, failures };
}

function isoOf(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z?$/.exec(value.trim());
  if (!m) return value;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? '0'))).toISOString();
}

/** `webcal://` is `https://` by convention (Apple's scheme for subscribing). */
export function normalizeCalendarFeedUrl(input: string): string {
  const trimmed = input.trim();
  if (/^webcals?:\/\//i.test(trimmed)) return trimmed.replace(/^webcals?:\/\//i, 'https://');
  return trimmed;
}
