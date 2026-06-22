/**
 * §2 — turn a finding's verbatim code into PR-review rows: a code excerpt or a
 * (possibly loose) unified-diff hunk → classified lines with line numbers, so
 * the panel can render a real mini diff/code frame (red problem/removed, green
 * suggested/added, neutral context) instead of prose. Pure + unit-tested; the
 * ReviewCodeFrame component just maps these rows to styled <div>s.
 */
export type CodeRowKind = 'ctx' | 'problem' | 'del' | 'add' | 'meta';
export interface CodeRow { kind: CodeRowKind; text: string; lineNo?: number }

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse a unified-diff hunk (with or without an @@ header) into rows. `+`→add,
 *  `-`→del, `@@`→meta, anything else→context. Line numbers track from the
 *  header when present (add/context advance the new-file counter). */
export function parseHunk(hunk: string): CodeRow[] {
  const out: CodeRow[] = [];
  let newNo: number | undefined;
  for (const raw of hunk.replace(/\r\n/g, '\n').split('\n')) {
    const h = HUNK_HEADER.exec(raw);
    if (h) { newNo = Number(h[2]); out.push({ kind: 'meta', text: raw }); continue; }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ')) { out.push({ kind: 'meta', text: raw }); continue; }
    if (raw.startsWith('+')) { out.push({ kind: 'add', text: raw.slice(1), lineNo: newNo }); if (newNo != null) newNo++; continue; }
    if (raw.startsWith('-')) { out.push({ kind: 'del', text: raw.slice(1) }); continue; }
    if (raw === '') { out.push({ kind: 'ctx', text: '' }); continue; }
    out.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, lineNo: newNo }); if (newNo != null) newNo++;
  }
  return out;
}

/** Build rows from a verbatim code excerpt, numbering from `startLine` and
 *  marking the [problemStart, problemEnd] range as the problem (red). */
export function excerptRows(excerpt: string, startLine?: number, problemStart?: number, problemEnd?: number): CodeRow[] {
  const lines = excerpt.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const pStart = problemStart ?? startLine;
  const pEnd = problemEnd ?? pStart;
  return lines.map((text, i) => {
    const lineNo = startLine != null ? startLine + i : undefined;
    const isProblem = lineNo != null && pStart != null && lineNo >= pStart && lineNo <= (pEnd ?? pStart);
    return { kind: isProblem ? 'problem' : 'ctx', text, lineNo };
  });
}

/** Best code view for a finding: the diff hunk if present, else the excerpt
 *  (with the suggestion appended as added lines when it looks like code). */
export function findingRows(f: { codeExcerpt?: string; diffHunk?: string; line?: number; endLine?: number; suggestion?: string }): CodeRow[] {
  if (f.diffHunk && f.diffHunk.trim()) return parseHunk(f.diffHunk);
  if (f.codeExcerpt && f.codeExcerpt.trim()) {
    const rows = excerptRows(f.codeExcerpt, f.line, f.line, f.endLine);
    // If the suggestion reads like code (has a newline or looks like a statement), show it as added lines.
    if (f.suggestion && /[\n;{}()=]/.test(f.suggestion)) {
      for (const t of f.suggestion.replace(/\n$/, '').split('\n')) rows.push({ kind: 'add', text: t });
    }
    return rows;
  }
  return [];
}
