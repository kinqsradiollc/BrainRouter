/**
 * ADR-051 D1 — pure Jupyter-notebook (.ipynb) READ renderer: the cell-indexed
 * digest behind `read_file` when the path is a notebook. Kept separate from the
 * Agent so it unit-tests directly (mirrors notebookEdit.ts). JSON string in →
 * human/agent-readable digest string out.
 *
 * The digest turns raw nbformat JSON — escaped source arrays, and outputs that
 * inline BASE64 IMAGES the agent should never pay for — into cells named by the
 * SAME 0-based index `notebook_edit` takes, closing the loop that tool's
 * description promises ("Read the notebook first to get cell indices"). Text
 * outputs are kept (per-output truncation); binary/image outputs are NAMED, not
 * inlined; errors show `ename: evalue` plus a trimmed traceback.
 */

/** Per-output text is capped so one chatty cell can't crowd out the rest of the notebook. */
const MAX_OUTPUT_CHARS = 2000;
/** A traceback is the long tail of an error; keep enough to diagnose, not the whole stack. */
const MAX_TRACEBACK_CHARS = 1500;

/** nbformat stores a cell's / output's text as either a string or an array of lines. */
function joinSource(source: unknown): string {
  if (typeof source === 'string') return source;
  if (Array.isArray(source)) return source.map((l) => (typeof l === 'string' ? l : '')).join('');
  return '';
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… [${text.length - cap} more chars truncated]`;
}

/** Approx byte size of a base64 payload, for naming an image/binary output without inlining it. */
function approxBytesOfBase64(data: unknown): number {
  const s = typeof data === 'string' ? data : Array.isArray(data) ? data.join('') : '';
  // base64 encodes 3 bytes per 4 chars; padding makes this an estimate, which is all we want.
  return Math.floor((s.length * 3) / 4);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `~${Math.round(bytes / 1024)} KB`;
  return `~${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render ONE output (execute_result / display_data / stream / error) as digest lines. */
function renderOutput(output: unknown): string[] {
  if (!output || typeof output !== 'object') return [];
  const o = output as Record<string, unknown>;
  const type = typeof o.output_type === 'string' ? o.output_type : '';

  if (type === 'stream') {
    const name = typeof o.name === 'string' ? o.name : 'stdout';
    return [`  → stream(${name}):`, indent(truncate(joinSource(o.text), MAX_OUTPUT_CHARS))];
  }

  if (type === 'error') {
    const ename = typeof o.ename === 'string' ? o.ename : 'Error';
    const evalue = typeof o.evalue === 'string' ? o.evalue : '';
    const tb = Array.isArray(o.traceback) ? (o.traceback as unknown[]).map((l) => String(l)).join('\n') : '';
    // Tracebacks carry ANSI colour codes; strip them so the digest is plain text.
    const cleanTb = tb.replace(/\[[0-9;]*m/g, '').trim();
    const lines = [`  → error: ${ename}: ${evalue}`.trimEnd()];
    if (cleanTb) lines.push(indent(truncate(cleanTb, MAX_TRACEBACK_CHARS)));
    return lines;
  }

  if (type === 'execute_result' || type === 'display_data') {
    const data = (o.data && typeof o.data === 'object' ? o.data : {}) as Record<string, unknown>;
    const mimes = Object.keys(data);
    if (mimes.length === 0) return [];
    const out: string[] = [];
    for (const mime of mimes) {
      if (mime === 'text/plain') {
        out.push('  → output[text/plain]:', indent(truncate(joinSource(data[mime]), MAX_OUTPUT_CHARS)));
      } else if (mime.startsWith('image/') || mime === 'application/pdf' || mime.startsWith('application/octet-stream')) {
        // NAMED, never inlined — the whole point of the digest.
        out.push(`  → [${mime.startsWith('image/') ? 'image' : 'binary'} output: ${mime}, ${humanSize(approxBytesOfBase64(data[mime]))}]`);
      } else if (mime === 'text/html' || mime === 'text/markdown' || mime.startsWith('application/json')) {
        out.push(`  → output[${mime}]:`, indent(truncate(joinSource(data[mime]), MAX_OUTPUT_CHARS)));
      } else {
        out.push(`  → [output: ${mime}]`);
      }
    }
    return out;
  }

  return [];
}

function indent(text: string): string {
  return text.split('\n').map((l) => `  ${l}`).join('\n');
}

/**
 * Render a notebook's JSON as a cell-indexed digest. Throws if the content is not
 * a valid nbformat notebook (the caller falls back to a raw read).
 */
export function renderNotebookDigest(content: string, opts: { label?: string } = {}): string {
  let nb: { cells?: unknown[]; nbformat?: unknown; nbformat_minor?: unknown } & Record<string, unknown>;
  try {
    nb = JSON.parse(content);
  } catch {
    throw new Error('Notebook is not valid JSON (.ipynb).');
  }
  if (!nb || !Array.isArray(nb.cells)) throw new Error('Notebook has no "cells" array.');
  const cells = nb.cells as Array<Record<string, unknown>>;

  const nbver = typeof nb.nbformat === 'number'
    ? `nbformat ${nb.nbformat}${typeof nb.nbformat_minor === 'number' ? `.${nb.nbformat_minor}` : ''}`
    : 'nbformat unknown';
  const header = `Notebook: ${opts.label ?? 'notebook'} — ${cells.length} cell${cells.length === 1 ? '' : 's'} (${nbver})`;
  const blocks: string[] = [header, ''];

  cells.forEach((cell, i) => {
    const type = typeof cell.cell_type === 'string' ? cell.cell_type : 'code';
    const source = joinSource(cell.source);
    if (type === 'code') {
      const ec = cell.execution_count;
      const execLabel = typeof ec === 'number' ? `executed: ${ec}` : 'unexecuted';
      blocks.push(`[cell ${i}] code (${execLabel})`);
      if (source.trim()) blocks.push(source);
      const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
      const rendered = outputs.flatMap((o) => renderOutput(o));
      if (rendered.length) blocks.push(...rendered);
    } else {
      blocks.push(`[cell ${i}] ${type}`);
      if (source.trim()) blocks.push(source);
    }
    blocks.push('');
  });

  return blocks.join('\n').trimEnd() + '\n';
}
