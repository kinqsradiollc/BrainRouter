/**
 * End-of-turn changeset card in the TRANSCRIPT (Codex-style). Shares the exact
 * visual language of the tool-group header/body (.step / .step-head / .step-body)
 * so "Edited 4 files +X −Y" reads as a sibling of "7 steps · Searched · Read".
 * Distinct from the footer ChangeSummary, which reflects the whole working tree —
 * this one is scoped to a single turn's edits.
 */
import React, { useState } from 'react';
import { Icon } from '../icons.js';
import type { ChangesetFile } from '../types.js';

const MAX_COLLAPSED = 6;

export function ChangesetCard({ files, insertions, deletions, onOpenDiff }: {
  files: ChangesetFile[];
  insertions: number;
  deletions: number;
  onOpenDiff: (path: string) => void;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (!files.length) return null;
  const n = files.length;
  const shown = showAll ? files : files.slice(0, MAX_COLLAPSED);
  const hidden = files.length - shown.length;
  return (
    <div className="step cs-step">
      <button className="step-head tone-edit" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="step-ic"><Icon name="diff" size={12} /></span>
        <span className="step-verb">Edited {n} file{n === 1 ? '' : 's'}</span>
        <span className="step-target cs-head-stat">
          <span className="add-n">+{insertions.toLocaleString()}</span> <span className="del-n">−{deletions.toLocaleString()}</span>
        </span>
        <span className="step-meta"><span className="step-chevron">{open ? '⌄' : '›'}</span></span>
      </button>
      {open ? (
        <div className="step-body">
          {shown.map((f) => {
            const st = (f.status || 'M').trim().slice(0, 1).toUpperCase();
            return (
              <button key={f.path} className="trow cs-file" title={`Open diff · ${f.path}`} onClick={() => onOpenDiff(f.path)}>
                <span className={`cs-badge st-${st.toLowerCase()}`}>{st}</span>
                <span className="cs-path">{f.path}</span>
                <span className="cs-nums">
                  {f.added ? <span className="add-n">+{f.added}</span> : null}
                  {f.removed ? <span className="del-n">−{f.removed}</span> : null}
                </span>
              </button>
            );
          })}
          {hidden > 0 ? (
            <button className="trow cs-more" onClick={() => setShowAll(true)}>
              <span className="cs-more-label">Show {hidden} more file{hidden === 1 ? '' : 's'}</span>
              <span className="step-chevron">⌄</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
