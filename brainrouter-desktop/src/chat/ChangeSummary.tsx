/**
 * End-of-turn change summary card (Codex-style): "N files changed +X −Y" with a
 * collapsible file list (each row opens that file's diff) and a Review action.
 * Replaces the single-line "N files changed — view diff" bar.
 */
import React, { useState } from 'react';
import { Icon } from '../icons.js';
import type { PanelId } from '../panels/Panel.js';

export function ChangeSummary({ gitInfo, changedFiles, ensurePanel, q }: {
  gitInfo: { branch: string | null; insertions: number; deletions: number } | null;
  changedFiles: Array<{ status: string; path: string }>;
  ensurePanel: (id: PanelId) => void;
  q: (id: string, name: string, args?: Record<string, unknown>) => void;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!gitInfo?.branch) return null;
  const total = (gitInfo.insertions ?? 0) + (gitInfo.deletions ?? 0);
  if (total === 0) return null;
  const n = changedFiles.length;
  return (
    <div className={`change-card${open ? ' open' : ''}`}>
      <button className="change-head" onClick={() => setOpen((o) => !o)}>
        <span className="change-ic"><Icon name="diff" size={13} /></span>
        <span className="change-title">{n} file{n === 1 ? '' : 's'} changed</span>
        <span className="change-stat"><span className="add-n">+{gitInfo.insertions.toLocaleString()}</span> <span className="del-n">−{gitInfo.deletions.toLocaleString()}</span></span>
        <span className="change-actions">
          <span className="change-btn" role="button" title="Open the Pull request panel — checks and review findings" onClick={(e) => { e.stopPropagation(); ensurePanel('stack'); }}>Review</span>
          <span className="step-chevron">{open ? '⌄' : '›'}</span>
        </span>
      </button>
      {open ? (
        <div className="change-files">
          {changedFiles.map((f) => {
            const st = (f.status || 'M').trim().slice(0, 1).toUpperCase();
            return (
              <button key={f.path} className="change-file" title={`Open diff · ${f.path}`} onClick={() => { ensurePanel('diff'); q('q-diff', 'file-diff', { path: f.path }); }}>
                <span className={`change-status st-${st.toLowerCase()}`}>{st}</span>
                <span className="change-path">{f.path}</span>
                <Icon name="diff" size={11} />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
