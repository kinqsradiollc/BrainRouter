/** Empty-session workspace home. It orients around the active task and project. */
import React from 'react';
import { fmtAge } from '../../lib/format.js';
import { sendReleaseNotes } from '../../lib/releaseNotes.js';
import { Icon } from '../../icons.js';
import type { PanelId } from '../../panels/Panel.js';

type Mode = 'chat' | 'track' | 'code' | 'meetings';

export function HomeView(props: {
  username?: string;
  repo?: string;
  recents?: Array<{ sessionKey: string; firstUserMessage?: string; modifiedAt?: string }>;
  onResume?: (key: string) => void;
  onMode: (mode: Mode) => void;
  onStartBuild: () => void;
  onOpenView: (panel: PanelId) => void;
  stats: { sessions: number; turns: number; activeDays: number; currentStreak: number; longestStreak: number; model: string; perDay: Record<string, number> } | null;
  tab: 'overview' | 'models';
  setTab: (tab: 'overview' | 'models') => void;
  range: 'all' | '30d' | '7d';
  setRange: (range: 'all' | '30d' | '7d') => void;
  model?: string;
  provider?: string;
}): React.ReactElement {
  const name = props.username ? props.username.charAt(0).toUpperCase() + props.username.slice(1) : 'there';
  const project = props.repo || 'your workspace';
  const recents = props.recents?.slice(0, 3) ?? [];

  return (
    <section className="home">
      <div className="home-kicker-row">
        <span className="home-kicker"><i /> Workspace / <strong>{project}</strong></span>
        <button type="button" className="whatsnew" onClick={() => sendReleaseNotes()}>What&apos;s new</button>
      </div>
      <div className="home-greet">
        <h1>Welcome back, {name}.</h1>
        <p>Choose an action to continue working in {project}.</p>
      </div>

      <div className="home-mode-grid" aria-label="Start a workspace mode">
        <button type="button" className="home-mode-card tone-build primary" data-mode="code" onClick={props.onStartBuild}>
          <em aria-hidden="true">01</em><span><Icon name="code" size={15} /></span><strong>Build</strong><small>Change code, run commands, and verify the result in this workspace.</small><b>Open Code <span aria-hidden="true">→</span></b>
        </button>
        <button type="button" className="home-mode-card tone-plan" data-mode="track" onClick={() => props.onMode('track')}>
          <em aria-hidden="true">02</em><span><Icon name="tasks" size={15} /></span><strong>Plan</strong><small>Turn an outcome into work that can be reviewed and delivered.</small><b>Open Track <span aria-hidden="true">→</span></b>
        </button>
        <button type="button" className="home-mode-card tone-explore" data-mode="chat" onClick={() => props.onMode('chat')}>
          <em aria-hidden="true">03</em><span><Icon name="bubble" size={15} /></span><strong>Explore</strong><small>Inspect the project and work through an option before changing files.</small><b>Open Chat <span aria-hidden="true">→</span></b>
        </button>
        <button type="button" className="home-mode-card tone-plan" data-mode="meetings" onClick={() => props.onMode('meetings')}>
          <em aria-hidden="true">04</em><span><Icon name="mic" size={15} /></span><strong>Capture</strong><small>Record a decision or turn a transcript into an accountable next step.</small><b>Open Meetings <span aria-hidden="true">→</span></b>
        </button>
      </div>

      <div className="home-context-strip" aria-label="Workspace context">
        <span className="home-context-label">Workspace signals</span>
        <button type="button" className="tone-files" onClick={() => props.onOpenView('files')}><Icon name="folder" size={13} /><span><strong>Project files</strong><small>Browse the workspace</small></span><b>→</b></button>
        <button type="button" className="tone-knowledge" onClick={() => props.onOpenView('memory')}><Icon name="pin" size={13} /><span><strong>Saved knowledge</strong><small>Find useful context</small></span><b>→</b></button>
        {/* ADR-028 G5 — one destination, named once. This said "Review" and the
            view links below said "Checks"; both opened the same consolidated
            panel, which is the fragmentation G5 removed reappearing as two
            labels for one place. */}
        <button type="button" className="tone-review" onClick={() => props.onOpenView('stack')}><Icon name="review" size={13} /><span><strong>Pull request</strong><small>Checks and review findings before it ships</small></span><b>→</b></button>
      </div>

      <div className="home-lower-grid">
        <div className="home-recent-panel">
          <div className="home-panel-head"><span>Continue recent work</span><small>{props.stats?.sessions ?? 0} sessions</small></div>
          {recents.length ? recents.map((recent) => (
            <button key={recent.sessionKey} className="home-recent" onClick={() => props.onResume?.(recent.sessionKey)}>
              <span className="session-dot" />
              <span className="hr-title">{recent.firstUserMessage || recent.sessionKey}</span>
              {recent.modifiedAt ? <span className="session-age">{fmtAge(recent.modifiedAt)}</span> : null}
            </button>
          )) : <div className="home-empty">Your recent tasks will appear here.</div>}
        </div>

        <div className="home-view-panel">
          <div className="home-panel-head"><span>Open a workspace view</span><small>{props.model ?? 'Default model'}</small></div>
          <div className="home-view-links">
            <button type="button" className="tone-plan" onClick={() => props.onOpenView('plan')}><Icon name="plan" size={13} />Plan</button>
            <button type="button" className="tone-tasks" onClick={() => props.onOpenView('tasks')}><Icon name="tasks" size={13} />Tasks</button>
            <button type="button" className="tone-automation" onClick={() => props.onOpenView('workflows')}><Icon name="bolt" size={13} />Workflows</button>
            <button type="button" className="tone-review" onClick={() => props.onOpenView('comprehension')}><Icon name="brain" size={13} />Understand</button>
          </div>
          <div className="home-signal-row">
            <span><b>{props.stats?.turns ?? 0}</b> turns</span>
            <span><b>{props.stats?.activeDays ?? 0}</b> active days</span>
            <span><b>{props.provider ?? 'local'}</b> provider</span>
          </div>
        </div>
      </div>
    </section>
  );
}
