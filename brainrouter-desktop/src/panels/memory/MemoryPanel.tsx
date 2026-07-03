import React, { useState } from 'react';
import { hostQuery } from '../../lib/hostQuery.js';

/**
 * MEMORY PANEL (§5.3) — a first-class desktop surface for the brain memory
 * engine: search the workspace's memories (via the `memory_search` MCP tool) and
 * browse the matched records. Self-contained over the host bridge (hostQuery).
 * Robust to the loose search shape — structured records when available, the raw
 * text otherwise. Create/update/delete + user/workspace/project scopes follow as
 * the brain exposes those tools.
 */

interface MemRecord {
  id?: string;
  type?: string;
  content?: string;
  score?: number;
  source?: string;
  priority?: number;
}
interface SearchResult {
  records?: MemRecord[];
  raw?: string;
  error?: string;
}

export function MemoryPanel(): React.ReactElement {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async (): Promise<void> => {
    if (!query.trim()) return;
    setBusy(true);
    const res = await hostQuery<SearchResult>('memory-search', { query: query.trim() });
    setResult(res ?? { error: 'No response from the brain.' });
    setBusy(false);
  };

  const records = result?.records ?? [];
  return (
    <div className="scroll mem-panel">
      <div className="sched-add">
        <div className="sched-add-row">
          <input
            className="filter"
            placeholder="search the brain memory…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
          />
          <button className="sched-add-btn" disabled={busy || !query.trim()} onClick={() => void search()}>{busy ? '…' : 'Search'}</button>
        </div>
      </div>

      {result?.error ? <div className="mem-error">{result.error} — is the BrainRouter brain connected?</div> : null}
      {result && !result.error && records.length === 0 && !result.raw ? <div className="empty">No memories matched.</div> : null}

      {records.map((m, i) => (
        <div key={m.id ?? i} className="mem-row">
          <div className="mem-row-head">
            {m.type ? <span className="mem-type">{m.type}</span> : null}
            {typeof m.score === 'number' ? <span className="mem-score">{m.score.toFixed(2)}</span> : null}
            {m.source ? <span className="mem-source">{m.source}</span> : null}
            {m.id ? <span className="mem-id">{m.id}</span> : null}
          </div>
          <div className="mem-content">{m.content ?? ''}</div>
        </div>
      ))}

      {result?.raw ? <pre className="mem-raw">{result.raw}</pre> : null}

      <div className="sched-note">Reads the brain memory engine via <code>memory_search</code> (shared with the CLI <code>/memory</code>). Create / update / delete + user/workspace/project scopes follow as the brain exposes them.</div>
    </div>
  );
}
