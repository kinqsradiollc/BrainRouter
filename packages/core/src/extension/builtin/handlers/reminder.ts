// ADR-041 A41-16 (W4) — the `remind` builtin tool: the model-facing surface for
// session-native reminders. One action-dispatch verb (set / list / cancel) over the
// session reminder store. Delivery is NOT here — a due reminder is materialized at the
// next turn's context-assembly tap (contextPreparationPhase.ts), never mid-turn.
//
// Adopted conventions: errors are FIELDS on the JSON result, never thrown for expected
// outcomes; defaulting is an explicit resolve(request)→spec step; the action union ends
// in an exhaustiveness check. Only a genuine filesystem failure propagates.

import type { BuiltinToolHandler } from './registry.js';
import { parseCron, nextCronFire } from '../../../schedule/cronParser.js';
import {
  addReminder,
  loadReminders,
  removeReminder,
  type ReminderSpec,
  type ReminderTrigger,
} from '../../../session/reminders/index.js';

type ResolveResult =
  | { ok: true; spec: ReminderSpec }
  | { ok: false; error: string; detail?: string };

const DURATION_RE = /^(\d+)(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** The greatest instant a JS Date can represent (ms since epoch). */
const MAX_TIME_MS = 8.64e15;
/** A defensive ceiling on reminders per session — keeps the per-turn projection
 * cost and the injected reminder block bounded. */
const MAX_REMINDERS_PER_SESSION = 100;

/** '30m' | '2h' | '1d' | '90s' → milliseconds, or undefined if malformed. */
function parseDuration(text: string): number | undefined {
  const m = DURATION_RE.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n * UNIT_MS[m[2]!]!;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Turn raw `set` args into a ReminderSpec, or a typed error. Requires a non-empty
 * message and EXACTLY ONE of { at (absolute ISO), in (relative duration), every
 * (5-field cron) }. `at` and `in` are one-shots; `every` recurs.
 */
function resolveReminderRequest(args: Record<string, unknown>, now: number): ResolveResult {
  const message = asString(args.message).trim();
  if (!message) return { ok: false, error: 'missing-message' };

  const at = asString(args.at).trim();
  const inArg = asString(args.in).trim();
  const every = asString(args.every).trim();
  const selectors = [at, inArg, every].filter((s) => s.length > 0);
  if (selectors.length === 0) return { ok: false, error: 'missing-schedule' };
  if (selectors.length > 1) return { ok: false, error: 'ambiguous-schedule' };

  if (at) {
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) return { ok: false, error: 'invalid-time', detail: at };
    if (ms <= now) return { ok: false, error: 'time-in-past', detail: at };
    const iso = new Date(ms).toISOString();
    return { ok: true, spec: { trigger: { kind: 'once', fireAt: iso }, message, nextFireAt: iso } };
  }
  if (inArg) {
    const ms = parseDuration(inArg);
    if (ms === undefined) return { ok: false, error: 'invalid-duration', detail: inArg };
    const target = now + ms;
    // Guard the arithmetic before it reaches Date — an out-of-range instant would
    // throw a RangeError from toISOString, and a bad duration is an expected input.
    if (!Number.isFinite(target) || target > MAX_TIME_MS) {
      return { ok: false, error: 'invalid-duration', detail: inArg };
    }
    const iso = new Date(target).toISOString();
    return { ok: true, spec: { trigger: { kind: 'once', fireAt: iso }, message, nextFireAt: iso } };
  }
  // every
  const cron = parseCron(every);
  if (!cron) return { ok: false, error: 'invalid-cron', detail: every };
  const trigger: ReminderTrigger = { kind: 'recurring', cron: every };
  const nextFireAt = nextCronFire(cron, new Date(now)).toISOString();
  return { ok: true, spec: { trigger, message, nextFireAt } };
}

export const reminderHandlers: Record<string, BuiltinToolHandler> = {
  remind: async ({ args, host }) => {
    const action = asString(args.action).trim();
    const ws = host.workspaceRoot;
    const sk = host.sessionKey;

    switch (action) {
      case 'set': {
        const resolved = resolveReminderRequest(args, Date.now());
        if (!resolved.ok) return JSON.stringify(resolved);
        if (loadReminders(ws, sk).length >= MAX_REMINDERS_PER_SESSION) {
          return JSON.stringify({ ok: false, error: 'too-many-reminders', detail: `limit ${MAX_REMINDERS_PER_SESSION}` });
        }
        const record = addReminder(ws, sk, resolved.spec);
        return JSON.stringify({
          ok: true,
          action: 'set',
          id: record.id,
          nextFireAt: record.nextFireAt,
          recurs: record.trigger.kind === 'recurring',
        });
      }
      case 'list': {
        const reminders = loadReminders(ws, sk).map((r) => ({
          id: r.id,
          trigger: r.trigger,
          message: r.message,
          nextFireAt: r.nextFireAt,
          enabled: r.enabled,
          lastFiredAt: r.lastFiredAt,
        }));
        return JSON.stringify({ ok: true, action: 'list', reminders });
      }
      case 'cancel': {
        const id = asString(args.id).trim();
        if (!id) return JSON.stringify({ ok: false, error: 'missing-id' });
        const removed = removeReminder(ws, sk, id);
        return removed
          ? JSON.stringify({ ok: true, action: 'cancel', id })
          : JSON.stringify({ ok: false, error: 'not-found', detail: id });
      }
      default:
        return JSON.stringify({ ok: false, error: 'unknown-action', detail: action });
    }
  },
};
