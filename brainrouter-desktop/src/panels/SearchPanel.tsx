/** The Search session panel: searches the persisted transcript — same as /find in the CLI. */
import React, { useState } from 'react';

export interface SearchHit { index: number; role: string; snippet: string }

export function SearchPanel({ hits, onSearch }: {
  hits: SearchHit[] | null;
  onSearch: (q: string) => void;
}): React.ReactElement {
  const [q, setQ] = useState('');
  return (
    <>
      <input className="filter" placeholder="Search this session…  (Enter)" value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) onSearch(q.trim()); }} />
      <div className="scroll">
        {hits === null ? <div className="empty">Searches the persisted transcript — same as /find in the CLI.</div>
          : hits.length === 0 ? <div className="empty">No matches.</div>
          : hits.map((h, i) => (
            <div key={i} className="search-hit">
              <div className="search-role">{h.role} · #{h.index}</div>
              <div className="search-snippet">{h.snippet}</div>
            </div>
          ))}
      </div>
    </>
  );
}
