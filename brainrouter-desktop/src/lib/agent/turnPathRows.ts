/**
 * ADR-059 — the turn path as chat rows. Pure: takes the current rows and one
 * step, returns the next rows. A turn's path is ONE `turn-path` row that grows
 * while the turn runs: the runtime's steps (model / provider / guard / end)
 * arrive on `turn-step`; tool calls join it from `tool-start` (pending) and are
 * completed by `tool-end`, so the person reads one ordered account of the turn.
 */
import type { ChatRow, TurnPathStep } from '../../types.js';

type PathRow = Extract<ChatRow, { kind: 'turn-path' }>;

function lastPathRow(rows: ChatRow[]): PathRow | null {
  const last = rows[rows.length - 1];
  return last && last.kind === 'turn-path' ? last : null;
}

/** Append a step to the turn's path row — the last row when it IS the path, else a new one. */
export function appendTurnPathStep(rows: ChatRow[], step: TurnPathStep, id: () => number | string): ChatRow[] {
  const last = lastPathRow(rows);
  if (last) return [...rows.slice(0, -1), { ...last, steps: [...last.steps, step] }];
  return [...rows, { id: id(), kind: 'turn-path', steps: [step], ts: step.at }];
}

/** A tool call has started: a pending tool step, in order with everything else. */
export function toolStartStep(tool: string, args: unknown, callId: string | undefined, at = Date.now()): TurnPathStep {
  return { at, type: 'tool', label: tool, detail: compactArgs(args), ...(callId ? { callId } : {}), pending: true };
}

/** The tool finished: complete its pending step (matched by callId, else by name) in place. */
export function completeToolStep(rows: ChatRow[], input: { tool: string; callId?: string; ok: boolean; summary?: string }, id: () => number | string): ChatRow[] {
  const last = lastPathRow(rows);
  const outcome = (input.summary ?? '').replace(/\s+/g, ' ').trim();
  const detail = outcome.length > 160 ? `${outcome.slice(0, 159)}…` : outcome;
  if (last) {
    let idx = -1;
    for (let i = last.steps.length - 1; i >= 0; i--) {
      const s = last.steps[i];
      if (s.type !== 'tool' || !s.pending) continue;
      if (input.callId ? s.callId === input.callId : s.label === input.tool) { idx = i; break; }
    }
    if (idx >= 0) {
      const steps = last.steps.slice();
      const s = steps[idx] as Extract<TurnPathStep, { type: 'tool' }>;
      steps[idx] = { ...s, ok: input.ok, pending: false, ...(detail ? { detail: `${s.detail ? `${s.detail} → ` : ''}${detail}` } : {}) };
      return [...rows.slice(0, -1), { ...last, steps }];
    }
  }
  // No pending start seen (a reload mid-turn, a background turn): record the outcome alone.
  return appendTurnPathStep(rows, { at: Date.now(), type: 'tool', label: input.tool, ...(detail ? { detail } : {}), ok: input.ok, ...(input.callId ? { callId: input.callId } : {}) }, id);
}

/** One line for the collapsed block: `N steps · <how it ended>` (or `· running`). */
export function summarizeTurnPath(steps: readonly TurnPathStep[]): string {
  const end = [...steps].reverse().find((s) => s.type === 'end');
  const guards = steps.filter((s) => s.type === 'guard').length;
  const tools = steps.filter((s) => s.type === 'tool').length;
  const parts = [`${steps.length} step${steps.length === 1 ? '' : 's'}`];
  if (tools) parts.push(`${tools} tool call${tools === 1 ? '' : 's'}`);
  if (guards) parts.push(`${guards} guardrail${guards === 1 ? '' : 's'}`);
  parts.push(end ? end.label : 'running…');
  return parts.join(' · ');
}

function compactArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  const text = entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
