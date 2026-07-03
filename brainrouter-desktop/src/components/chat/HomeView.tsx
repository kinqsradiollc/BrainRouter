/** DESK-4d — the greeting/home view shown on an empty session. */
import React from 'react';
import { fmtAge } from '../../lib/format.js';
import { sendReleaseNotes } from '../../lib/releaseNotes.js';

export function HomeView({ username, stats, tab, setTab, range, setRange, model, provider, repo, recents, onResume }: {
  username?: string;
  repo?: string;
  recents?: Array<{ sessionKey: string; firstUserMessage?: string; modifiedAt?: string }>;
  onResume?: (key: string) => void;
  stats: { sessions: number; turns: number; activeDays: number; currentStreak: number; longestStreak: number; model: string; perDay: Record<string, number> } | null;
  tab: 'overview' | 'models';
  setTab: (t: 'overview' | 'models') => void;
  range: 'all' | '30d' | '7d';
  setRange: (r: 'all' | '30d' | '7d') => void;
  model?: string;
  provider?: string;
}): React.ReactElement {
  const name = username ? username.charAt(0).toUpperCase() + username.slice(1) : 'there';
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 119;
  const cells: Array<{ day: string; n: number }> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    cells.push({ day: key, n: stats?.perDay[key] ?? 0 });
  }
  const inRange = cells.filter((c) => c.n > 0);
  const turnsInRange = cells.reduce((s, c) => s + c.n, 0);
  const lvl = (n: number) => (n === 0 ? '' : n <= 2 ? ' h1' : n <= 5 ? ' h2' : ' h3');
  return (
    <div className="home">
      <div className="home-greet">
        <span className="spark">✺</span>
        <span>{repo ? `What should we build in ${repo}?` : `What's up next, ${name}?`}</span>
        <span className="whatsnew" onClick={() => sendReleaseNotes()}>What's new</span>
      </div>
      <div className="stats-card">
        <div className="stats-head">
          <div className="seg">
            <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
            <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>Models</button>
          </div>
          <div className="seg">
            {(['all', '30d', '7d'] as const).map((r) => (
              <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>{r === 'all' ? 'All' : r}</button>
            ))}
          </div>
        </div>
        {tab === 'overview' ? (
          <>
            <div className="stat-grid">
              <div className="stat-card"><div className="stat-label">Sessions</div><div className="stat-value">{stats?.sessions ?? 0}</div></div>
              <div className="stat-card"><div className="stat-label">Turns</div><div className="stat-value">{range === 'all' ? stats?.turns ?? 0 : turnsInRange}</div></div>
              <div className="stat-card"><div className="stat-label">Active days</div><div className="stat-value">{range === 'all' ? stats?.activeDays ?? 0 : inRange.length}</div></div>
              <div className="stat-card"><div className="stat-label">Streak</div><div className="stat-value">{stats?.currentStreak ?? 0}d <span className="stat-sub">· best {stats?.longestStreak ?? 0}d</span></div></div>
            </div>
            <div className="heatmap" title="Turns per day">
              {cells.map((c) => <span key={c.day} className={`heat-cell${lvl(c.n)}`} title={`${c.day}: ${c.n}`} />)}
            </div>
          </>
        ) : (
          <div className="stat-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="stat-card"><div className="stat-label">Active model</div><div className="stat-value" style={{ fontSize: 14 }}>{model ?? '—'}</div></div>
            <div className="stat-card"><div className="stat-label">Provider</div><div className="stat-value" style={{ fontSize: 14 }}>{provider ?? '—'}</div></div>
          </div>
        )}
      </div>
      {recents && recents.length ? (
        <div className="home-recents">
          <div className="rail-section" style={{ margin: '0 0 6px' }}>Pick up where you left off</div>
          {recents.slice(0, 3).map((r) => (
            <button key={r.sessionKey} className="home-recent" onClick={() => onResume?.(r.sessionKey)}>
              <span className="session-dot" />
              <span className="hr-title">{r.firstUserMessage || r.sessionKey}</span>
              {r.modifiedAt ? <span className="session-age">{fmtAge(r.modifiedAt)}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
