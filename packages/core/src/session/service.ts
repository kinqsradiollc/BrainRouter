/**
 * Session service (ADR-008, Wave 2) — a per-workspace port over the transcript /
 * session store. A workspace holds many sessions, so the facade binds
 * `workspaceRoot` at construction and keeps `sessionKey` a per-call argument.
 * Additive and behaviour-preserving: every method delegates to the existing
 * sessionStore functions. The pure redaction / classification helpers stay
 * importable as module-level utilities. No logic moved or removed.
 */
import {
  appendTranscriptEntry, readTranscriptEntries, rewindTranscript, readTranscriptTail,
  transcriptExists, transcriptSizeBytes, getTranscriptPath, deleteSession, forkSession,
  listTranscripts, loadTranscript, type TranscriptEntry, type TranscriptSummary,
} from "./sessionStore.js";

/** Entry accepted by {@link ISessionService.append} — the store's exact shape. */
export type AppendEntryInput = Parameters<typeof appendTranscriptEntry>[2];
/** Result of {@link ISessionService.rewind} — the store's exact shape. */
export type RewindResult = ReturnType<typeof rewindTranscript>;
/** Options accepted by {@link ISessionService.list} — the store's exact shape. */
export type ListTranscriptsOptions = Parameters<typeof listTranscripts>[1];

/** The transcript/session store contract, scoped to one workspace. */
export interface ISessionService {
  append(sessionKey: string, entry: AppendEntryInput): void;
  read(sessionKey: string, limit?: number): TranscriptEntry[];
  rewind(sessionKey: string, targetIndex: number): RewindResult;
  readTail(sessionKey: string, maxEntries?: number, maxCharsPerEntry?: number): TranscriptEntry[];
  exists(sessionKey: string): boolean;
  sizeBytes(sessionKey: string): number;
  transcriptPath(sessionKey: string): string;
  delete(sessionKey: string): boolean;
  fork(sessionKey: string, upToTs?: number): string | null;
  list(opts?: ListTranscriptsOptions): TranscriptSummary[];
  load(sessionKey: string): TranscriptEntry[];
}

/** {@link ISessionService} backed by the in-process session store — delegates only. */
export class SessionService implements ISessionService {
  constructor(private readonly workspaceRoot: string) {}
  append(sessionKey: string, entry: AppendEntryInput): void {
    return appendTranscriptEntry(this.workspaceRoot, sessionKey, entry);
  }
  read(sessionKey: string, limit?: number): TranscriptEntry[] {
    return limit === undefined
      ? readTranscriptEntries(this.workspaceRoot, sessionKey)
      : readTranscriptEntries(this.workspaceRoot, sessionKey, limit);
  }
  rewind(sessionKey: string, targetIndex: number): RewindResult {
    return rewindTranscript(this.workspaceRoot, sessionKey, targetIndex);
  }
  readTail(sessionKey: string, maxEntries?: number, maxCharsPerEntry?: number): TranscriptEntry[] {
    return readTranscriptTail(this.workspaceRoot, sessionKey, maxEntries, maxCharsPerEntry);
  }
  exists(sessionKey: string): boolean {
    return transcriptExists(this.workspaceRoot, sessionKey);
  }
  sizeBytes(sessionKey: string): number {
    return transcriptSizeBytes(this.workspaceRoot, sessionKey);
  }
  transcriptPath(sessionKey: string): string {
    return getTranscriptPath(this.workspaceRoot, sessionKey);
  }
  delete(sessionKey: string): boolean {
    return deleteSession(this.workspaceRoot, sessionKey);
  }
  fork(sessionKey: string, upToTs?: number): string | null {
    return forkSession(this.workspaceRoot, sessionKey, upToTs);
  }
  list(opts?: ListTranscriptsOptions): TranscriptSummary[] {
    return opts === undefined ? listTranscripts(this.workspaceRoot) : listTranscripts(this.workspaceRoot, opts);
  }
  load(sessionKey: string): TranscriptEntry[] {
    return loadTranscript(this.workspaceRoot, sessionKey);
  }
}

/** Construct a session service bound to a workspace. */
export function createSessionService(workspaceRoot: string): ISessionService {
  return new SessionService(workspaceRoot);
}
