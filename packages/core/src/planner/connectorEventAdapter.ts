/**
 * ADR-060 D3 — a calendar event is a planner item plus a time block.
 *
 * The sibling of `connectorIssueAdapter`, over `event` documents rather than
 * `issue` ones, and for the same reason: the connector remains the source of
 * truth and this module only maps explicit source facts. Nothing here reads a
 * clock or a network; the projection is a pure function of the documents.
 *
 * What an event becomes:
 *   - a MIRRORED item whose day is the event's own day, so the Today list, the
 *     week strip and the day score all see the meeting the person will have;
 *   - a source-owned block at the event's start for its duration, so the
 *     Calendar tab draws it where it is.
 *
 * **An all-day event gets no block**, and this is a deliberate departure from
 * D3 as written ("the day's first hour, 60 minutes"). A block exists to say
 * when work happens; an all-day event has a day and no time, and inventing
 * 9am for a public holiday would put a made-up hour on the calendar and count
 * made-up minutes against the day's commitment. The item's due date carries it
 * instead, which is what the day surfaces already read.
 */
import { createHash } from 'node:crypto';
import type { ConnectorDocumentRecord, ConnectorSource } from '@kinqs/brainrouter-types';
import type { Hlc } from '../sync/hybridClock.js';
import type { PlannerItem } from './itemMerge.js';
import type { TimeBlock } from './timetable.js';

/** Sources whose `event` documents describe a person's calendar. */
const SUPPORTED_EVENT_SOURCES = new Set<ConnectorSource>(['ics-calendar']);

/** A description longer than this is a meeting agenda, not a planner note. */
const MAX_EVENT_NOTES_CHARS = 2_000;

export interface ConnectorEventProjectionInput {
  /** Stable product connector id, not a temporary runtime-workspace id. */
  connectorId: string;
  source: ConnectorSource;
  /** What the person calls this calendar; shown on every event from it. */
  sourceLabel: string;
  documents: readonly ConnectorDocumentRecord[];
}

export interface ProjectedEvent {
  item: PlannerItem;
  /** Absent for an all-day event, and for one whose end is not after its start. */
  block?: TimeBlock;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sourceStamp(input: ConnectorEventProjectionInput, document: ConnectorDocumentRecord): Hlc {
  const physical = Date.parse(document.updatedAt ?? document.lastSeenAt);
  return {
    physical: Number.isFinite(physical) ? Math.max(0, physical) : 0,
    logical: 0,
    deviceId: `source:${input.connectorId}`.slice(0, 200),
  };
}

function stableId(prefix: string, connectorId: string, externalId: string): string {
  const digest = createHash('sha256')
    .update(connectorId)
    .update('\0')
    .update(externalId)
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

/**
 * The day an event belongs to: its own day, in its own zone.
 *
 * A 9am Melbourne meeting is 23:00Z the day before; filing it under the UTC
 * date would show tomorrow's stand-up today for half the world. All-day events
 * already carry midnight of their date, so their date is read directly.
 */
export function eventDay(startAt: string, timeZone: string | undefined, allDay: boolean): string | undefined {
  if (allDay) return /^\d{4}-\d{2}-\d{2}/.test(startAt) ? startAt.slice(0, 10) : undefined;
  const ms = Date.parse(startAt);
  if (!Number.isFinite(ms)) return undefined;
  if (!timeZone) return new Date(ms).toISOString().slice(0, 10);
  try {
    // `en-CA` renders as YYYY-MM-DD, which is the shape the planner stores.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** Whole minutes between two instants, or null when there is no positive span. */
export function eventMinutes(startAt: string, endAt: string | undefined): number | null {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const minutes = Math.round((end - start) / 60_000);
  return minutes > 0 ? minutes : null;
}

/**
 * Map one calendar event document. Returns null when the document is not a
 * usable event from this source.
 *
 * A CANCELLED event is projected as a TOMBSTONE rather than skipped: the feed
 * is telling us the meeting is off, and dropping that on the floor would leave
 * the person looking at a meeting nobody is attending.
 */
export function connectorEventToProjection(
  input: ConnectorEventProjectionInput,
  document: ConnectorDocumentRecord,
): ProjectedEvent | null {
  if (document.kind !== 'event' || document.source !== input.source) return null;
  if (!SUPPORTED_EVENT_SOURCES.has(input.source)) return null;
  const title = document.title.trim();
  const startAt = str(document.metadata.startAt);
  if (!title || !startAt || !Number.isFinite(Date.parse(startAt))) return null;

  const at = sourceStamp(input, document);
  const fetchedAt = document.lastSeenAt;
  const id = stableId('itm', input.connectorId, document.id);
  const allDay = document.metadata.allDay === true;
  const timeZone = str(document.metadata.timeZone);
  const day = eventDay(startAt, timeZone, allDay);
  const location = str(document.metadata.location);
  const description = str(document.metadata.description) ?? str(document.text);
  const notes = [location ? `Where: ${location}` : '', description && description !== title ? description : '']
    .filter(Boolean).join('\n\n').slice(0, MAX_EVENT_NOTES_CHARS) || undefined;
  const cancelled = str(document.metadata.status)?.toUpperCase() === 'CANCELLED';

  const item: PlannerItem = {
    id,
    origin: 'mirrored',
    source: `connector:${input.connectorId}`,
    fetchedAt,
    provenance: {
      sourceId: `connector:${input.connectorId}`,
      sourceLabel: str(document.metadata.calendarLabel) ?? input.sourceLabel,
      externalId: document.id,
      ...(document.url ? { sourceUrl: document.url } : {}),
      fetchedAt,
      // What makes the tick possible: `sourceOwnsCompletion` reads this to
      // decide that a calendar has no opinion about whether the person went.
      documentKind: 'event',
      ...(hexColor(document.metadata.calendarColor) ? { color: hexColor(document.metadata.calendarColor)! } : {}),
    },
    title: { value: title, at },
    ...(notes ? { notes: { value: notes, at } } : {}),
    ...(day ? { dueDate: { value: day, at } } : {}),
    ...(cancelled ? { deletedAt: at } : {}),
    // No `completed`: attending is the person's act, never the calendar's.
    // No `estimateMinutes`: the block carries the duration, so a meeting that
    // gets longer is right everywhere rather than only where it was created.
  };
  if (cancelled) return { item };

  const minutes = allDay ? null : eventMinutes(startAt, str(document.metadata.endAt));
  if (minutes === null) return { item };
  return {
    item,
    block: {
      id: stableId('blk', input.connectorId, document.id),
      itemId: id,
      scheduledFor: startAt,
      estimateMinutes: minutes,
      carriedOver: 0,
      updatedAt: at,
    },
  };
}

/** Every usable projection in a run, in document order. */
/**
 * A feed's colour, only if it is a plain `#rrggbb`.
 *
 * `X-APPLE-CALENDAR-COLOR` arrives as `#RRGGBBAA` and Google's as `#rrggbb`;
 * anything else reaches a `style` attribute on a surface, so it is dropped
 * rather than passed through.
 */
function hexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim());
  return match ? `#${match[1]!.toLowerCase()}` : undefined;
}

export function projectConnectorEvents(input: ConnectorEventProjectionInput): ProjectedEvent[] {
  return input.documents
    .map((document) => connectorEventToProjection(input, document))
    .filter((projected): projected is ProjectedEvent => projected !== null);
}

/*
 * `createConnectorEventSourceAdapter` stood here and was deleted before it
 * shipped. It mirrored `createConnectorIssueSourceAdapter` out of symmetry, and
 * nothing called it: the server's sink walks `projectConnectorEvents` directly
 * because it needs the BLOCK as well as the item, and a `SourceAdapter` only
 * carries items. Freshness reaches both surfaces through each item's
 * `provenance.fetchedAt`, which is where they already read it.
 */
