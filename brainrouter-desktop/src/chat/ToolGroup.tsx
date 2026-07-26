/**
 * A collapsible group of tool calls in the chat thread (Codex-style). Live
 * groups read "Using {tool} ✶"; finished ones get an outcome-phrased label.
 * Each row shows a colour-toned icon + action verb, a CLICKABLE file path
 * (smart-open: edits → Changes/diff, reads → Editor), and an expandable inline
 * diff / preview.
 */
import React, { useState } from 'react';
import type { ChatRow } from '../types.js';
import { toolVisual, basename } from '../lib/chat/toolVisual.js';
import { Icon } from '../icons.js';
import { DiffView } from '../panels/index.js';

export function ToolGroup({ row, live, inlineDiffs, onRequestDiff, onOpenFile, onOpenDiff }: {
  row: Extract<ChatRow, { kind: 'tool-group' }>;
  live?: boolean;
  inlineDiffs: Record<string, string>;
  onRequestDiff: (file: string) => void;
  onOpenFile: (file: string) => void;
  onOpenDiff: (file: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [openItem, setOpenItem] = useState<number | string | null>(null);
  const [diffItem, setDiffItem] = useState<number | string | null>(null);
  const failed = row.items.some((i) => !i.ok);
  // Codex-style header: a colour-toned icon chip + verb + target, instead of a
  // bare dot + "toolname — summary". Single tool → its own visual; a live group
  // → "Using {verb}…" with a spinner; a finished multi-tool group → "N steps"
  // plus the distinct verbs it ran.
  const last = row.items[row.items.length - 1];
  const single = row.items.length === 1 ? row.items[0] : null;
  const headTone = single
    ? toolVisual(single.tool, single.ok ? 'succeeded' : 'failed', single.delegationState).tone
    : 'default';
  let head: React.ReactElement;
  if (live && last) {
    const lv = toolVisual(last.tool, 'pending');
    head = (<>
      <span className="step-ic running"><span className="spinner" /></span>
      <span className="step-verb">{last.child ? `[${last.child}] ` : ''}Using {lv.verb.toLowerCase()}…</span>
    </>);
  } else if (single) {
    const v = toolVisual(single.tool, single.ok ? 'succeeded' : 'failed', single.delegationState);
    const target = single.file ? basename(single.file) : single.summary;
    head = (<>
      <span className="step-ic"><Icon name={v.icon} size={12} /></span>
      <span className="step-verb">{single.child ? `[${single.child}] ` : ''}{v.verb}</span>
      {target ? <span className="step-target">{target}</span> : null}
    </>);
  } else {
    const verbs = [...new Set(row.items.map(
      (i) => toolVisual(i.tool, i.ok ? 'succeeded' : 'failed', i.delegationState).verb,
    ))];
    head = (<>
      <span className="step-ic"><Icon name="spark" size={12} /></span>
      <span className="step-verb">{row.items.length} steps</span>
      <span className="step-target">{verbs.slice(0, 4).join(' · ')}{verbs.length > 4 ? ' …' : ''}</span>
    </>);
  }
  return (
    <div className={`step${failed ? ' step-fail' : ''}${live ? ' step-live' : ''}`}>
      <button className={`step-head tone-${headTone}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {head}
        <span className="step-meta">
          {!live ? <span className={`step-stat ${failed ? 'fail' : 'ok'}`} title={failed ? 'A step failed' : 'All steps succeeded'}>{failed ? '✕' : '✓'}</span> : null}
          <span className="step-chevron">{open ? '⌄' : '›'}</span>
        </span>
      </button>
      {open ? (
        <div className="step-body">
          {row.items.map((t) => {
            const v = toolVisual(t.tool, t.ok ? 'succeeded' : 'failed', t.delegationState);
            const isEdit = v.tone === 'edit';
            const showPathSub = t.file && t.summary && basename(t.file) !== t.summary;
            return (
              <React.Fragment key={t.id}>
                <div className={`trow tone-${v.tone}${t.ok ? '' : ' fail'}`}>
                  <span className="trow-ic"><Icon name={v.icon} size={12} /></span>
                  <span className="trow-verb">{t.child ? `[${t.child}] ` : ''}{v.verb}</span>
                  {t.file ? (
                    <button className="trow-path" title={`Open ${t.file}`} onClick={() => (isEdit ? onOpenDiff(t.file!) : onOpenFile(t.file!))}>{basename(t.file)}</button>
                  ) : (
                    <span className="trow-summary">{t.summary}</span>
                  )}
                  {showPathSub ? <span className="trow-sub">{t.summary}</span> : null}
                  <span className="trow-actions">
                    {t.file ? (
                      <button className="trow-diff" title="Toggle inline diff" onClick={() => {
                        if (diffItem === t.id) { setDiffItem(null); return; }
                        setDiffItem(t.id);
                        if (!inlineDiffs[t.file!]) onRequestDiff(t.file!);
                      }}><Icon name="diff" size={11} /></button>
                    ) : null}
                    {t.preview ? (
                      <button className="trow-exp" title="Show output" onClick={() => setOpenItem(openItem === t.id ? null : t.id)}>
                        <span className="step-chevron">{openItem === t.id ? '⌄' : '›'}</span>
                      </button>
                    ) : null}
                    <span className={`trow-stat ${t.ok ? 'ok' : 'fail'}`} title={t.ok ? 'Succeeded' : 'Failed'}>{t.ok ? '✓' : '✕'}</span>
                  </span>
                </div>
                {openItem === t.id && t.preview ? <pre className="tool-preview">{t.preview}</pre> : null}
                {diffItem === t.id && t.file ? (
                  <div className="inline-diff">
                    {inlineDiffs[t.file] ? <DiffView diff={inlineDiffs[t.file]} /> : <div className="row status"><span className="spinner" /> Loading diff…</div>}
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
