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
 * Not yet in this vertical (documented follow-ups): turn-grouping of steps, the
 * fixed timeline overview with TTFT-vs-decode spans, tool-result durations
 * (measured at the batch-execution site), and the distinct log-only / shadowed
 * emit points (approvals, compaction) that populate the visibility field beyond
 * `model-visible`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionStateDir } from '../../storage/store.js';

const TRAJECTORY_FILE = 'trajectory.jsonl';
/** Self-trim ceiling; the newest records are kept when the file grows past it. */
const MAX_RECORDS = 500;
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
 * Whether a record entered model context. This vertical only emits
 * `model-visible` step records; the `log-only` (commands / approvals / feedback)
 * and `shadowed` (dropped by compaction) markers are later emit points, but the
 * field is carried now so the reader and the UI legend are stable.
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
  /** Monotonic per-session step index (survives self-trim). */
  seq: number;
  /** The model that answered. */
  model: string;
  /** Reasoning effort in force for the call, when known. */
  effort?: string;
  /** ISO timestamp when the call started. */
  at: string;
  /** Wall-clock duration of the model call in ms. */
  durationMs?: number;
  /** Prompt tokens the request carried, when the provider reported usage. */
  tokensIn?: number;
  /** Completion tokens the response carried, when reported. */
  tokensOut?: number;
  /** The tools this step requested, each with its render intent (may be empty). */
  tools: TrajectoryToolRef[];
  /** Bounded excerpt of the step's assistant text (empty on a pure tool turn). */
  excerpt?: string;
  /** This vertical always records `model-visible`. */
  visibility: RecordVisibility;
}

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

function trajectoryPath(workspaceRoot: string, sessionKey: string): string {
  return path.join(getSessionStateDir(workspaceRoot, sessionKey), TRAJECTORY_FILE);
}

const clampExcerpt = (text: string): string =>
  text.length <= MAX_EXCERPT_CHARS ? text : `${text.slice(0, MAX_EXCERPT_CHARS)}…`;

const isRenderIntent = (v: unknown): v is RenderIntent =>
  typeof v === 'string' && (RENDER_INTENTS as readonly string[]).includes(v);
const isVisibility = (v: unknown): v is RecordVisibility =>
  typeof v === 'string' && (VISIBILITIES as readonly string[]).includes(v);

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

/** Rewrite the file keeping only the newest MAX_RECORDS lines. Best-effort. */
function trimIfNeeded(file: string): void {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length <= MAX_RECORDS) return;
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
 * The most recent `limit` steps, newest first. Torn or malformed lines are
 * skipped. Empty when the session has no trajectory ledger yet.
 */
export function readTrajectory(workspaceRoot: string, sessionKey: string, limit = 30): TrajectoryStep[] {
  let raw: string;
  try {
    raw = fs.readFileSync(trajectoryPath(workspaceRoot, sessionKey), 'utf8');
  } catch {
    return [];
  }
  const out: TrajectoryStep[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Partial<TrajectoryStep>;
      if (
        typeof rec.seq === 'number'
        && typeof rec.model === 'string'
        && typeof rec.at === 'string'
        && Array.isArray(rec.tools)
      ) {
        out.push({
          seq: rec.seq,
          model: rec.model,
          at: rec.at,
          tools: rec.tools
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
  const clamped = Math.max(1, Math.floor(limit));
  return out.slice(Math.max(0, out.length - clamped)).reverse();
}
