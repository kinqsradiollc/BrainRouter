/**
 * T4 — the bottom dock: terminal shells + panel tabs that drop UP from the
 * window edge. Extracted verbatim from App.tsx; the App owns the panel/tab
 * state (via usePanels) and the panel-body renderer, passed through as props.
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../icons.js';
import { TerminalPanel, PANEL_DEFS, type PanelId } from '../panels/index.js';
import { VIEW_MENU } from '../constants.js';
import type { TermTab } from '../lib/panels/usePanels.js';
import type { PopId } from '../types.js';

type GitInfo = { repo: string; branch: string | null; insertions: number; deletions: number; gitRoot?: string | null; repoRelativePath?: string; isSubdir?: boolean } | null;

export interface TerminalDockProps {
  dockAnim: { mounted: boolean; closing: boolean };
  termDockHeight: number;
  resizeTerminal: (startHeight: number, startY: number, ev: React.PointerEvent) => void;
  termTabs: TermTab[];
  activeTerm: number;
  setActiveTerm: Dispatch<SetStateAction<number>>;
  closeBottomTab: (id: number) => void;
  pop: PopId;
  setPop: Dispatch<SetStateAction<PopId>>;
  addBottomTab: (kind: 'shell' | PanelId) => void;
  setTermDockOpen: Dispatch<SetStateAction<boolean>>;
  tabTitle: (id: PanelId) => string;
  gitInfo: GitInfo;
  renderPanelBody: (id: PanelId) => React.ReactElement | null;
}

export function TerminalDock(p: TerminalDockProps): React.ReactElement | null {
  const { dockAnim, termDockHeight, resizeTerminal, termTabs, activeTerm, setActiveTerm, closeBottomTab, pop, setPop, addBottomTab, setTermDockOpen, tabTitle, gitInfo, renderPanelBody } = p;
  const [dockZoomed, setDockZoomed] = React.useState(false);
  if (!dockAnim.mounted) return null;
  return (
    <div className={`term-dock${dockAnim.closing ? ' closing' : ''}${dockZoomed ? ' zoomed' : ''}`} style={dockZoomed ? undefined : { height: termDockHeight }}>
      <div className="term-dock-grip" title="Drag to resize terminal height"
        onPointerDown={(ev) => resizeTerminal(termDockHeight, ev.clientY, ev)} />
      <div className="term-tabs">
        {termTabs.map((t, i) => {
          const shellNo = termTabs.slice(0, i + 1).filter((x) => x.kind === 'shell').length;
          const manyShells = termTabs.filter((x) => x.kind === 'shell').length > 1;
          const label = t.kind === 'shell'
            ? `${gitInfo?.repo ?? 'shell'}${manyShells ? ` ${shellNo}` : ''}`
            : tabTitle(t.kind);
          const icon = t.kind === 'shell' ? 'terminal' : PANEL_DEFS.find((d) => d.id === t.kind)?.icon ?? 'file';
          return (
            <button key={t.id} className={`term-tab${t.id === activeTerm ? ' active' : ''}`} onClick={() => setActiveTerm(t.id)}>
              <Icon name={icon} size={11} />
              <span className="tab-label">{label}</span>
              <span className="tab-close-btn term-tab-x" role="button" aria-label={`Close ${label}`} title={`Close ${label}`}
                onClick={(ev) => { ev.stopPropagation(); closeBottomTab(t.id); }}><Icon name="close" size={10} /></span>
            </button>
          );
        })}
        <span className="panel-chrome-actions dock-tab-actions">
          <span className="pop-wrap">
            {pop === 'bplus' ? (
              /* drops UP over the chat — the dock is short and sits at the
                 window edge, so a drop-down would run off-screen */
              <div className="menu-pop left">
                <button className="menu-item" onClick={() => { setPop(''); addBottomTab('shell'); }}>
                  <span className="mi-check"><Icon name="terminal" size={13} /></span>New terminal<span className="mi-hint">⌃`</span>
                </button>
                <div className="menu-sep" />
                {VIEW_MENU.map((v) => (
                  <button key={v.id} className="menu-item" onClick={() => { setPop(''); addBottomTab(v.id); }}>
                    <span className="mi-check"><Icon name={v.icon} size={13} /></span>{v.title}
                  </button>
                ))}
              </div>
            ) : null}
            <button className="icon-btn" title="Add tab" onClick={() => setPop(pop === 'bplus' ? '' : 'bplus')}><Icon name="plus" size={12} /></button>
          </span>
          <button className={`icon-btn${dockZoomed ? ' active' : ''}`} title={dockZoomed ? 'Restore bottom panel' : 'Enlarge bottom panel'}
            aria-label={dockZoomed ? 'Restore bottom panel' : 'Enlarge bottom panel'} onClick={() => setDockZoomed((v) => !v)}>
            <Icon name="expand" size={12} />
          </button>
        </span>
        <span className="composer-spacer" />
        <button className="icon-btn" title="Hide panel (⌃`)" onClick={() => setTermDockOpen(false)}><Icon name="close" size={12} /></button>
      </div>
      <div className="term-dock-body">
        {termTabs.filter((t) => t.kind === 'shell').map((t) => (
          <div key={t.id} style={t.id === activeTerm ? { display: 'contents' } : { display: 'none' }}>
            <TerminalPanel />
          </div>
        ))}
        {(() => {
          const active = termTabs.find((t) => t.id === activeTerm);
          return active && active.kind !== 'shell'
            ? <div className="dock-view panel-body" key={active.id}>{renderPanelBody(active.kind)}</div>
            : null;
        })()}
      </div>
    </div>
  );
}
