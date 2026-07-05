/**
 * Public surface of the panel system. Each panel lives in its own file under
 * src/panels/; this barrel re-exports exactly what panels.tsx used to so the
 * rest of the app keeps importing from one place.
 */
export { CodeBlock, langForPath } from './code.js';
export { DiffView, parseUnifiedDiff, type DiffLine, type DiffHunk, type DiffFile } from './diff.js';
export { Panel, PanelPicker, MANUAL_PANEL_DEFS, PANEL_DEFS, type PanelId } from './Panel.js';
export { GATE_LABEL, type ReviewFindingView, type ReviewGateView } from './reviewShared.js';
export { FilesPanel, buildFileTree, type GrepHit } from './files/FilesPanel.js';
export { FileViewerPanel } from './files/FileViewerPanel.js';
export { SearchPanel, type SearchHit } from './files/SearchPanel.js';
export { DiffPanel } from './review/DiffPanel.js';
export { ReviewPanel } from './review/ReviewPanel.js';
export { DashboardPanel } from './review/DashboardPanel.js';
export { TerminalPanel } from './workspace/TerminalPanel.js';
export { ToolsPanel } from './workspace/ToolsPanel.js';
export { WorktreesPanel } from './workspace/WorktreesPanel.js';
export { AttachmentsPanel } from './workspace/AttachmentsPanel.js';
export { PreviewPanel } from './workspace/PreviewPanel.js';
export { TasksPanel, type FinishedTask } from './planning/TasksPanel.js';
export { SchedulePanel } from './planning/SchedulePanel.js';
export { RequirementsPanel } from './planning/RequirementsPanel.js';
export { WorkflowsPanel, type WorkflowsPanelProps } from './planning/WorkflowsPanel.js';
export { PrototypePanel } from './planning/PrototypePanel.js';
export { PlanPanel } from './planning/PlanPanel.js';
export { AnnotationsPanel } from './memory/AnnotationsPanel.js';
export { ArtifactsPanel } from './memory/ArtifactsPanel.js';
export { MemoryPanel } from './memory/MemoryPanel.js';
export { ContextPanel } from './memory/ContextPanel.js';
export { AtlasPanel, type AtlasPanelProps } from './atlas/AtlasPanel.js';
export { CIPanel } from './ci/CIPanel.js';
export { EditorPanel } from './editing/EditorPanel.js';
