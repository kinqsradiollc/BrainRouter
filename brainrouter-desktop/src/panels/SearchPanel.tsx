/** The Search session panel: searches the persisted transcript — same as /find in the CLI. */
import React, { useState } from 'react';
import { Icon } from '../icons.js';

export interface SearchHit { index: number; role: string; snippet: string }

export function SearchPanel({ hits, onSearch }: {
  hits: SearchHit[] | null;
  onSearch: (q: string) => void;
}): React.ReactElement {
  const [q, setQ] = useState('');
  const submit = (): void => {
    const query = q.trim();
    if (query) onSearch(query);
  };
  return (
    <div className="search-panel">
      <form className="search-box" role="search" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Icon name="search" size={14} />
        <input className="search-input" placeholder="Search session transcript" value={q}
          onChange={(e) => setQ(e.target.value)} />
        <button className="search-submit" type="submit" disabled={!q.trim()} title="Search" aria-label="Search">
          <Icon name="arrow-right" size={13} />
        </button>
      </form>
      {hits ? <div className="search-meta">{hits.length} result{hits.length === 1 ? '' : 's'}</div> : null}
      <div className="scroll search-results">
        {hits === null ? (
          <div className="empty search-empty">
            <Icon name="search" size={16} />
            <span className="empty-title">No search yet</span>
            <span className="empty-note">Search the saved transcript for messages, tools, and replies.</span>
          </div>
        )
          : hits.length === 0 ? <div className="empty search-empty">No matches.</div>
          : hits.map((h, i) => (
            <div key={i} className="search-hit">
              <div className="search-role">{h.role} · #{h.index}</div>
              <div className="search-snippet">{h.snippet}</div>
            </div>
          ))}
      </div>
    </div>
  );
}
