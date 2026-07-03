/**
 * DESK — the Context panel: a LIVE, at-a-glance readout of the current session's
 * runtime. The token total climbs DURING a turn — the session base (`tokens`,
 * set at turn-end) plus the in-flight turn's running usage (`liveTurn`, from the
 * usage-live event, fired after every LLM call) — instead of snapping only when
 * the turn finishes. The context-window bar shows fill vs the auto-compact
 * threshold; the rows pin model / workspace / branch / session / config. Every
 * value is derived from App state — this component performs no fetches.
 */
import React from 'react';
import { Icon } from '../../icons.js';

export interface ContextPanelProps {
  hostUp: boolean;
  running: boolean;
  model?: string;
  workspaceRoot?: string;
  sessionKey?: string;
  gitInfo: { isSubdir?: boolean; gitRoot?: string | null; repo?: string; repoRelativePath?: string } | null;
  branch?: string | null;
  tokens: { promptTokens: number; completionTokens: number; turns: number; cachedTokens?: number } | null;
  liveTurn: { promptTokens: number; completionTokens: number; calls: number; cachedTokens?: number } | null;
  contextUsage: { used: number; window: number; compactAt: number; limit: number; pct: number } | null;
  efficiency: { compactions: number; droppedMessages: number; memoriesRecalled: number };
  bgCount: number;
  configDir: string;
}

const fmt = (n: number): string => n.toLocaleString();
const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

export function ContextPanel(props: ContextPanelProps): React.ReactElement {
  const { hostUp, running, model, workspaceRoot, sessionKey, gitInfo, branch, tokens, liveTurn, contextUsage, bgCount, configDir } = props;
  const efficiency = props.efficiency ?? { compactions: 0, droppedMessages: 0, memoriesRecalled: 0 };

  // LIVE token math — base (session total, pre-current-turn while a turn runs)
  // plus the in-flight turn's cumulative usage. At turn-end the base absorbs the
  // turn and liveTurn clears, so the two never double-count.
  const inTok = (tokens?.promptTokens ?? 0) + (liveTurn?.promptTokens ?? 0);
  const outTok = (tokens?.completionTokens ?? 0) + (liveTurn?.completionTokens ?? 0);
  const total = inTok + outTok;
  const live = running && !!liveTurn;

  // SAVED — what the runtime spared you. Prompt-cache reuse is the concrete token
  // saving (cached input is re-served, not reprocessed); compaction frees context
  // space; memory recall injects relevant context instead of re-explaining.
  const cached = (tokens?.cachedTokens ?? 0) + (liveTurn?.cachedTokens ?? 0);
  const hitPct = inTok > 0 ? Math.round((cached / inTok) * 100) : 0;
  const hasSavings = cached > 0 || efficiency.compactions > 0 || efficiency.memoriesRecalled > 0;

  const cu = contextUsage;
  const fill = cu && cu.window > 0 ? Math.min(1, cu.used / cu.window) : 0;
  const compactMark = cu && cu.window > 0 && cu.compactAt > 0 ? Math.min(1, cu.compactAt / cu.window) : 0;
  const near = fill >= 0.9;

  const wsName = workspaceRoot?.split('/').pop() ?? '—';
  const shortKey = sessionKey ? sessionKey.slice(0, 8) : '';

  return (
    <div className="ctx-panel">
      {/* Status line — host health + a working pulse while a turn runs */}
      <div className="ctx-status">
        <span className={`dot ${hostUp ? 'on' : 'off'}`} />
        <span className="ctx-status-text">{hostUp ? 'Host online' : 'Host starting…'}</span>
        {running ? <span className="ctx-live-pill"><span className="ctx-live-dot" /> working</span> : null}
      </div>

      {/* Tokens — the hero number, LIVE */}
      <div className="ctx-card ctx-tokens">
        <div className="ctx-card-head">
          <span className="ctx-card-title">Tokens</span>
          {live ? <span className="ctx-live-tag"><span className="ctx-live-dot" /> live</span> : null}
        </div>
        <div className="ctx-token-hero">{fmt(total)}<span className="ctx-token-unit">total</span></div>
        <div className="ctx-token-grid">
          <div className="ctx-token-cell"><span className="ctx-tc-arrow">↑</span><span className="ctx-tc-val">{fmt(inTok)}</span><span className="ctx-tc-lbl">in</span></div>
          <div className="ctx-token-cell"><span className="ctx-tc-arrow">↓</span><span className="ctx-tc-val">{fmt(outTok)}</span><span className="ctx-tc-lbl">out</span></div>
          <div className="ctx-token-cell"><span className="ctx-tc-val">{tokens?.turns ?? 0}</span><span className="ctx-tc-lbl">turns</span></div>
          {live && liveTurn ? <div className="ctx-token-cell"><span className="ctx-tc-val">{liveTurn.calls}</span><span className="ctx-tc-lbl">calls</span></div> : null}
        </div>
      </div>

      {/* Saved — cache reuse / compaction / memory recall. Only when there's data. */}
      {hasSavings ? (
        <div className="ctx-card">
          <div className="ctx-card-head"><span className="ctx-card-title">Saved</span></div>
          <div className="ctx-save-rows">
            {cached > 0 ? (
              <div className="ctx-save-row" title="Prompt tokens re-served from the provider cache instead of being reprocessed">
                <span className="ctx-save-label">Prompt cache</span>
                <span className="ctx-save-val"><b>{fmtK(cached)}</b> reused<span className="ctx-save-sub">{hitPct}% hit</span></span>
              </div>
            ) : null}
            {efficiency.compactions > 0 ? (
              <div className="ctx-save-row" title="History compactions that condensed older messages to free context space">
                <span className="ctx-save-label">Compaction</span>
                <span className="ctx-save-val"><b>{efficiency.compactions}×</b><span className="ctx-save-sub">{efficiency.droppedMessages} msgs condensed</span></span>
              </div>
            ) : null}
            {efficiency.memoriesRecalled > 0 ? (
              <div className="ctx-save-row" title="Memories recalled into context instead of re-explaining">
                <span className="ctx-save-label">Memory recall</span>
                <span className="ctx-save-val"><b>{efficiency.memoriesRecalled}</b> records</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Context window — fill vs the model window, with the auto-compact mark */}
      {cu && cu.window > 0 ? (
        <div className="ctx-card">
          <div className="ctx-card-head">
            <span className="ctx-card-title">Context window</span>
            <span className={`ctx-pct ${near ? 'warn' : ''}`}>{Math.round(fill * 100)}%</span>
          </div>
          <div className="ctx-bar">
            <div className={`ctx-bar-fill ${near ? 'warn' : ''}`} style={{ width: `${fill * 100}%` }} />
            {compactMark > 0 && compactMark < 1 ? <div className="ctx-bar-mark" style={{ left: `${compactMark * 100}%` }} title={`Auto-compact at ${fmt(cu.compactAt)} tokens`} /> : null}
          </div>
          <div className="ctx-bar-foot">
            <span>{fmtK(cu.used)} / {fmtK(cu.window)}</span>
            {cu.compactAt > 0 ? <span>compact at {fmtK(cu.compactAt)}</span> : null}
          </div>
        </div>
      ) : null}

      {/* Environment rows */}
      <div className="ctx-rows">
        <Row label="Model" value={model ?? '—'} mono />
        <Row label="Workspace" value={wsName} title={workspaceRoot} />
        {branch ? <Row label="Branch" value={branch} icon="branch" /> : null}
        {gitInfo?.isSubdir && gitInfo.repo ? (
          <Row label="Git repo" value={`${gitInfo.repo}${gitInfo.repoRelativePath ? ` / ${gitInfo.repoRelativePath}` : ''}`} title={gitInfo.gitRoot ?? undefined} />
        ) : null}
        {bgCount > 0 ? <Row label="Background" value={`${bgCount} ${bgCount === 1 ? 'agent' : 'agents'} running`} /> : null}
        {shortKey ? (
          <div className="ctx-row">
            <span className="ctx-row-label">Session</span>
            <span className="ctx-row-value mono ctx-row-copy" title={sessionKey}>
              {shortKey}…
              <button className="icon-btn" title="Copy session id" onClick={() => void navigator.clipboard.writeText(sessionKey ?? '')}><Icon name="copy" size={10} /></button>
            </span>
          </div>
        ) : null}
        <Row label="Config" value={configDir} mono title={configDir} />
      </div>
    </div>
  );
}

function Row({ label, value, title, mono, icon }: { label: string; value: string; title?: string; mono?: boolean; icon?: string }): React.ReactElement {
  return (
    <div className="ctx-row">
      <span className="ctx-row-label">{label}</span>
      <span className={`ctx-row-value ${mono ? 'mono' : ''}`} title={title ?? value}>
        {icon ? <Icon name={icon} size={11} /> : null}{value}
      </span>
    </div>
  );
}
