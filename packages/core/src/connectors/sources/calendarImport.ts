/**
 * ADR-060 D4 — where an imported calendar lives, and what may be imported.
 *
 * Separate from the connector runner because both ends need it and neither
 * should own it: the runner READS the stored file, and whatever offers "Import
 * an .ics file" WRITES it. A host that derived its own directory would be one
 * rename away from a connector that points at nothing.
 */
import path from 'node:path';
import { getStateDir } from '../../storage/store.js';

/** A calendar file is a document, not a feed: this is a generous personal export. */
export const MAX_IMPORTED_CALENDAR_BYTES = 8 * 1024 * 1024;

/** `calendars/` beside the connector record that reads it. */
export function calendarImportDir(workspaceRoot: string): string {
  return path.join(getStateDir(workspaceRoot), 'calendars');
}

export interface CalendarImportPlan {
  /** What the person called the file, kept for the surface and the checkpoint. */
  fileName: string;
  /** The calendar's own name when it declares one, else the file's. */
  label: string;
}

/**
 * Check a chosen file BEFORE anything is created or written.
 *
 * Returns the plan or the reason, never throws: this answers a person's click,
 * and "that file is a CSV" is an answer, not an exception. It takes no
 * connector id because it runs first — the connector is created only once the
 * file is known to be a calendar.
 */
export function planCalendarImport(input: {
  fileName: string;
  contents: string;
}): { ok: true; plan: CalendarImportPlan } | { ok: false; error: string } {
  const fileName = path.basename(input.fileName || '').trim();
  if (!fileName) return { ok: false, error: 'Choose a calendar file to import.' };
  if (input.contents.length > MAX_IMPORTED_CALENDAR_BYTES) {
    return {
      ok: false,
      error: `${fileName} is ${Math.round(input.contents.length / 1_048_576)} MB; the limit is ${MAX_IMPORTED_CALENDAR_BYTES / 1_048_576} MB. Export a narrower date range.`,
    };
  }
  if (!/BEGIN:VCALENDAR/i.test(input.contents.slice(0, 2048))) {
    return { ok: false, error: `${fileName} is not an iCalendar file. Export the calendar again as .ics.` };
  }
  return {
    ok: true,
    plan: { fileName, label: calendarName(input.contents) ?? fileName.replace(/\.ics$/i, '') },
  };
}

/**
 * The reference the connector stores and the runner reads back.
 *
 * Named for the connector, so one connector holds one calendar and re-importing
 * replaces it. Throws rather than returning: a connector id that is not a plain
 * id is not a person's mistake, it is a broken caller.
 */
export function importedCalendarRef(connectorId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(connectorId)) {
    throw new Error(`A calendar cannot be stored under connector id ${connectorId}.`);
  }
  return `${connectorId}.ics`;
}

/** `X-WR-CALNAME` if the export carries one — people name their calendars, files get named by the exporter. */
function calendarName(contents: string): string | undefined {
  const match = /^X-WR-CALNAME:(.*)$/im.exec(contents.slice(0, 8192));
  const value = match?.[1]?.trim().replace(/\\,/g, ',');
  return value || undefined;
}
