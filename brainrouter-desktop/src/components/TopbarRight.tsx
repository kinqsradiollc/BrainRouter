/**
 * T4 — the top-right window control cluster (Environment toggle · bottom-panel
 * toggle · side-panel toggle · export · settings). Extracted verbatim from
 * App.tsx; the App owns the state and passes it through. See the placement
 * comment at the call site for why this must be the LAST child of .main.
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../icons.js';
import type { PopId } from '../types.js';
import type { SettingsSection } from '../lib/commands/commands.js';

export interface TopbarRightProps {
  homeMode: boolean;
  envRoom: boolean;
  envOpen: boolean;
  setEnvOpen: Dispatch<SetStateAction<boolean>>;
  q: (id: string, name: string, args?: Record<string, unknown>) => void;
  termDockOpen: boolean;
  setTermDockOpen: Dispatch<SetStateAction<boolean>>;
  sidePanelOpen: boolean;
  setSidePanelOpen: Dispatch<SetStateAction<boolean>>;
  pop: PopId;
  setPop: Dispatch<SetStateAction<PopId>>;
  openSettings: (section: SettingsSection) => void;
}

export function TopbarRight(p: TopbarRightProps): React.ReactElement {
  const { homeMode, envRoom, envOpen, setEnvOpen, q, termDockOpen, setTermDockOpen, sidePanelOpen, setSidePanelOpen, pop, setPop, openSettings } = p;
  return (
    <span className="topbar-right">
      {!homeMode && envRoom ? (
        <button type="button" className={`app-switcher${envOpen ? ' active' : ''}`} title="Environment" onClick={() => {
          if (!envOpen) { q('q-gitlog', 'git-log'); q('q-git', 'git-info'); q('q-branches', 'git-branches'); }
          setEnvOpen((o) => !o);
        }}>
          <Icon name="brain" size={15} />
          <Icon name="chev-down" size={11} />
        </button>
      ) : null}
      <button type="button" className={`top-toggle${termDockOpen ? ' active' : ''}`} title="Toggle bottom panel (⌃`)" onClick={() => setTermDockOpen((o) => !o)}><Icon name="layout-bottom" size={16} /></button>
      <button type="button" className={`top-toggle${sidePanelOpen ? ' active' : ''}`} title="Toggle side panel (⌥⌘B)" onClick={() => setSidePanelOpen((o) => !o)}><Icon name="sidebar-right" size={16} /></button>
      <button type="button" className="top-toggle" title="Export session" onClick={() => setPop(pop === 'export' ? '' : 'export')}><Icon name="export" size={15} /></button>
      <button type="button" className="top-toggle" title="Settings" onClick={() => openSettings('general')}><Icon name="gear" size={15} /></button>
    </span>
  );
}
