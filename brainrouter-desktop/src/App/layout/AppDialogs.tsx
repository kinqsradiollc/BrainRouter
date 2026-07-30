/**
 * App shell — the trailing overlay cluster: the popover backdrop, the ⌘K
 * command palette, the categorized Settings modal, and the interaction /
 * export-menu / info-and-gate dialogs. Extracted from App.tsx verbatim; every
 * value is passed through so the rendered overlays are unchanged.
 */
import React from 'react';
import { CommandPalette } from '../../palette.js';
import { SettingsDialog, type ConfigSnapshot, type UsageHistory } from '../../settings.js';
import type { MarketplaceState } from '../../settings/marketplace/index.js';
import { OnboardingDialog } from '../../components/dialogs/OnboardingDialog.js';
import { InteractionDialogs } from '../../components/dialogs/InteractionDialogs.js';
import { ExportAndMenuDialogs } from '../../components/dialogs/ExportAndMenuDialogs.js';
import { InfoAndGateDialogs } from '../../components/dialogs/InfoAndGateDialogs.js';
import { runCommand, type CmdCtx, type CommandsCatalog, type DeskCommand, type SettingsSection } from '../../lib/commands/commands.js';
import type { PopId, SessionRow } from '../../types.js';
import type { PanelId } from '../../panels/index.js';
import type { GitState } from '../../lib/git/useGitState.js';
import type { AppearancePreference } from '../../lib/theme/appearance.js';

type Query = (id: string, name: string, args?: Record<string, unknown>) => void;

export interface AppDialogsProps {
  pop: PopId;
  setPop: React.Dispatch<React.SetStateAction<PopId>>;
  q: Query;
  cmdCtx: CmdCtx;
  commands: DeskCommand[];
  // ⌘K palette
  paletteOpen: boolean;
  setPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  // Settings modal
  settings: { open: boolean; section: SettingsSection };
  setSettings: React.Dispatch<React.SetStateAction<{ open: boolean; section: SettingsSection }>>;
  snapshot: ConfigSnapshot | null;
  usageLines: string[];
  usageHistory: UsageHistory | null;
  tokens: { promptTokens: number; completionTokens: number; turns: number; cachedTokens?: number } | null;
  catalog: CommandsCatalog | null;
  setPreference: (key: string, value: unknown) => void;
  endpointModels: string[];
  providerModels: Record<string, string[]>;
  probedModels: string[];
  probeLoading: boolean;
  probeError: string;
  setProbeLoading: (v: boolean) => void;
  setProbeError: (v: string) => void;
  setProbedModels: (v: string[]) => void;
  toolCatalog: React.ComponentProps<typeof SettingsDialog>['toolCatalog'];
  /** PLUGIN-MARKETPLACE P4-desktop — the Marketplace panel's data slice. */
  market: MarketplaceState;
  execMode: string;
  codeFont: string;
  setCodeFont: (v: string) => void;
  theme: AppearancePreference;
  setTheme: (preference: AppearancePreference) => void;
  visualSystemV2: boolean;
  setVisualSystemV2: (enabled: boolean) => void;
  chatWidth: string;
  setChatWidth: (v: string) => void;
  chatSize: string;
  setChatSize: (v: string) => void;
  accent: string;
  setAccent: (v: string) => void;
  // Interaction / trust dialogs
  interaction: React.ComponentProps<typeof InteractionDialogs>['interaction'];
  picked: string[];
  setPicked: React.Dispatch<React.SetStateAction<string[]>>;
  answerInteraction: React.ComponentProps<typeof InteractionDialogs>['answerInteraction'];
  trustAsk: React.ComponentProps<typeof InteractionDialogs>['trustAsk'];
  setTrustAsk: React.ComponentProps<typeof InteractionDialogs>['setTrustAsk'];
  switchToWorkspace: (root: string, resumeKey?: string) => void;
  onboardAsk: string | null;
  setOnboardAsk: (root: string | null) => void;
  onWorkspaceOnboarded: (root: string) => void;
  // Export + session-menu dialogs
  sessionMenu: React.ComponentProps<typeof ExportAndMenuDialogs>['sessionMenu'];
  sessions: SessionRow[];
  closeSessionMenu: () => void;
  openExternal: React.ComponentProps<typeof ExportAndMenuDialogs>['openExternal'];
  togglePin: React.ComponentProps<typeof ExportAndMenuDialogs>['togglePin'];
  toggleComplete: React.ComponentProps<typeof ExportAndMenuDialogs>['toggleComplete'];
  startRename: React.ComponentProps<typeof ExportAndMenuDialogs>['startRename'];
  forkSessionAction: React.ComponentProps<typeof ExportAndMenuDialogs>['forkSessionAction'];
  moveToGroup: React.ComponentProps<typeof ExportAndMenuDialogs>['moveToGroup'];
  sessionGroups: string[];
  toggleArchive: React.ComponentProps<typeof ExportAndMenuDialogs>['toggleArchive'];
  deleteSessionAction: React.ComponentProps<typeof ExportAndMenuDialogs>['deleteSessionAction'];
  // Info + review-gate dialogs
  infoDialog: { title: string; body: string } | null;
  setInfoDialog: React.ComponentProps<typeof InfoAndGateDialogs>['setInfoDialog'];
  gateBlock: GitState['gateBlock'];
  setGateBlock: GitState['setGateBlock'];
  activeRoot: string;
  ensurePanel: (id: PanelId) => void;
  setReviewRunningByWs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setReviewByWs: GitState['setReviewByWs'];
  pendingGitRef: GitState['pendingGitRef'];
  runGit: GitState['runGit'];
  setToast: (t: string) => void;
  setGitBusy: React.Dispatch<React.SetStateAction<boolean>>;
  toast: string;
}

export function AppDialogs(p: AppDialogsProps): React.ReactElement {
  const {
    pop, setPop, q, cmdCtx, commands, paletteOpen, setPaletteOpen, settings, setSettings, snapshot, usageLines,
    usageHistory, tokens, catalog, setPreference, endpointModels, providerModels, probedModels, probeLoading,
    probeError, setProbeLoading, setProbeError, setProbedModels, toolCatalog, market, execMode, codeFont, setCodeFont,
    theme, setTheme, visualSystemV2, setVisualSystemV2, chatWidth, setChatWidth, chatSize, setChatSize, accent, setAccent, interaction, picked,
    setPicked, answerInteraction, trustAsk, setTrustAsk, onboardAsk, setOnboardAsk, onWorkspaceOnboarded, switchToWorkspace, sessionMenu, sessions,
    closeSessionMenu, openExternal, togglePin, toggleComplete, startRename, forkSessionAction, moveToGroup,
    sessionGroups, toggleArchive, deleteSessionAction, infoDialog, setInfoDialog, gateBlock, setGateBlock,
    activeRoot, ensurePanel, setReviewRunningByWs, setReviewByWs, pendingGitRef, runGit, setToast, setGitBusy, toast,
  } = p;

  return (
    <>
      {pop && pop !== 'export' ? <div className="picker-backdrop" onClick={() => setPop('')} /> : null}

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)}
        onRun={(c) => runCommand(c, cmdCtx)} />

      <SettingsDialog
        open={settings.open}
        section={settings.section}
        setSection={(s) => setSettings({ open: true, section: s })}
        onClose={() => setSettings((st) => ({ ...st, open: false }))}
        snapshot={snapshot}
        usageLines={usageLines}
        usageHistory={usageHistory}
        tokens={tokens}
        commands={commands}
        catalog={catalog}
        onPref={setPreference}
        endpointModels={endpointModels}
        providerModels={providerModels}
        probedModels={probedModels}
        probeLoading={probeLoading}
        probeError={probeError}
        onProbe={(a) => { setProbeLoading(true); setProbeError(''); q('q-probe', 'list-models-probe', a); }}
        toolCatalog={toolCatalog}
        market={market}
        onProbeReset={() => { setProbedModels([]); setProbeLoading(false); setProbeError(''); }}
        onModelSave={(model) => window.brainrouter.send({ kind: 'set-model', model, persist: true })}
        onAction={(id, name, args) => {
          if (name === 'new-session') { window.brainrouter.send({ kind: 'new-session' }); setSettings((st) => ({ ...st, open: false })); return; }
          q(id, name, args);
        }}
        onRunCommand={(c) => { setSettings((st) => ({ ...st, open: false })); runCommand(c, cmdCtx); }}
        execMode={execMode}
        codeFont={codeFont}
        onCodeFont={setCodeFont}
        theme={theme}
        onTheme={setTheme}
        visualSystemV2={visualSystemV2}
        onVisualSystemV2={setVisualSystemV2}
        chatWidth={chatWidth}
        onChatWidth={setChatWidth}
        chatSize={chatSize}
        onChatSize={setChatSize}
        accent={accent}
        onAccent={setAccent}
      />

      <InteractionDialogs interaction={interaction} picked={picked} setPicked={setPicked} answerInteraction={answerInteraction}
        trustAsk={trustAsk} setTrustAsk={setTrustAsk} switchToWorkspace={switchToWorkspace} />

      <OnboardingDialog root={onboardAsk} onClose={() => setOnboardAsk(null)} onSaved={onWorkspaceOnboarded} />

      <ExportAndMenuDialogs pop={pop} setPop={setPop} q={q} sessionMenu={sessionMenu} sessions={sessions}
        closeSessionMenu={closeSessionMenu} openExternal={openExternal} togglePin={togglePin} toggleComplete={toggleComplete}
        startRename={startRename} forkSessionAction={forkSessionAction} moveToGroup={moveToGroup} sessionGroups={sessionGroups}
        toggleArchive={toggleArchive} deleteSessionAction={deleteSessionAction} />
      <InfoAndGateDialogs infoDialog={infoDialog} setInfoDialog={setInfoDialog} gateBlock={gateBlock} setGateBlock={setGateBlock}
        activeRoot={activeRoot} ensurePanel={ensurePanel} setReviewRunningByWs={setReviewRunningByWs} setReviewByWs={setReviewByWs}
        q={q} pendingGitRef={pendingGitRef} runGit={runGit} setToast={setToast} setGitBusy={setGitBusy} toast={toast} />
    </>
  );
}
