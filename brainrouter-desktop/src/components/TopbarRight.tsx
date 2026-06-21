/**
 * T4 — the top-right window control cluster (Environment toggle · add view ·
 * side-panel zoom · bottom-panel toggle · side-panel toggle · export · settings).
 * Extracted verbatim from App.tsx; the App owns the state and passes it through.
 * See the placement comment at the call site for why this must be the LAST child of .main.
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../icons.js';
import type { PopId } from '../types.js';
import type { SettingsSection } from '../lib/commands/commands.js';
import { sideRailFullscreenTitle } from '../lib/panels/sideRailLayout.js';
import { VIEW_MENU } from '../constants.js';
import type { PanelId } from '../panels/index.js';

export interface TopbarRightProps {
  /** Workspace mode — the panel toggles only apply to the Code workbench. */
  mode: 'chat' | 'track' | 'code';
  homeMode: boolean;
  envRoom: boolean;
  envOpen: boolean;
  setEnvOpen: Dispatch<SetStateAction<boolean>>;
  q: (id: string, name: string, args?: Record<string, unknown>) => void;
  termDockOpen: boolean;
  setTermDockOpen: Dispatch<SetStateAction<boolean>>;
  sidePanelOpen: boolean;
  setSidePanelOpen: Dispatch<SetStateAction<boolean>>;
  sideFullScreen: boolean;
  setSideFullScreen: Dispatch<SetStateAction<boolean>>;
  sideTabs: PanelId[];
  activeSideTab: PanelId | null;
  ensurePanel: (id: PanelId) => void;
  openBottomDock: () => void;
  pop: PopId;
  setPop: Dispatch<SetStateAction<PopId>>;
  openSettings: (section: SettingsSection) => void;
}

export function TopbarRight(p: TopbarRightProps): React.ReactElement {
  const {
    mode, homeMode, envRoom, envOpen, setEnvOpen, q, termDockOpen, setTermDockOpen,
    sidePanelOpen, setSidePanelOpen, sideFullScreen, setSideFullScreen,
    sideTabs, activeSideTab, ensurePanel, openBottomDock, pop, setPop, openSettings,
  } = p;
  // The Environment / terminal / side-panel toggles only make sense in the Code
  // workbench. Chat and Track have no such panels, so the cluster there is just
  // export + settings (keeping the controls relevant to the current surface).
  const isCode = mode === 'code';
  return (
    <span className="topbar-right">
      {isCode && !homeMode && envRoom ? (
        <button type="button" className={`app-switcher${envOpen ? ' active' : ''}`} title="Environment" onClick={() => {
          if (!envOpen) { q('q-gitlog', 'git-log'); q('q-git', 'git-info'); q('q-branches', 'git-branches'); }
          setEnvOpen((o) => !o);
        }}>
          <Icon name="brain" size={15} />
          <Icon name="chev-down" size={11} />
        </button>
      ) : null}
      {isCode && sidePanelOpen ? (
        <>
          <span className="pop-wrap">
            {pop === 'splus' ? (
              <div className="menu-pop down">
                {VIEW_MENU.map((v) => (
                  <button key={v.id} className="menu-item" onClick={() => { setPop(''); ensurePanel(v.id); }}>
                    <span className="mi-check">{sideTabs.includes(v.id) ? '✓' : <Icon name={v.icon} size={13} />}</span>{v.title}
                    {v.id === activeSideTab ? <span className="mi-hint">active</span> : null}
                  </button>
                ))}
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => { setPop(''); openBottomDock(); }}>
                  <span className="mi-check"><Icon name="terminal" size={13} /></span>Terminal<span className="mi-hint">⌃`</span>
                </button>
              </div>
            ) : null}
            <button type="button" className="top-toggle" title="Add view" onClick={() => setPop(pop === 'splus' ? '' : 'splus')}><Icon name="plus" size={15} /></button>
          </span>
          <button type="button" className={`top-toggle${sideFullScreen ? ' active' : ''}`}
            title={`${sideRailFullscreenTitle(sideFullScreen)} (⌘⇧E)`}
            aria-label={sideRailFullscreenTitle(sideFullScreen)}
            onClick={() => setSideFullScreen((v) => !v)}>
            <Icon name="expand" size={15} />
          </button>
        </>
      ) : null}
      {isCode ? <button type="button" className={`top-toggle${termDockOpen ? ' active' : ''}`} title="Toggle bottom panel (⌃`)" onClick={() => setTermDockOpen((o) => !o)}><Icon name="layout-bottom" size={16} /></button> : null}
      {isCode ? <button type="button" className={`top-toggle${sidePanelOpen ? ' active' : ''}`} title="Toggle side panel (⌥⌘B)" onClick={() => setSidePanelOpen((o) => !o)}><Icon name="sidebar-right" size={16} /></button> : null}
      <button type="button" className="top-toggle" title="Export session" onClick={() => setPop(pop === 'export' ? '' : 'export')}><Icon name="export" size={15} /></button>
      <button type="button" className="top-toggle" title="Settings" onClick={() => openSettings('general')}><Icon name="gear" size={15} /></button>
    </span>
  );
}
