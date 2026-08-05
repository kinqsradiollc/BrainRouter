/**
 * App shell — the `.main` content column: Track-mode board OR the Code/Chat
 * chat thread + composer, plus the Environment column, side ViewsRail, bottom
 * TerminalDock, and the pinned TopbarRight cluster. Extracted from App.tsx
 * verbatim; every value flows through props so the rendered layout, DOM order
 * (load-bearing for Electron drag regions), and behavior are unchanged.
 */
import type { WorkspaceMode } from '../../components/layout/ActivityBar.js';
import React from 'react';
import { Icon } from '../../icons.js';
import { TrackView } from '../../track/TrackView.js';
import { PlannerModeContainer } from '../../planner/PlannerModeContainer.js';
import { MeetingsView } from '../../components/meetings/MeetingsView.js';
import { createMeetingsOps } from '../../components/meetings/meetingsOps.js';
import { ChatThread } from '../../components/chat/ChatThread.js';
import { Composer } from '../../components/chat/Composer.js';
import { EnvironmentPanel } from '../../components/layout/EnvironmentPanel.js';
import { ViewsRail } from '../../components/layout/ViewsRail.js';
import { TerminalDock } from '../../components/layout/TerminalDock.js';
import { TopbarRight } from '../../components/layout/TopbarRight.js';
import type { PanelId } from '../../panels/index.js';
import type { AttachmentUpload, FleetRow } from '../../types.js';
import type { useCi } from '../../lib/ci/useCi.js';

type CT = React.ComponentProps<typeof ChatThread>;
type CP = React.ComponentProps<typeof Composer>;
type EP = React.ComponentProps<typeof EnvironmentPanel>;
type VR = React.ComponentProps<typeof ViewsRail>;
type TD = React.ComponentProps<typeof TerminalDock>;
type TR = React.ComponentProps<typeof TopbarRight>;
type TV = React.ComponentProps<typeof TrackView>;

export interface MainContentProps {
  mode: WorkspaceMode;
  setMode: (m: WorkspaceMode) => void;
  workrowRef: React.RefObject<HTMLDivElement>;
  // Track view
  track: { project: TV['project']; items: TV['items']; sprints: TV['sprints']; modules: TV['modules']; views: TV['views']; automations: TV['automations']; members: TV['members']; sync: TV['sync']; git: TV['git']; pr: TV['pr'] };
  trackOps: TV['ops'];
  // shared layout state
  railOpen: boolean;
  setRailOpen: CT['setRailOpen'];
  sidePanelOpen: boolean;
  sidePinned: boolean;
  sideFullScreen: boolean;
  setSidePanelOpen: VR['setSidePanelOpen'];
  setSidePinned: VR['setSidePinned'];
  sideAnim: VR['sideAnim'];
  sideWidth: number;
  setSideWidth: VR['setSideWidth'];
  activeSideTab: VR['activeSideTab'];
  sideTabs: VR['sideTabs'];
  setActiveSideTab: VR['setActiveSideTab'];
  closeSideTab: VR['closeSideTab'];
  reorderSideTab: VR['reorderSideTab'];
  tabTitle: (id: PanelId) => string;
  renderPanelBody: VR['renderPanelBody'];
  openSideView: VR['openSideView'];
  lastPlan: VR['lastPlan'];
  changedFiles: CT['changedFiles'];
  backgroundTasks: FleetRow[];
  fleet: VR['fleet'];
  toolLog: VR['toolLog'];
  schedules: VR['schedules'];
  worktrees: VR['worktrees'];
  review: VR['review'];
  requirements: VR['requirements'];
  annotations: VR['annotations'];
  artifacts: VR['artifacts'];
  ci: ReturnType<typeof useCi>;
  envRoom: boolean;
  envDrawer: boolean;
  // ChatThread
  homeMode: CT['homeMode'];
  gitInfo: CT['gitInfo'];
  info: CT['info'];
  sessionTitle: CT['sessionTitle'];
  taskView: CT['taskView'];
  setTaskView: CT['setTaskView'];
  chatRef: CT['chatRef'];
  atBottomRef: CT['atBottomRef'];
  setAtBottom: CT['setAtBottom'];
  workflowView: CT['workflowView'];
  setWorkflowView: CT['setWorkflowView'];
  renderRow: CT['renderRow'];
  homeStats: CT['homeStats'];
  statsTab: CT['statsTab'];
  setStatsTab: CT['setStatsTab'];
  statsRange: CT['statsRange'];
  setStatsRange: CT['setStatsRange'];
  snapshot: CT['snapshot'];
  sessions: CT['sessions'];
  viewKey: string;
  renameCurrentSession: CT['onRenameCurrent'];
  resumeSession: CT['resumeSession'];
  forkParent: CT['forkParent'];
  transcriptEls: CT['transcriptEls'];
  liveText: CT['liveText'];
  goalState: CT['goal'];
  runBridge: (cmd: string, argText?: string) => void;
  q: CT['q'];
  running: boolean;
  turnStart: CT['turnStart'];
  reasoningTail: CT['reasoningTail'];
  statusLine: CT['statusLine'];
  interaction: CT['interaction'];
  answerInteraction: CT['answerInteraction'];
  chatEnd: CT['chatEnd'];
  atBottom: CT['atBottom'];
  hasConversation: boolean;
  ensurePanel: (id: PanelId) => void;
  // Composer
  draft: CP['draft'];
  setDraft: CP['setDraft'];
  stopping: boolean;
  submit: CP['submit'];
  submitDelivery: CP['submitDelivery'];
  requestStop: () => void;
  slashActive: CP['slashActive'];
  slashMatches: CP['slashMatches'];
  commands: CP['commands'];
  slashSel: CP['slashSel'];
  setSlashSel: CP['setSlashSel'];
  setSlashDismissed: CP['setSlashDismissed'];
  runSlash: CP['onRunSlash'];
  pop: CP['pop'];
  setPop: CP['setPop'];
  modeLabel: CP['modeLabel'];
  effort: CP['effort'];
  branches: CP['branches'];
  endpointModels: CP['endpointModels'];
  defaultProviderModels: CP['allowedModels'];
  routerCatalog: CP['routerCatalog'];
  routerFallback: CP['routerFallback'];
  modelsLoading: CP['modelsLoading'];
  setModelsLoading: CP['setModelsLoading'];
  modelChoices: CP['modelChoices'];
  modelScope: CP['modelScope'];
  setModelScope: CP['setModelScope'];
  contextUsage: CP['contextUsage'];
  tokens: CP['tokens'];
  openSettings: CP['openSettings'];
  attachFiles: CP['onAttach'];
  attachmentUploads: AttachmentUpload[];
  canSubmit: boolean;
  setAttachmentUploads: React.Dispatch<React.SetStateAction<AttachmentUpload[]>>;
  pastedImages: Array<{ id: string; mediaType: string; dataBase64: string }>;
  addPastedImages: CP['onPasteImages'];
  setPastedImages: React.Dispatch<React.SetStateAction<Array<{ id: string; mediaType: string; dataBase64: string }>>>;
  // §a11y-inspect — composer component/journey tag chips.
  componentTags: CP['componentTags'];
  onDropTag: CP['onDropTag'];
  onClearComponentTag: CP['onClearComponentTag'];
  // EnvironmentPanel
  envAnim: EP['envAnim'];
  setTermDockOpen: EP['setTermDockOpen'];
  commitSubjects: EP['commitSubjects'];
  openCiPanel: EP['openCiPanel'];
  lastTurnFails: EP['lastTurnFails'];
  openTask: EP['openTask'];
  // TerminalDock
  dockAnim: TD['dockAnim'];
  termDockHeight: number;
  resizeTerminal: TD['resizeTerminal'];
  termTabs: TD['termTabs'];
  activeTerm: TD['activeTerm'];
  setActiveTerm: TD['setActiveTerm'];
  closeBottomTab: TD['closeBottomTab'];
  addBottomTab: TD['addBottomTab'];
  // TopbarRight
  envOpen: boolean;
  setEnvOpen: TR['setEnvOpen'];
  termDockOpen: boolean;
  setSideFullScreen: TR['setSideFullScreen'];
  openBottomDock: TR['openBottomDock'];
  workspaceViewContext: TR['workspaceViewContext'];
}

export function MainContent(p: MainContentProps): React.ReactElement {
  const {
    mode, setMode, workrowRef, track, trackOps, railOpen, setRailOpen, sidePanelOpen, sidePinned, sideFullScreen,
    setSidePanelOpen, setSidePinned, sideAnim, sideWidth, setSideWidth, activeSideTab, sideTabs, setActiveSideTab,
    closeSideTab, reorderSideTab, tabTitle, renderPanelBody, openSideView, lastPlan, changedFiles, backgroundTasks,
    fleet, toolLog, schedules, worktrees, review, requirements, annotations, artifacts, ci, envRoom, envDrawer, homeMode,
    gitInfo, info, sessionTitle, taskView, setTaskView, chatRef, atBottomRef, setAtBottom, workflowView,
    setWorkflowView, renderRow, homeStats, statsTab, setStatsTab, statsRange, setStatsRange, snapshot, sessions,
    viewKey, renameCurrentSession, resumeSession, forkParent, transcriptEls, liveText, goalState, runBridge, q,
    running, turnStart, reasoningTail, statusLine, interaction, answerInteraction, chatEnd, atBottom, hasConversation,
    ensurePanel, draft, setDraft, stopping, submit, submitDelivery, requestStop, slashActive, slashMatches, commands, slashSel,
    setSlashSel, setSlashDismissed, runSlash, pop, setPop, modeLabel, effort, branches, endpointModels,
    defaultProviderModels, routerCatalog, routerFallback, modelsLoading, setModelsLoading, modelChoices, modelScope, setModelScope, contextUsage,
    tokens, openSettings, attachFiles, attachmentUploads, canSubmit, setAttachmentUploads, pastedImages,
    addPastedImages, setPastedImages, componentTags, onDropTag, onClearComponentTag, envAnim, setTermDockOpen, commitSubjects, openCiPanel, lastTurnFails, openTask,
    dockAnim, termDockHeight, resizeTerminal, termTabs, activeTerm, setActiveTerm, closeBottomTab, addBottomTab,
    workspaceViewContext,
    envOpen, setEnvOpen, termDockOpen, setSideFullScreen, openBottomDock,
  } = p;
  const composerInputRef = React.useRef<HTMLTextAreaElement>(null);
  const startBuild = React.useCallback((): void => {
    setMode('code');
    requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [setMode]);
  const openHomeView = React.useCallback((id: PanelId): void => {
    setMode('code');
    ensurePanel(id);
  }, [ensurePanel, setMode]);
  // Meetings mode (ADR-018) — data flows through the injected ops bridge.
  const meetingsOps = React.useMemo(() => createMeetingsOps(), []);

  return (
    <div className="main">
      {mode === 'planner' ? (
        // ADR-028 G6 — cross-workspace, so it renders WITHOUT the side panel
        // rail: a personal planner has no per-workspace tabs to carry.
        <div className="workrow" ref={workrowRef}>
          <PlannerModeContainer />
        </div>
      ) : mode === 'meetings' ? (
        <div className="workrow" ref={workrowRef}>
          <MeetingsView ops={meetingsOps} />
        </div>
      ) : mode === 'track' ? (
        <div className="workrow track-workrow" ref={workrowRef}>
          <TrackView project={track.project} items={track.items} sprints={track.sprints} modules={track.modules} views={track.views} automations={track.automations} members={track.members} sync={track.sync} git={track.git} pr={track.pr} ops={trackOps} railOpen={railOpen} onOpenRail={() => setRailOpen(true)} />
          {sidePanelOpen && !sidePinned && !sideFullScreen ? (
            <div className="side-scrim" onClick={() => setSidePanelOpen(false)} aria-hidden="true" />
          ) : null}
          <ViewsRail sideAnim={sideAnim} sideWidth={sideWidth} setSideWidth={setSideWidth} sideFullScreen={sideFullScreen}
            setSidePanelOpen={setSidePanelOpen} sidePinned={sidePinned} setSidePinned={setSidePinned}
            activeSideTab={activeSideTab} sideTabs={sideTabs} setActiveSideTab={setActiveSideTab} closeSideTab={closeSideTab} reorderSideTab={reorderSideTab}
            tabTitle={tabTitle}
            renderPanelBody={renderPanelBody} openSideView={openSideView} lastPlan={lastPlan} changedFiles={changedFiles}
            backgroundTasks={backgroundTasks} fleet={fleet} toolLog={toolLog} schedules={schedules}
            worktrees={worktrees} review={review} requirements={requirements} annotations={annotations} artifacts={artifacts} ci={ci}
            envRoom={false} />
        </div>
      ) : (<>
      <div className="workrow" ref={workrowRef}>
        <ChatThread
          homeMode={homeMode} onMode={setMode} onStartBuild={startBuild} onOpenHomeView={openHomeView}
          railOpen={railOpen} setRailOpen={setRailOpen} gitInfo={gitInfo} info={info}
          sessionTitle={sessionTitle} taskView={taskView} setTaskView={setTaskView} chatRef={chatRef}
          atBottomRef={atBottomRef} setAtBottom={setAtBottom} workflowView={workflowView} setWorkflowView={setWorkflowView}
          renderRow={renderRow} homeStats={homeStats} statsTab={statsTab} setStatsTab={setStatsTab}
          statsRange={statsRange} setStatsRange={setStatsRange} snapshot={snapshot} sessions={sessions}
          viewKey={viewKey} onRenameCurrent={renameCurrentSession}
          resumeSession={resumeSession} forkParent={forkParent} transcriptEls={transcriptEls} liveText={liveText}
          goal={goalState}
          onGoalResume={() => runBridge('goal', 'resume')}
          // WS7 — pausing the goal also interrupts the in-flight turn, so the
          // pause button and the chat Stop button converge on the same state.
          onGoalPause={() => { runBridge('goal', 'pause'); window.brainrouter.send({ kind: 'interrupt' }); }}
          onGoalClear={() => runBridge('goal', 'clear')}
          onGoalEdit={(text) => { q('a-goal-edit', 'action:goal-edit', { text }); }}
          running={running} turnStart={turnStart} reasoningTail={reasoningTail} statusLine={statusLine}
          interaction={interaction} answerInteraction={answerInteraction} q={q} chatEnd={chatEnd} atBottom={atBottom}
          hasConversation={hasConversation} changedFiles={changedFiles} ensurePanel={ensurePanel}
          composer={
            <>
            {mode === 'chat' ? (
              <div className="chat-readonly" title="Chat keeps the agent read-only — it can read, search and explain, but won't edit files or run commands. Switch to Code to make changes.">
                <Icon name="eye" size={12} /> Read-only — Chat explores &amp; explains; switch to <button className="chat-readonly-link" onClick={() => setMode('code')}>Code</button> to make changes
              </div>
            ) : null}
            <Composer
              draft={draft} setDraft={setDraft} running={running} stopping={stopping} submit={submit} submitDelivery={submitDelivery}
              // WS7 — the chat Stop button also pauses an active goal, so an
              // interrupt doesn't leave the goal "active" and silently auto-resume.
              requestStop={() => { requestStop(); if (goalState?.status === 'active') runBridge('goal', 'pause'); }}
              slashActive={slashActive} slashMatches={slashMatches} commands={commands} slashSel={slashSel} setSlashSel={setSlashSel}
              setSlashDismissed={setSlashDismissed} onRunSlash={runSlash} pop={pop} setPop={setPop} q={q}
              modeLabel={modeLabel} effort={effort} info={info} branches={branches}
              endpointModels={endpointModels} allowedModels={defaultProviderModels} routerCatalog={routerCatalog} routerFallback={routerFallback} modelsLoading={modelsLoading} setModelsLoading={setModelsLoading}
              connectedProviders={snapshot?.providers ?? []} defaultProviderName={snapshot?.defaultProviderName ?? null}
              accountModels={snapshot?.accountModels}
              modelChoices={modelChoices} modelScope={modelScope} setModelScope={setModelScope}
              hasConversation={hasConversation} contextUsage={contextUsage} tokens={tokens} openSettings={openSettings}
              onAttach={attachFiles}
              attachments={attachmentUploads}
              canSubmit={canSubmit}
              onClearAttachment={(id) => setAttachmentUploads((prev) => prev.filter((u) => u.id !== id))}
              pastedImages={pastedImages}
              onPasteImages={addPastedImages}
              onClearPastedImage={(id) => setPastedImages((prev) => prev.filter((pi) => pi.id !== id))}
              componentTags={componentTags}
              onDropTag={onDropTag}
              onClearComponentTag={onClearComponentTag}
              inputRef={composerInputRef} />
            </>
          } />

        {/* Chat mode is a FOCUSED conversation — the code workbench (Environment
            column, side panels, terminal) appears only in Code mode. */}
        {mode === 'code' ? (<>
        {envDrawer && envAnim.mounted ? (
          <button type="button" className="env-scrim" aria-label="Close Environment" onClick={() => setEnvOpen(false)} />
        ) : null}
        {/* Environment is a layout column when room exists and an explicit,
            dismissible drawer when zoom reduces the effective viewport. */}
        <EnvironmentPanel envAnim={envAnim} openSettings={openSettings} gitInfo={gitInfo} ensurePanel={ensurePanel}
          setTermDockOpen={setTermDockOpen} branches={branches} pop={pop} setPop={setPop} q={q} commitSubjects={commitSubjects} ci={ci}
          openCiPanel={openCiPanel} lastTurnFails={lastTurnFails} backgroundTasks={backgroundTasks} openTask={openTask}
          drawer={envDrawer} onClose={() => setEnvOpen(false)} />

        {/* §panel-drawer — scrim over the chat when the panel is an unpinned
            drawer; clicking it (i.e. clicking outside the panel) closes it. */}
        {sidePanelOpen && !sidePinned && !sideFullScreen ? (
          <div className="side-scrim" onClick={() => setSidePanelOpen(false)} aria-hidden="true" />
        ) : null}
        <ViewsRail sideAnim={sideAnim} sideWidth={sideWidth} setSideWidth={setSideWidth} sideFullScreen={sideFullScreen}
          setSidePanelOpen={setSidePanelOpen} sidePinned={sidePinned} setSidePinned={setSidePinned}
          activeSideTab={activeSideTab} sideTabs={sideTabs} setActiveSideTab={setActiveSideTab} closeSideTab={closeSideTab} reorderSideTab={reorderSideTab}
          tabTitle={tabTitle}
          renderPanelBody={renderPanelBody} openSideView={openSideView} lastPlan={lastPlan} changedFiles={changedFiles}
          backgroundTasks={backgroundTasks} fleet={fleet} toolLog={toolLog} schedules={schedules}
          worktrees={worktrees} review={review} requirements={requirements} annotations={annotations} artifacts={artifacts} ci={ci}
          envRoom={envRoom} />
        </>) : null}
      </div>

      {mode === 'code' ? (
      <TerminalDock dockAnim={dockAnim} termDockHeight={termDockHeight} resizeTerminal={resizeTerminal}
        termTabs={termTabs} activeTerm={activeTerm} setActiveTerm={setActiveTerm} closeBottomTab={closeBottomTab}
        pop={pop} setPop={setPop} addBottomTab={addBottomTab} setTermDockOpen={setTermDockOpen}
        tabTitle={tabTitle} gitInfo={gitInfo} renderPanelBody={renderPanelBody} />
      ) : null}
      </>)}

      {/* DESK-5h — window control cluster, pinned top-right of the content
          area (absolute — visual position is unaffected by DOM order).
          MUST be the LAST child of .main: Electron builds drag regions in
          DOM order, so this cluster's no-drag rect has to subtract AFTER
          the chat-head's drag rect is added. Placed earlier, the drag
          region re-covers the buttons and swallows every click — the
          browser preview ignores app-region, which is why it only broke
          in the real Electron shell. */}
      <TopbarRight mode={mode} homeMode={homeMode} envRoom={envRoom} envOpen={envOpen} setEnvOpen={setEnvOpen} q={q}
        termDockOpen={termDockOpen} setTermDockOpen={setTermDockOpen} sidePanelOpen={sidePanelOpen} sideWidth={sideWidth}
        setSidePanelOpen={setSidePanelOpen} sideFullScreen={sideFullScreen} setSideFullScreen={setSideFullScreen}
        sideTabs={sideTabs} activeSideTab={activeSideTab} ensurePanel={ensurePanel} openBottomDock={openBottomDock}
        pop={pop} setPop={setPop} openSettings={openSettings} workspaceViewContext={workspaceViewContext} />
    </div>
  );
}
