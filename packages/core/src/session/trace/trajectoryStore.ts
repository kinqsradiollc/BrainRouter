/**
 * ADR-041 D14 (commitments #2 + #3) — the trajectory ledger's first vertical.
 *
 * D14's glass box promises a turn-aware event ledger beside the chat: step
 * markers with a per-record inspector (input, output, token usage, duration),
 * and tool activity rendered as structured data via semantic *render intents*
 * (terminal / diff / read / search / web), not prose.
 *
 * This is the log-only substrate for that plane. At each model call the runtime
 * appends one STEP record — the model, its wall-clock duration, the prompt /
 * completion token counts, and the tools the step requested (each carrying a
 * render intent computed from its wire name, "logged with the call" per #3).
 * The records live in a per-session `trajectory.jsonl` sidecar, opt-in via
 * `cli.traceTrajectory`, and NEVER enter the transcript or model context — the
 * human sees more than the model (#4), and a replay is byte-identical whether
 * tracing is on or off. Every disk op is best-effort: the ledger is metadata and
 * must never break a turn.
 *
 * D14 #4 extends this into a discriminated union: alongside the model-visible
 * STEP records, the ledger now interleaves LOG-ONLY event records — tool-approval
 * decisions and compaction brackets — by shared `seq`, and `deriveShadowedTrajectory`
 * marks steps before the latest compaction as `shadowed` at read time. So the
 * human sees more than the model, and the two are separately answerable.
 *
 * Not yet in this store (documented follow-ups): turn-grouping of steps, the
 * fixed timeline overview with TTFT-vs-decode spans, tool-result durations
 * (measured at the batch-execution site), and PRECISE per-step shadowing (needs
 * message→seq stamping; the read-time overlay here is the coarse, honest form).
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionStateDir } from '../../storage/store.js';

const TRAJECTORY_FILE = 'trajectory.jsonl';
/** Self-trim ceiling; the newest records are kept when the file grows past it. */
const MAX_RECORDS = 500;
/**
 * Trim only once the file exceeds the ceiling by this much, then down to the
 * ceiling — so a session past the cap rewrites the whole file once per `SLACK`
 * appends, not on every append (a synchronous full-file rewrite on the model
 * response path would stall the event loop in a shared host).
 */
const TRIM_SLACK = 100;
const MAX_EXCERPT_CHARS = 2000;

/**
 * Semantic render intent for a tool call — a pure function of its wire name
 * (D14 #3). A UI renders a diff card / terminal card with an exit pill / search
 * list per intent, and falls back to plain text for `text` (and any name it does
 * not recognise), so an unknown tool degrades instead of breaking.
 */
export type RenderIntent = 'terminal' | 'diff' | 'read' | 'search' | 'web' | 'text';
const RENDER_INTENTS: readonly RenderIntent[] = ['terminal', 'diff', 'read', 'search', 'web', 'text'];

/**
 * Whether a record entered model context (D14 #4). `model-visible` = a step the
 * model produced; `log-only` = an event rendered to the human but never in model
 * context (an approval, a compaction bracket); `shadowed` = a step whose context
 * a later compaction dropped — derived at read time from the compaction markers
 * (see `deriveShadowedTrajectory`), never written back into the append-only log.
 */
export type RecordVisibility = 'model-visible' | 'log-only' | 'shadowed';
const VISIBILITIES: readonly RecordVisibility[] = ['model-visible', 'log-only', 'shadowed'];

/** A tool the step asked to run, with its logged render intent. */
export interface TrajectoryToolRef {
  name: string;
  intent: RenderIntent;
}

/** One step in the trajectory: a single model call and what it produced. */
export interface TrajectoryStep {
  /** Discriminant. Absent on records written before D14 #4 — read as `step`. */
  kind: 'step';
  /** Monotonic per-session index (survives self-trim). */
  seq: number;
  /** The model that answered. */
  model: string;
  /** Reasoning effort in force for the call, when known. */
  effort?: string;
  /** ISO timestamp when the step started (before the first attempt). */
  at: string;
  /** Total wall-clock for the step in ms, including any reconnect / fallback recovery. */
  durationMs?: number;
  /** Prompt tokens the request carried, when the provider reported usage. */
  tokensIn?: number;
  /** Completion tokens the response carried, when reported. */
  tokensOut?: number;
  /** The tools this step requested, each with its render intent (may be empty). */
  tools: TrajectoryToolRef[];
  /** Bounded excerpt of the step's assistant text (empty on a pure tool turn). */
  excerpt?: string;
  /** `model-visible`, or `shadowed` once a later compaction dropped its context. */
  visibility: RecordVisibility;
}

/** A log-only event interleaved with the steps (D14 #4): approval or compaction. */
export type TrajectoryEventKind = 'approval' | 'compaction';
const EVENT_KINDS: readonly TrajectoryEventKind[] = ['approval', 'compaction'];

export interface TrajectoryEvent {
  kind: 'event';
  /** Monotonic per-session index, shared with steps so ordering is total. */
  seq: number;
  /** ISO timestamp when the event happened. */
  at: string;
  /** Which log-only event this is. */
  event: TrajectoryEventKind;
  /** A short human label (e.g. `edit_file → ask` or `compaction`). */
  label: string;
  /** Optional detail (approval reason, or a compaction summary excerpt). */
  detail?: string;
  /** Compaction only: messages dropped / kept by the compaction. */
  droppedMessages?: number;
  keptMessages?: number;
  /** Always `log-only` — the human sees this, the model never did. */
  visibility: 'log-only';
}

/** Either kind of ledger record. */
export type TrajectoryRecord = TrajectoryStep | TrajectoryEvent;

/** The fields the runtime supplies for one step; the store derives the rest. */
export interface TrajectoryStepInput {
  model: string;
  effort?: string;
  at?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Wire tool names the step requested, in order. */
  toolNames: string[];
  /** Assistant text produced by the step, if any. */
  text?: string;
}

/** The fields the runtime supplies for one log-only event. */
export interface TrajectoryEventInput {
  event: TrajectoryEventKind;
  label: string;
  at?: string;
  detail?: string;
  droppedMessages?: number;
  keptMessages?: number;
}

function trajectoryPath(workspaceRoot: string, sessionKey: string): string {
  return path.join(getSessionStateDir(workspaceRoot, sessionKey), TRAJECTORY_FILE);
}

const clampExcerpt = (text: string): string =>
  text.length <= MAX_EXCERPT_CHARS ? text : `${text.slice(0, MAX_EXCERPT_CHARS)}…`;

const isRenderIntent = (v: unknown): v is RenderIntent =>
  typeof v === 'string' && (RENDER_INTENTS as readonly string[]).includes(v);
const isVisibility = (v: unknown): v is RecordVisibility =>
  typeof v === 'string' && (VISIBILITIES as readonly string[]).includes(v);
const isEventKind = (v: unknown): v is TrajectoryEventKind =>
  typeof v === 'string' && (EVENT_KINDS as readonly string[]).includes(v);

/** Map a tool's wire name to its render intent. Pure; unknown names → `text`. */
function renderIntentForTool(name: string): RenderIntent {
  const n = name.toLowerCase();
  if (n === 'run_command' || n === 'run_code' || n === 'kill_command' || n === 'run_shell') return 'terminal';
  if (n === 'write_file' || n === 'edit_file' || n === 'apply_patch' || n === 'notebook_edit' || n === 'create_file') {
    return 'diff';
  }
  if (n === 'read_file' || n === 'read' || n === 'open_file') return 'read';
  if (n === 'grep' || n === 'glob' || n === 'search' || n === 'codebase_search' || n === 'find') return 'search';
  if (n === 'web_search' || n === 'fetch_url' || n === 'web_fetch' || n === 'browse') return 'web';
  return 'text';
}

/** The next monotonic seq: one past the last valid record's, or 0. Survives a
 *  self-trim because the trim keeps the newest records (highest seq) intact. */
function nextSeq(file: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { seq?: unknown };
      if (typeof rec.seq === 'number' && Number.isFinite(rec.seq)) return rec.seq + 1;
    } catch {
      /* torn/last line — keep scanning older ones */
    }
  }
  return 0;
}

/**
 * Whether the file exists and its last byte is not a newline — i.e. the previous
 * write was torn (a crash mid-append). Appending a leading `\n` in that case keeps
 * the torn fragment as its own (skipped) line instead of merging it with the new
 * record and corrupting both. Best-effort: on any error, assume no heal is needed.
 */
function needsLeadingNewline(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a; // '\n'
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Rewrite the file keeping only the newest MAX_RECORDS lines — but only once it
 * has grown past MAX_RECORDS + TRIM_SLACK, so the rewrite amortizes to once per
 * TRIM_SLACK appends instead of firing on every append past the cap. Best-effort.
 */
function trimIfNeeded(file: string): void {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length <= MAX_RECORDS + TRIM_SLACK) return;
    const kept = lines.slice(lines.length - MAX_RECORDS);
    fs.writeFileSync(file, `${kept.join('\n')}\n`, 'utf8');
  } catch {
    /* best-effort — a failed trim just leaves an oversized file */
  }
}

/**
 * Append one step record to the session's trajectory ledger. Best-effort:
 * returns false if the write failed rather than throwing, so a turn never breaks
 * on a metadata write.
 */
export function recordTrajectoryStep(
  workspaceRoot: string,
  sessionKey: string,
  input: TrajectoryStepInput,
): boolean {
  try {
    const file = trajectoryPath(workspaceRoot, sessionKey);
    const record: TrajectoryStep = {
      kind: 'step',
      seq: nextSeq(file),
      model: input.model,
      at: input.at ?? new Date().toISOString(),
      tools: input.toolNames
        .filter((name) => typeof name === 'string' && name.length > 0)
        .map((name) => ({ name, intent: renderIntentForTool(name) })),
      visibility: 'model-visible',
      ...(input.effort ? { effort: input.effort } : {}),
      ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
        ? { durationMs: Math.max(0, Math.round(input.durationMs)) }
        : {}),
      ...(typeof input.tokensIn === 'number' && Number.isFinite(input.tokensIn) ? { tokensIn: input.tokensIn } : {}),
      ...(typeof input.tokensOut === 'number' && Number.isFinite(input.tokensOut) ? { tokensOut: input.tokensOut } : {}),
      ...(input.text?.trim() ? { excerpt: clampExcerpt(input.text.trim()) } : {}),
    };
    const prefix = needsLeadingNewline(file) ? '\n' : '';
    fs.appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, 'utf8');
    trimIfNeeded(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append one log-only event (D14 #4) — an approval decision or a compaction
 * bracket — to the ledger, interleaved with the steps by `seq`. Best-effort, same
 * append/trim/heal path as a step; returns false rather than throwing.
 */
export function recordTrajectoryEvent(
  workspaceRoot: string,
  sessionKey: string,
  input: TrajectoryEventInput,
): boolean {
  try {
    const file = trajectoryPath(workspaceRoot, sessionKey);
    const record: TrajectoryEvent = {
      kind: 'event',
      seq: nextSeq(file),
      at: input.at ?? new Date().toISOString(),
      event: input.event,
      label: input.label,
      visibility: 'log-only',
      ...(input.detail?.trim() ? { detail: clampExcerpt(input.detail.trim()) } : {}),
      ...(typeof input.droppedMessages === 'number' && Number.isFinite(input.droppedMessages)
        ? { droppedMessages: Math.max(0, Math.round(input.droppedMessages)) }
        : {}),
      ...(typeof input.keptMessages === 'number' && Number.isFinite(input.keptMessages)
        ? { keptMessages: Math.max(0, Math.round(input.keptMessages)) }
        : {}),
    };
    const prefix = needsLeadingNewline(file) ? '\n' : '';
    fs.appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, 'utf8');
    trimIfNeeded(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The most recent `limit` records (steps and log-only events interleaved),
 * newest first. Torn or malformed lines are skipped; a record whose `kind` is
 * `event` is validated on the event arm, everything else on the step arm (a
 * record written before D14 #4 has no `kind` and reads as a step).
 */
export function readTrajectory(workspaceRoot: string, sessionKey: string, limit = 30): TrajectoryRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(trajectoryPath(workspaceRoot, sessionKey), 'utf8');
  } catch {
    return [];
  }
  const out: TrajectoryRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec.kind === 'event') {
        if (typeof rec.seq === 'number' && typeof rec.at === 'string' && isEventKind(rec.event) && typeof rec.label === 'string') {
          out.push({
            kind: 'event',
            seq: rec.seq,
            at: rec.at,
            event: rec.event,
            label: rec.label,
            visibility: 'log-only',
            ...(typeof rec.detail === 'string' ? { detail: rec.detail } : {}),
            ...(typeof rec.droppedMessages === 'number' ? { droppedMessages: rec.droppedMessages } : {}),
            ...(typeof rec.keptMessages === 'number' ? { keptMessages: rec.keptMessages } : {}),
          });
        }
        continue;
      }
      if (
        typeof rec.seq === 'number'
        && typeof rec.model === 'string'
        && typeof rec.at === 'string'
        && Array.isArray(rec.tools)
      ) {
        out.push({
          kind: 'step',
          seq: rec.seq,
          model: rec.model,
          at: rec.at,
          tools: (rec.tools as unknown[])
            .filter((t): t is TrajectoryToolRef => !!t && typeof (t as TrajectoryToolRef).name === 'string')
            .map((t) => ({ name: t.name, intent: isRenderIntent(t.intent) ? t.intent : 'text' })),
          visibility: isVisibility(rec.visibility) ? rec.visibility : 'model-visible',
          ...(typeof rec.effort === 'string' ? { effort: rec.effort } : {}),
          ...(typeof rec.durationMs === 'number' ? { durationMs: rec.durationMs } : {}),
          ...(typeof rec.tokensIn === 'number' ? { tokensIn: rec.tokensIn } : {}),
          ...(typeof rec.tokensOut === 'number' ? { tokensOut: rec.tokensOut } : {}),
          ...(typeof rec.excerpt === 'string' ? { excerpt: rec.excerpt } : {}),
        });
      }
    } catch {
      /* skip malformed / torn line */
    }
  }
  const clamped = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 30;
  return out.slice(Math.max(0, out.length - clamped)).reverse();
}

/**
 * Overlay `shadowed` visibility onto step records that precede the most recent
 * compaction marker — their context was (likely) dropped, so "what the model
 * knew" and "what happened" become separately answerable (D14 #4). Pure and
 * order-agnostic. This is the COARSE, honest read-time rule: compaction keeps a
 * recent tail and reports only counts, and steps do not carry the seq of the
 * messages they produced, so some steps flagged here may in truth still be in
 * context. Precise per-step shadowing needs message→seq stamping (a later slice);
 * this marks the boundary rather than inventing a false-precise per-message map.
 */
export function deriveShadowedTrajectory(records: TrajectoryRecord[]): TrajectoryRecord[] {
  let latestCompactionSeq = -1;
  for (const r of records) {
    if (r.kind === 'event' && r.event === 'compaction' && r.seq > latestCompactionSeq) latestCompactionSeq = r.seq;
  }
  if (latestCompactionSeq < 0) return records;
  return records.map((r) =>
    (r.kind === 'step' && r.seq < latestCompactionSeq && r.visibility === 'model-visible')
      ? { ...r, visibility: 'shadowed' as const }
      : r);
}
