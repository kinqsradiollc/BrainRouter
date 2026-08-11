import type { BookmarkAnswer } from './bookmarkView.js';
import type { WorkspaceResolutionDto } from './embedView.js';
import type { NoteExportFormatId } from './exportView.js';
import type { NoteImageDto } from './imageView.js';
import type { PageUndoDto } from './pageUndo.js';
import type { SyncedReadDto } from './syncedView.js';

/** Native/file-backed image access. Omit it when a host cannot store bytes. */
export interface NotesImageCapability {
  attach: (blockId: string, file: { name: string; dataBase64: string }) => Promise<string | null>;
  storeRemote: (blockId: string, url: string) => Promise<string | null>;
  read: (attachmentId: string) => Promise<NoteImageDto | null>;
}

/** Live network preview and safe external navigation for bookmark cards. */
export interface NotesBookmarkCapability {
  preview: (url: string) => Promise<BookmarkAnswer | null>;
  openExternal: (url: string) => Promise<string | null>;
}

/** Host resolution for live embeds and synced blocks. */
export interface NotesLiveReferenceCapability {
  resolve: (uri: string) => Promise<WorkspaceResolutionDto | null>;
  readSynced: (blockId: string) => Promise<SyncedReadDto | null>;
}

/** A host-controlled file export. The shared renderer never writes a file. */
export interface NotesExportCapability {
  exportPage: (blockId: string, format: NoteExportFormatId) => Promise<string | null>;
}

/** Page history is optional because not every remote adapter owns an undo stack. */
export interface NotesHistoryCapability {
  undo: () => Promise<PageUndoDto | null>;
  redo: () => Promise<PageUndoDto | null>;
  state: () => Promise<{ undo: string | null; redo: string | null } | null>;
}

/** Clipboard access is explicit so a browser host can decline it honestly. */
export interface NotesClipboardCapability {
  copyBlockLink: (id: string) => void;
}

/**
 * Optional effects a Notes host can genuinely perform.
 *
 * An absent group removes its controls and renders an explanatory fallback;
 * adapters do not install no-op functions to satisfy the presentation layer.
 */
export interface NotesHostCapabilities {
  images?: NotesImageCapability;
  bookmarks?: NotesBookmarkCapability;
  liveReferences?: NotesLiveReferenceCapability;
  export?: NotesExportCapability;
  history?: NotesHistoryCapability;
  clipboard?: NotesClipboardCapability;
}
