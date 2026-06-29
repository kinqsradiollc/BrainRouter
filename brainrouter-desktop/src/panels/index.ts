/**
 * Public surface of the panel system. Each panel lives in its own file under
 * src/panels/; this barrel re-exports exactly what panels.tsx used to so the
 * rest of the app keeps importing from one place.
 */
export { CodeBlock, langForPath } from './code.js';
export { DiffView, parseUnifiedDiff, type DiffLine, type DiffHunk, type DiffFile } from './diff.js';
export { Panel, PanelPicker, MANUAL_PANEL_DEFS, PANEL_DEFS, type PanelId } from './Panel.js';
export { GATE_LABEL, type ReviewFindingView, type ReviewGateView } from './reviewShared.js';
export { FilesPanel, buildFileTree, type GrepHit } from './FilesPanel.js';
export { FileViewerPanel } from './FileViewerPanel.js';
export { DiffPanel } from './DiffPanel.js';
export { TerminalPanel } from './TerminalPanel.js';
export { ToolsPanel } from './ToolsPanel.js';
export { TasksPanel, type FinishedTask } from './TasksPanel.js';
export { SchedulePanel } from './SchedulePanel.js';
export { WorktreesPanel } from './WorktreesPanel.js';
export { ReviewPanel } from './ReviewPanel.js';
export { RequirementsPanel } from './RequirementsPanel.js';
export { AnnotationsPanel } from './AnnotationsPanel.js';
export { ArtifactsPanel } from './ArtifactsPanel.js';
export { AtlasPanel, type AtlasPanelProps } from './AtlasPanel.js';
export { WorkflowsPanel, type WorkflowsPanelProps } from './WorkflowsPanel.js';
export { WritePanel } from './WritePanel.js';
export { SearchPanel, type SearchHit } from './SearchPanel.js';
export { PlanPanel } from './PlanPanel.js';
export { ContextPanel } from './ContextPanel.js';
