/**
 * A collapsible group of tool calls in the chat thread. Live groups read
 * "Using {tool} ✶"; finished ones get an outcome-phrased label via the pure,
 * tested toolGroupLabel. Each item can expand its preview and, for file edits,
 * an inline diff.
 */
import React, { useState } from 'react';
import type { ChatRow } from '../types.js';
import { toolGroupLabel } from '../lib/chat/toolGroupLabel.js';
import { DiffView } from '../panels/index.js';

export function ToolGroup({ row, live, inlineDiffs, onRequestDiff }: {
  row: Extract<ChatRow, { kind: 'tool-group' }>;
  live?: boolean;
  inlineDiffs: Record<string, string>;
  onRequestDiff: (file: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [openItem, setOpenItem] = useState<number | null>(null);
  const [diffItem, setDiffItem] = useState<number | null>(null);
  // Observed: live groups read "Using {tool} *"; finished ones get an
  // outcome-phrased label ("Used N tools ›").
  // DESK-6t / item 12 — collapsed label via the pure, tested toolGroupLabel
  // (live "Using X ✶" · single "tool — summary" · multi "N tools · names…").
  const label = toolGroupLabel(row.items, !!live);
  const failed = row.items.some((i) => !i.ok);
  return (
    <div className="step">
      <button className="step-head" onClick={() => setOpen((o) => !o)}>
        <span className={`step-dot ${failed ? 'fail' : 'ok'}`} />
        <span className="step-label">{label}</span>
        <span className="step-chevron">{open ? '⌄' : '›'}</span>
      </button>
      {open ? (
        <div className="step-body">
          {row.items.map((t) => (
            <div key={t.id} className="tool-card-mini">
              <button className="tool-head" onClick={() => t.preview && setOpenItem(openItem === t.id ? null : t.id)}>
                <span className={`step-dot ${t.ok ? 'ok' : 'fail'}`} />
                <span className="tool-name">{t.child ? `[${t.child}] ` : ''}{t.tool}</span>
                <span className="tool-summary">{t.summary}</span>
                {t.file ? (
                  <span className="diff-chip" title="Inspect diff" onClick={(ev) => {
                    ev.stopPropagation();
                    if (diffItem === t.id) { setDiffItem(null); return; }
                    setDiffItem(t.id);
                    if (!inlineDiffs[t.file!]) onRequestDiff(t.file!);
                  }}>±{diffItem === t.id ? ' ⌄' : ''}</span>
                ) : null}
                {t.preview ? <span className="step-chevron">{openItem === t.id ? '⌄' : '›'}</span> : null}
              </button>
              {openItem === t.id && t.preview ? <pre className="tool-preview">{t.preview}</pre> : null}
              {diffItem === t.id && t.file ? (
                <div className="inline-diff">
                  {inlineDiffs[t.file] ? <DiffView diff={inlineDiffs[t.file]} /> : <div className="row status"><span className="spinner" /> Loading diff…</div>}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
