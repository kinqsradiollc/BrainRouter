/**
 * ADR-041 A41-16 (W4) — session-native reminders.
 *
 * The parity program's "schedule tools with a catch-up policy" unified onto a
 * session-local surface. A reminder is durable per-session state (it travels with
 * a fork/export and dies with the session, exactly like the transcript and the
 * message-feedback ledger), NOT the workspace-level `schedules.json` the `/schedule`
 * cron ticker owns. The unify is at the POLICY layer — this module is the single
 * source of the catch-up semantics the ADR names:
 *
 *   - only the latest due occurrence per recurring rule  (coalesce; N missed
 *     windows collapse to ONE delivery whose occurrence is the greatest cron edge
 *     ≤ now and whose next fire is the first edge strictly after now)
 *   - at-least-once                                       (the projection is pure
 *     and never mutates; the caller commits STRICTLY AFTER durably recording the
 *     delivery, so a crash re-delivers next turn rather than losing it)
 *   - maintenance-phase delivery, never interrupts a turn (delivery is driven only
 *     from the inter-turn context-assembly tap — see contextPreparationPhase.ts —
 *     so a reminder that comes due mid-turn is seen by the NEXT turn, never injected
 *     into an in-flight one)
 *   - misconfiguration fails loud                         (a corrupt record warns
 *     loudly and is forced inert at load; a bad recurring rule reaching the pure
 *     projection yields a non-destructive `disable`, never a fire and never a spin)
 *
 * The record shape mirrors `schedule/scheduleStore.ts` deliberately so the two
 * subsystems read as one family; they differ only in scope (session vs workspace)
 * and payload (a reminder message vs a slash command).
 */

import crypto from 'node:crypto';
import { getSessionStateFile, readJsonFile, writeJsonFile } from '../../storage/store.js';
import { parseCron, nextCronFire } from '../../schedule/cronParser.js';

/** Opaque cross-boundary id; minted here, never parsed by callers. */
export type ReminderId = string & { readonly __brand: 'ReminderId' };

/** A once-off at an absolute time, or a recurring 5-field cron rule. Closed union. */
export type ReminderTrigger =
  | { kind: 'once'; fireAt: string }
  | { kind: 'recurring'; cron: string };

export interface ReminderRecord {
  id: ReminderId;
  trigger: ReminderTrigger;
  /** The text delivered to the model when the reminder fires. */
  message: string;
  createdAt: string;
  enabled: boolean;
  /** ISO time of the next (or currently-due) occurrence. */
  nextFireAt: string;
  lastFiredAt?: string;
}

/** What `addReminder` needs; `nextFireAt` is resolved by the caller (the handler). */
export interface ReminderSpec {
  trigger: ReminderTrigger;
  message: string;
  nextFireAt: string;
}

interface ReminderFile {
  version: 1;
  reminders: ReminderRecord[];
}

const FILE_NAME = 'reminders.json';
const EMPTY: ReminderFile = { version: 1, reminders: [] };

/**
 * The catch-up walk cap. A minute-granularity rule dormant for a day is 1440
 * edges; beyond that we snap to `now` rather than walk, so a rule dormant for
 * months can never spin. Module-private: the bound is an implementation detail,
 * asserted by the tests via a `nextCronFire` call-count spy, not read as a value.
 */
const MAX_CATCHUP_STEPS = 1440;

function filePath(workspaceRoot: string, sessionKey: string): string {
  return getSessionStateFile(workspaceRoot, sessionKey, FILE_NAME);
}

function mintReminderId(): ReminderId {
  return `rem_${crypto.randomBytes(6).toString('hex')}` as ReminderId;
}

/** Never reached at runtime; the compiler proves the union is exhausted. */
function assertNever(x: never): never {
  throw new Error(`unreachable reminder variant: ${JSON.stringify(x)}`);
}

/**
 * A record is USABLE when its trigger is well-formed and its next occurrence is a
 * real instant. A recurring rule with an unparseable cron, or any record with a
 * non-finite `nextFireAt`, is misconfiguration: we keep it (so `remind list` can
 * still show it and the agent can cancel it) but force it inert, and we say so
 * loudly. Non-destructive — the on-disk row is untouched.
 */
function sanitizeLoaded(record: ReminderRecord): ReminderRecord {
  const reasons: string[] = [];
  if (!Number.isFinite(Date.parse(record.nextFireAt))) reasons.push('non-finite nextFireAt');
  if (record.trigger.kind === 'recurring' && !parseCron(record.trigger.cron)) {
    reasons.push(`unparseable cron "${record.trigger.cron}"`);
  }
  if (reasons.length === 0) return record;
  console.warn(`[reminders] forcing reminder ${record.id} inert: ${reasons.join('; ')}`);
  return { ...record, enabled: false };
}

/** Load this session's reminders, failing loud (and inert) on any corrupt row. */
export function loadReminders(workspaceRoot: string, sessionKey: string): ReminderRecord[] {
  const raw = readJsonFile<ReminderFile>(filePath(workspaceRoot, sessionKey), EMPTY).reminders ?? [];
  return raw.map(sanitizeLoaded);
}

function saveReminders(workspaceRoot: string, sessionKey: string, list: ReminderRecord[]): void {
  writeJsonFile(filePath(workspaceRoot, sessionKey), { version: 1, reminders: list } satisfies ReminderFile);
}

export function addReminder(workspaceRoot: string, sessionKey: string, spec: ReminderSpec): ReminderRecord {
  const record: ReminderRecord = {
    id: mintReminderId(),
    trigger: spec.trigger,
    message: spec.message,
    createdAt: new Date().toISOString(),
    enabled: true,
    nextFireAt: spec.nextFireAt,
  };
  const list = loadReminders(workspaceRoot, sessionKey);
  list.push(record);
  saveReminders(workspaceRoot, sessionKey, list);
  return record;
}

export function removeReminder(workspaceRoot: string, sessionKey: string, id: string): boolean {
  const list = loadReminders(workspaceRoot, sessionKey);
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  saveReminders(workspaceRoot, sessionKey, next);
  return true;
}

export function setReminderEnabled(workspaceRoot: string, sessionKey: string, id: string, enabled: boolean): boolean {
  const list = loadReminders(workspaceRoot, sessionKey);
  const record = list.find((r) => r.id === id);
  if (!record) return false;
  record.enabled = enabled;
  saveReminders(workspaceRoot, sessionKey, list);
  return true;
}

/** Recurring-fire commit: advance to the next edge and stamp the fire. */
export function advanceReminder(
  workspaceRoot: string,
  sessionKey: string,
  id: string,
  nextFireAt: string,
  lastFiredAt: string,
): boolean {
  const list = loadReminders(workspaceRoot, sessionKey);
  const record = list.find((r) => r.id === id);
  if (!record) return false;
  record.nextFireAt = nextFireAt;
  record.lastFiredAt = lastFiredAt;
  saveReminders(workspaceRoot, sessionKey, list);
  return true;
}

/**
 * What the pure projection decided for one due record. Orthogonal outcomes are
 * distinct variants; the caller commits each independently. Closed union.
 */
export type ReminderOutcome =
  | { kind: 'fire-once'; record: ReminderRecord; occurrence: string }
  | { kind: 'fire-recurring'; record: ReminderRecord; occurrence: string; nextFireAt: string }
  | { kind: 'disable'; record: ReminderRecord; reason: string };

/**
 * The catch-up policy, as a PURE function of (records, now) — no I/O, no store, no
 * ambient clock. Deterministic, so it is exhaustively testable and the delivery tap
 * stays a thin commit loop around it.
 *
 * Per enabled record whose `nextFireAt` is at or before `now`:
 *  - `once`      → fire once (caller removes it).
 *  - `recurring` → coalesce every window missed since `nextFireAt` into ONE fire:
 *    `occurrence` is the greatest cron edge ≤ now, `nextFireAt` the first edge
 *    strictly after now. The walk is bounded by MAX_CATCHUP_STEPS; past that it
 *    snaps to `now` so a long-dormant rule can never spin. An unparseable cron is
 *    misconfiguration → `disable` (never a fire).
 */
export function collectDueReminders(records: readonly ReminderRecord[], now: number): ReminderOutcome[] {
  const outcomes: ReminderOutcome[] = [];
  for (const record of records) {
    if (!record.enabled) continue;
    const nextMs = Date.parse(record.nextFireAt);
    if (!Number.isFinite(nextMs) || nextMs > now) continue;

    const trigger = record.trigger;
    switch (trigger.kind) {
      case 'once':
        outcomes.push({ kind: 'fire-once', record, occurrence: record.nextFireAt });
        break;
      case 'recurring': {
        const cron = parseCron(trigger.cron);
        if (!cron) {
          outcomes.push({ kind: 'disable', record, reason: `unparseable-cron: ${trigger.cron}` });
          break;
        }
        // Coalesce to the LATEST due edge with a bounded forward walk.
        let occ = nextMs;
        let probe = nextCronFire(cron, new Date(nextMs)).getTime();
        let steps = 0;
        while (probe <= now && steps < MAX_CATCHUP_STEPS) {
          occ = probe;
          probe = nextCronFire(cron, new Date(probe)).getTime();
          steps += 1;
        }
        // Snap to now ONLY on genuine overflow — the cap was hit while still
        // behind (probe <= now). If the walk finished naturally (probe > now),
        // even at exactly MAX_CATCHUP_STEPS, `occ` is already the greatest edge
        // ≤ now and must be preserved.
        if (probe <= now) {
          occ = now;
          probe = nextCronFire(cron, new Date(now)).getTime();
        }
        outcomes.push({
          kind: 'fire-recurring',
          record,
          occurrence: new Date(occ).toISOString(),
          nextFireAt: new Date(probe).toISOString(),
        });
        break;
      }
      default:
        return assertNever(trigger);
    }
  }
  return outcomes;
}

/**
 * Coalesce every deliverable outcome (fire-once / fire-recurring) into ONE
 * `<system-reminder id="reminders">` block — the same literal shape the
 * child-results emitter uses (childObservation.ts). `disable` outcomes carry no
 * delivery. Returns undefined when nothing is deliverable.
 */
export function renderReminderSystemMessage(outcomes: readonly ReminderOutcome[]): string | undefined {
  const lines = outcomes
    .filter((o): o is Extract<ReminderOutcome, { kind: 'fire-once' | 'fire-recurring' }> =>
      o.kind === 'fire-once' || o.kind === 'fire-recurring')
    .map((o) => `- (${o.occurrence}) ${o.record.message}`);
  if (lines.length === 0) return undefined;
  return [
    '<system-reminder id="reminders">',
    'Reminders you scheduled have come due. Act on them now if still relevant, or note why not; they will not fire again on their own (recurring ones fire once per rule at their next window).',
    '',
    ...lines,
    '</system-reminder>',
  ].join('\n');
}
