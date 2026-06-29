import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * WRITE MODE (§2 W1) — a Markdown writing workspace: a file tree of the
 * workspace's prose files, an editor, and a live Markdown preview (edit / split /
 * preview), with save. Self-contained: it talks to the host directly via a
 * promise-wrapped query (the same `list-files` / `file-read` queries the Files
 * and Editor panels use, plus a `write-save` that goes through the guarded
 * `writeWorkspaceEntry`). The editor is a textarea for this slice; Monaco/
 * CodeMirror syntax highlighting + the diff-review (W2) layer on top.
 */

const WRITABLE = /\.(md|markdown|mdx|txt|text)$/i;

/** Promise-wrapped host query over the existing send/onEvent bridge (matches by id). */
function hostQuery<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  return new Promise((resolve) => {
    const br = (window as unknown as { brainrouter?: { send?: (c: unknown) => void; onEvent?: (l: (m: unknown) => void) => () => void } }).brainrouter;
    if (!br?.send || !br?.onEvent) { resolve(null); return; }
    const id = `wq_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let settled = false;
    const off = br.onEvent((msg: unknown) => {
      // Events are wrapped in an envelope: { seq, ts, sessionKey, event, workspaceRoot }.
      const ev = (msg as { event?: { kind?: string; id?: string; ok?: boolean; result?: unknown } })?.event;
      if (ev?.kind === 'query-result' && ev.id === id) {
        settled = true;
        off();
        resolve(ev.ok ? (ev.result as T) : null);
      }
    });
    br.send({ kind: 'query', id, name, args: args ?? {} });
    setTimeout(() => { if (!settled) { off(); resolve(null); } }, 8000);
  });
}

type ViewMode = 'edit' | 'split' | 'preview';

export function WritePanel(): React.ReactElement {
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(''); // last-saved content, for the dirty check
  const [view, setView] = useState<ViewMode>('split');
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState('');

  const dirty = content !== loaded;

  const refreshFiles = useCallback(async () => {
    const res = await hostQuery<{ files?: Array<string | { path?: string }> }>('list-files', { limit: 3000 });
    const paths = (res?.files ?? [])
      .map((f) => (typeof f === 'string' ? f : f.path ?? ''))
      .filter((p) => p && WRITABLE.test(p))
      .sort((a, b) => a.localeCompare(b));
    setFiles(paths);
  }, []);

  useEffect(() => { void refreshFiles(); }, [refreshFiles]);

  const openFile = useCallback(async (p: string) => {
    setPath(p);
    setStatus('Loading…');
    const res = await hostQuery<{ content?: string; error?: string; binary?: boolean }>('file-read', { path: p });
    if (!res || res.error || res.binary) {
      setContent('');
      setLoaded('');
      setStatus(res?.error ? `Could not open: ${res.error}` : 'Could not open this file.');
      return;
    }
    setContent(res.content ?? '');
    setLoaded(res.content ?? '');
    setStatus('');
  }, []);

  const save = useCallback(async () => {
    if (!path) return;
    setStatus('Saving…');
    const res = await hostQuery<{ ok?: boolean; error?: string }>('write-save', { path, content });
    if (res?.ok) {
      setLoaded(content);
      setStatus('Saved.');
      void refreshFiles();
    } else {
      setStatus(`Save failed${res?.error ? `: ${res.error}` : ''}.`);
    }
  }, [path, content, refreshFiles]);

  // Cmd/Ctrl-S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const visibleFiles = useMemo(
    () => (filter ? files.filter((f) => f.toLowerCase().includes(filter.toLowerCase())) : files),
    [files, filter],
  );

  return (
    <div className="write-panel">
      <div className="write-tree">
        <input className="filter" placeholder="filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="write-files scroll">
          {visibleFiles.length === 0 ? <div className="empty">No Markdown/text files.</div> : visibleFiles.map((f) => (
            <button key={f} className={`write-file-row${f === path ? ' active' : ''}`} onClick={() => void openFile(f)} title={f}>
              {f.split('/').pop()}
              <span className="write-file-dir">{f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="write-main">
        <div className="write-bar">
          <span className="write-path">{path ? `${path}${dirty ? ' •' : ''}` : 'Select a file to write'}</span>
          <div className="write-bar-right">
            {(['edit', 'split', 'preview'] as ViewMode[]).map((m) => (
              <button key={m} className={`seg-toggle${view === m ? ' active' : ''}`} onClick={() => setView(m)}>{m}</button>
            ))}
            <button className="sched-add-btn" disabled={!path || !dirty} onClick={() => void save()}>Save</button>
          </div>
        </div>

        <div className={`write-body view-${view}`}>
          {view !== 'preview' ? (
            <textarea
              className="write-editor"
              value={content}
              spellCheck
              placeholder={path ? '' : 'Open a file from the list to start writing.'}
              onChange={(e) => setContent(e.target.value)}
              disabled={!path}
            />
          ) : null}
          {view !== 'edit' ? (
            <div className="write-preview scroll">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || '_Nothing to preview yet._'}</ReactMarkdown>
            </div>
          ) : null}
        </div>

        {status ? <div className="write-status">{status}</div> : null}
      </div>
    </div>
  );
}
