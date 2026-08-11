/** Browser-safe Notes presentation, interaction rules, and host contracts. */
export {
  applyInputRule,
  blockComments,
  blockReferences,
  buildNoteTree,
  defaultTableHeader,
  describeSyncedState,
  describeTrashEntry,
  emptyTableRow,
  FORMULA_FUNCTIONS,
  isDerivedPropertyType,
  isLiveBlock,
  listTrashEntries,
  NEW_TABLE_COLUMNS,
  NOTE_BLOCK_KINDS,
  NOTE_PROPERTY_TYPES,
  NOTE_ROLLUP_AGGREGATES,
  NOTE_VIEW_KINDS,
  NOTES_EDITING_CAPABILITIES,
  NOTES_EDITING_CONTRACT_VERSION,
  numberedOrdinals,
  orphanedComments,
  OPERATORS_FOR_TYPE,
  operatorsFor,
  pageTitleOrDefault,
  readSyncedBlock,
  searchSlashCatalog,
  subtreeBlockIds,
} from '@kinqs/brainrouter-core/notes/editing';
export type {
  NoteBlock,
  NotesEditingCapabilities,
  NotesEditingContractVersion,
  NotesMutationError,
  NotesMutationErrorCode,
  NotesMutationFailure,
  NotesMutationOperation,
  NotesMutationOperationType,
  NotesMutationRequest,
  NotesMutationResponse,
  NotesMutationSuccess,
  NotesMutationSyncReport,
  NotesRemoteHistoryState,
} from '@kinqs/brainrouter-core/notes/editing';

export { NotesMode } from './NotesMode.js';
export type {
  BlockOpOutcome,
  CodeSymbolPick,
  NotesOps,
  NotesShellState,
} from './NotesMode.js';
export type {
  DatabaseHostOps,
  DatabaseOps,
  DatabaseFileCapability,
  PropertyConfig,
  SaveViewInput,
} from './databaseOps.js';
export type {
  NotesBookmarkCapability,
  NotesClipboardCapability,
  NotesExportCapability,
  NotesHistoryCapability,
  NotesHostCapabilities,
  NotesImageCapability,
  NotesLiveReferenceCapability,
} from './capabilities.js';

export * from './blockEditing.js';
export * from './blockKeymap.js';
export * from './blockSelection.js';
export * from './blockVisibility.js';
export * from './bookmarkView.js';
export * from './commentThread.js';
export * from './database.js';
export * from './embedView.js';
export * from './exportView.js';
export * from './imageView.js';
export * from './mentionPicker.js';
export * from './notesView.js';
export * from './pageHeader.js';
export * from './pageTree.js';
export * from './pageUndo.js';
export * from './quickFind.js';
export * from './references.js';
export * from './sidebar.js';
export * from './slashMenu.js';
export * from './syncedView.js';
export * from './tableView.js';
export * from './templates.js';
export * from './visualRows.js';
