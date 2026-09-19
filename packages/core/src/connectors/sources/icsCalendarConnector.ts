/**
 * ADR-060 D1 — the `ics-calendar` source: one iCalendar feed URL, read on a
 * cadence, turned into `event` documents the planner projects (D3).
 *
 * The feed carries its own secret (Google's "secret address", iCloud's
 * published token), so there is no credential. Every run re-reads the feed
 * inside the window and re-emits every event in it: a feed has no reliable
 * change signal, and an event that left the feed must leave the planner too,
 * which only a full read can prove. The checkpoint records the last run and
 * the window it covered; the runtime's document store does the diffing.
 */
import { createHash } from 'node:crypto';
import type { ConnectorCheckpoint, ConnectorDocument, ConnectorRecord } from '@kinqs/brainrouter-types';
import { normalizeCalendarFeedUrl, parseIcs, type IcsEvent } from '../../calendar/ics.js';

export interface IcsCalendarFeedClient {
  /** GET the feed; resolves to its text. Throws on a network failure. */
  fetchText(url: string): Promise<{ status: number; contentType: string; body: string }>;
  /**
   * Read a calendar the person imported once (D4), by the reference the host
   * stored it under. Absent on a client that only fetches — an imported
   * connector then fails with that as its reason rather than silently emptying.
   */
  readImported?(ref: string): Promise<string>;
}

/**
 * Where this connector's calendar comes from.
 *
 * "Import an `.ics` file" is a subscription that ran once (D4): the same parse,
 * the same projection, the same removal when the connector is removed. The only
 * difference is where the text comes from and that nothing polls it — which
 * falls out of `pollMinutes: 0`, the rule every source already obeys.
 */
export type IcsCalendarSource =
  | { kind: 'url'; url: string }
  | { kind: 'imported'; ref: string; name: string };

/** A stored reference is a file name this process wrote, never a path. */
const IMPORT_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export interface IcsCalendarRunResult {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

export interface IcsCalendarRunOptions {
  now?: string;
  /** Upper bound on events per run; the feed is read in full but emitted up to this. */
  maxEvents?: number;
}

const ICS_DEFAULT_WINDOW_DAYS_BACK = 7;
const ICS_DEFAULT_WINDOW_DAYS_AHEAD = 60;
const ICS_MAX_EVENTS_PER_RUN = 2_000;
/** A feed larger than this is not a calendar. */
const ICS_MAX_FEED_BYTES = 8 * 1024 * 1024;

export async function runIcsCalendarConnectorCheckpoint(
  connector: ConnectorRecord,
  client: IcsCalendarFeedClient,
  options?: IcsCalendarRunOptions,
): Promise<IcsCalendarRunResult> {
  if (connector.source !== 'ics-calendar') throw new Error(`Connector source ${connector.source} is not ics-calendar.`);
  const origin = calendarSource(connector);
  const now = options?.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const daysBack = positiveNumber(connector.config.windowDaysBack) ?? ICS_DEFAULT_WINDOW_DAYS_BACK;
  const daysAhead = positiveNumber(connector.config.windowDaysAhead) ?? ICS_DEFAULT_WINDOW_DAYS_AHEAD;
  const windowStart = new Date(nowMs - daysBack * 86_400_000).toISOString();
  const windowEnd = new Date(nowMs + daysAhead * 86_400_000).toISOString();
  const maxEvents = Math.max(1, Math.floor(options?.maxEvents ?? ICS_MAX_EVENTS_PER_RUN));

  const failures: string[] = [];
  const where = origin.kind === 'url' ? redactFeedUrl(origin.url) : origin.name;
  let body: string;
  try {
    if (origin.kind === 'imported') {
      if (!client.readImported) throw new Error('this host cannot read imported calendar files');
      body = await client.readImported(origin.ref);
      if (body.length > ICS_MAX_FEED_BYTES) throw new Error(`the file is ${body.length} bytes; the limit is ${ICS_MAX_FEED_BYTES}`);
      if (!/BEGIN:VCALENDAR/i.test(body.slice(0, 2048))) {
        throw new Error('this is not an iCalendar file. Export the calendar again as .ics.');
      }
    } else {
      const res = await client.fetchText(origin.url);
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      if (res.body.length > ICS_MAX_FEED_BYTES) throw new Error(`feed is ${res.body.length} bytes; the limit is ${ICS_MAX_FEED_BYTES}`);
      if (!/BEGIN:VCALENDAR/i.test(res.body.slice(0, 2048))) {
        throw new Error(`not an iCalendar feed (content-type ${res.contentType || 'unknown'}). Google and iCloud links must be the .ics / webcal address, not the calendar's web page.`);
      }
      body = res.body;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result([], [`${where}: ${message}`], now, { ...checkpointOf(connector), lastError: message, windowStart, windowEnd });
  }

  const parsed = parseIcs(body, { windowStart, windowEnd });
  failures.push(...parsed.failures.map((f) => `${where}: ${f}`));
  const label = configString(connector, 'label') || parsed.calendarName || connector.name || 'Calendar';
  const documents = parsed.events.slice(0, maxEvents).map((event) => eventDocument(connector, event, label, parsed.color, now));
  if (parsed.events.length > maxEvents) failures.push(`Stopped after ${maxEvents} events in the window.`);
  return result(documents, failures, now, {
    highWatermark: now,
    ...(origin.kind === 'imported' ? { importedFile: origin.name } : {}),
    windowStart,
    windowEnd,
    eventCount: documents.length,
    calendarName: label,
    ...(parsed.calendarTimeZone ? { calendarTimeZone: parsed.calendarTimeZone } : {}),
    ...(parsed.color ? { color: parsed.color } : {}),
  });
}

/** One `event` document per occurrence. `id` is the UID plus the occurrence's
 *  original start, so a moved occurrence replaces itself and a one-off event
 *  keeps one id across runs. */
function eventDocument(connector: ConnectorRecord, event: IcsEvent, calendarLabel: string, color: string | undefined, now: string): ConnectorDocument {
  const id = event.recurrenceId ? `${event.uid}/${event.recurrenceId}` : event.uid;
  const text = [event.summary, event.location ? `Where: ${event.location}` : '', event.description ?? ''].filter(Boolean).join('\n');
  return {
    id,
    connectorId: connector.id,
    source: 'ics-calendar',
    kind: 'event',
    title: event.summary,
    ...(event.url ? { url: event.url } : {}),
    updatedAt: event.lastModified ?? now,
    text,
    metadata: {
      startAt: event.start,
      endAt: event.end,
      allDay: event.allDay,
      ...(event.timeZone ? { timeZone: event.timeZone } : {}),
      ...(event.location ? { location: event.location } : {}),
      ...(event.organizer ? { organizer: event.organizer } : {}),
      status: event.status ?? 'CONFIRMED',
      calendarId: feedFingerprint(connector),
      calendarLabel,
      ...(color ? { calendarColor: color } : {}),
      uid: event.uid,
      ...(event.recurrenceId ? { recurrenceId: event.recurrenceId } : {}),
      ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    },
  };
}

/**
 * The feed client the runtime uses: plain GET, bounded, `webcal://` normalised.
 *
 * `importedRoot` is the directory a host writes imported `.ics` files into. It
 * is passed rather than assumed because only the host knows where its app data
 * lives; without it, an imported connector says so instead of reading nothing.
 */
export function icsFeedClient(options?: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  importedRoot?: string;
}): IcsCalendarFeedClient {
  const fetcher = options?.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, options?.timeoutMs ?? 20_000);
  const importedRoot = options?.importedRoot;
  return {
    ...(importedRoot
      ? {
        async readImported(ref: string): Promise<string> {
          if (!IMPORT_REF.test(ref)) throw new Error('An imported calendar reference must be a plain file name.');
          const { readFile } = await import('node:fs/promises');
          const { join } = await import('node:path');
          return await readFile(join(importedRoot, ref), 'utf8');
        },
      }
      : {}),
    async fetchText(url) {
      const res = await fetcher(normalizeCalendarFeedUrl(url), {
        headers: { 'User-Agent': 'brainrouter-calendar', Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
    },
  };
}

/** Read once from a file, or polled from a feed — decided by the connector alone. */
export function calendarSource(connector: ConnectorRecord): IcsCalendarSource {
  if (configString(connector, 'mode') === 'file') {
    const ref = configString(connector, 'file');
    if (!ref) throw new Error('An imported calendar has no stored file.');
    // The host wrote this name; a connector record that carries a path instead
    // is either corrupt or hand-edited, and either way is not followed.
    if (!IMPORT_REF.test(ref)) throw new Error('An imported calendar reference must be a plain file name.');
    return { kind: 'imported', ref, name: configString(connector, 'fileName') ?? ref };
  }
  return { kind: 'url', url: feedUrl(connector) };
}

function feedUrl(connector: ConnectorRecord): string {
  const raw = configString(connector, 'url');
  if (!raw) throw new Error('Calendar subscription requires a feed URL (.ics or webcal://).');
  const url = normalizeCalendarFeedUrl(raw);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`Calendar feed URL is not a URL: ${raw}`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`Calendar feed URL must be https:// (or webcal://): ${raw}`);
  return url;
}

/** Feed URLs carry secrets in their path (Google's `private-<token>`, iCloud's published token). Never echo them. */
function redactFeedUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return 'calendar feed';
  }
}

function feedFingerprint(connector: ConnectorRecord): string {
  const identity = connector.config.mode === 'file'
    ? `file:${String(connector.config.file ?? connector.id)}`
    : String(connector.config.url ?? connector.id);
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function configString(connector: ConnectorRecord, key: string): string | undefined {
  const value = connector.config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function checkpointOf(connector: ConnectorRecord): ConnectorCheckpoint {
  return connector.checkpoint ? { ...connector.checkpoint } : {};
}

function result(documents: ConnectorDocument[], failures: string[], now: string, checkpoint: ConnectorCheckpoint): IcsCalendarRunResult {
  return {
    documents,
    failures,
    checkpoint: { ...checkpoint, completedAt: now, documentCount: documents.length, failureCount: failures.length },
  };
}
