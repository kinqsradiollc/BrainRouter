/**
 * DESK-4h — the inspect-diff: unified-diff parser + per-hunk cards (observed:
 * clicking "Edited f +6 -4" expands hunk cards with a path bar, line-number
 * gutter, and red/green tinted blocks). Reused by the Changes panel, the
 * worktree diffs, and the review patch preview.
 */
import React, { useMemo } from 'react';

export interface DiffLine { type: 'ctx' | 'add' | 'del' | 'meta'; oldNo: number | null; newNo: number | null; text: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile { path: string; hunks: DiffHunk[]; adds: number; dels: number }

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0, newNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      file = { path: '', hunks: [], adds: 0, dels: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '').trim();
      if (!file) { file = { path: '', hunks: [], adds: 0, dels: 0 }; files.push(file); }
      if (p !== '/dev/null') file.path = p;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4).replace(/^a\//, '').trim();
      if (file && !file.path && p !== '/dev/null') file.path = p;
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) {
      if (!file) { file = { path: '', hunks: [], adds: 0, dels: 0 }; files.push(file); }
      oldNo = Number(m[1]); newNo = Number(m[2]);
      hunk = { header: m[3].trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || !file) continue;
    if (line.startsWith('+')) { hunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) }); file.adds++; }
    else if (line.startsWith('-')) { hunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) }); file.dels++; }
    else if (line.startsWith('\\')) { hunk.lines.push({ type: 'meta', oldNo: null, newNo: null, text: line }); }
    else { hunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.startsWith(' ') ? line.slice(1) : line }); }
  }
  return files.filter((f) => f.hunks.length);
}

export function DiffView({ diff }: { diff: string }): React.ReactElement {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (!files.length) return <div className="empty center-empty">No changes to show</div>;
  return (
    <div className="diffview">
      {files.map((f, fi) => f.hunks.map((h, hi) => (
        <div key={`${fi}-${hi}`} className="hunk-card">
          <div className="hunk-path" title={f.path}>
            <span className="path-text">{f.path}{h.header ? `  ·  ${h.header}` : ''}</span>
            {hi === 0 ? <span className="hunk-stats"><span className="add-n">+{f.adds}</span> <span className="del-n">-{f.dels}</span></span> : null}
          </div>
          <div className="hunk-lines">
            {h.lines.map((l, li) => (
              <div key={li} className={`hunk-line ${l.type}`}>
                <span className="hno">{l.oldNo ?? ''}</span>
                <span className="hno">{l.newNo ?? ''}</span>
                <span className="hmark">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
                <span className="htext">{l.text || ' '}</span>
              </div>
            ))}
          </div>
        </div>
      )))}
    </div>
  );
}
