/**
 * ADR-059 — the "Path" block: one ordered account of what the runtime did or
 * observed during a turn — model calls, provider-side activity, guardrail
 * re-prompts, tool calls, and why the turn ended. Collapsed to one summary line;
 * expands to one line per step. Same shape live and after a reload.
 */
import React from 'react';
import type { ChatRow, TurnPathStep } from '../types.js';
import { summarizeTurnPath } from '../lib/agent/turnPathRows.js';

type PathRow = Extract<ChatRow, { kind: 'turn-path' }>;

const KIND_LABEL: Record<TurnPathStep['type'], string> = {
  model: 'model',
  provider: 'provider',
  guard: 'guard',
  tool: 'tool',
  end: 'end',
};

function relTime(at: number, t0: number): string {
  return `+${((at - t0) / 1000).toFixed(1)}s`;
}

function outcomeMark(step: TurnPathStep): string {
  if (step.type === 'tool' && (step as { pending?: boolean }).pending) return '…';
  if (step.ok === undefined) return '';
  return step.ok ? '✓' : '✗';
}

export function TurnPath({ row, live }: { row: PathRow; live?: boolean }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const t0 = row.steps[0]?.at ?? row.ts;
  const summary = summarizeTurnPath(row.steps);
  return (
    <details className={`turn-path${live ? ' live' : ''}`} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="turn-path-summary">
        <span className="turn-path-title">Path</span>
        <span className="turn-path-meta">{summary}</span>
      </summary>
      <ol className="turn-path-steps">
        {row.steps.map((step, i) => {
          const attempt = 'attempt' in step && step.attempt ? ` (${step.attempt.n}/${step.attempt.max})` : '';
          const mark = outcomeMark(step);
          const state = step.type === 'tool' && (step as { pending?: boolean }).pending ? 'pending' : step.ok === false ? 'failed' : step.ok === true ? 'ok' : 'neutral';
          return (
            <li key={`${step.at}-${i}`} className={`turn-path-step ${step.type} ${state}`}>
              <span className="turn-path-time">{relTime(step.at, t0)}</span>
              <span className={`turn-path-kind ${step.type}`}>{KIND_LABEL[step.type]}</span>
              <span className="turn-path-label">{step.label}{attempt}</span>
              {step.detail ? <span className="turn-path-detail" title={step.detail}>{step.detail}</span> : null}
              {mark ? <span className="turn-path-mark">{mark}</span> : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
