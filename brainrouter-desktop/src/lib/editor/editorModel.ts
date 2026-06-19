/**
 * Pure editor-tab state — no React, so the dirty/save/revert/close transitions
 * are unit-testable. The useEditor hook holds an EditorTab[] and drives it
 * through these helpers; EditorPanel renders it.
 */
import { monacoLanguage } from './language.js';

export interface EditorTab {
  path: string;
  /** the live buffer */
  content: string;
  /** the last-saved (on-disk) content — dirty = content !== saved */
  saved: string;
  /** last-known on-disk mtime, round-tripped to action:file-save for stale-write detection */
  mtimeMs?: number;
  size?: number;
  language: string;
  /** truncated/oversized → editable surface is locked */
  readOnly: boolean;
  /** binary → no editor, a preview card instead */
  binary: boolean;
  truncated: boolean;
}

/** The shape returned by the host `file-read` query (subset we consume). */
export interface FileReadResult {
  path: string;
  kind?: 'file' | 'directory';
  content?: string;
  mtimeMs?: number;
  size?: number;
  binary?: boolean;
  truncated?: boolean;
  error?: string;
}

export function isDirty(tab: EditorTab): boolean {
  return !tab.readOnly && !tab.binary && tab.content !== tab.saved;
}
export function anyDirty(tabs: EditorTab[]): boolean {
  return tabs.some(isDirty);
}
export function dirtyPaths(tabs: EditorTab[]): string[] {
  return tabs.filter(isDirty).map((t) => t.path);
}
export function findTab(tabs: EditorTab[], path: string): EditorTab | undefined {
  return tabs.find((t) => t.path === path);
}

/** Build a tab from a host file-read payload. Binary/truncated files open read-only. */
export function tabFromRead(r: FileReadResult): EditorTab {
  const content = r.content ?? '';
  return {
    path: r.path,
    content,
    saved: content,
    mtimeMs: r.mtimeMs,
    size: r.size,
    language: monacoLanguage(r.path),
    binary: !!r.binary,
    truncated: !!r.truncated,
    readOnly: !!r.binary || !!r.truncated,
  };
}

/** Open (or refresh) a tab. If the path is already open AND dirty, the existing
 *  buffer is preserved (we don't clobber unsaved edits on a re-open). */
export function openTab(tabs: EditorTab[], r: FileReadResult): EditorTab[] {
  const existing = findTab(tabs, r.path);
  if (existing && isDirty(existing)) return tabs; // keep unsaved edits
  const next = tabFromRead(r);
  if (existing) return tabs.map((t) => (t.path === r.path ? next : t));
  return [...tabs, next];
}

/** Update the live buffer for a path (typing). No-op for read-only/binary tabs. */
export function setContent(tabs: EditorTab[], path: string, content: string): EditorTab[] {
  return tabs.map((t) => (t.path === path && !t.readOnly && !t.binary ? { ...t, content } : t));
}

/** Mark a tab saved after a successful action:file-save (clears dirty). */
export function markSaved(tabs: EditorTab[], path: string, content: string, mtimeMs?: number): EditorTab[] {
  return tabs.map((t) => (t.path === path ? { ...t, saved: content, content, mtimeMs: mtimeMs ?? t.mtimeMs } : t));
}

/** Revert a tab's buffer back to the last-saved content. */
export function revertTab(tabs: EditorTab[], path: string): EditorTab[] {
  return tabs.map((t) => (t.path === path ? { ...t, content: t.saved } : t));
}

/** Remove a tab; returns the new tab list. */
export function closeTab(tabs: EditorTab[], path: string): EditorTab[] {
  return tabs.filter((t) => t.path !== path);
}

export function reorderTabs(tabs: EditorTab[], draggedPath: string, targetPath: string): EditorTab[] {
  const from = tabs.findIndex((t) => t.path === draggedPath);
  const to = tabs.findIndex((t) => t.path === targetPath);
  if (from < 0 || to < 0 || from === to) return tabs;
  const next = [...tabs];
  const [tab] = next.splice(from, 1);
  next.splice(from < to ? to - 1 : to, 0, tab);
  return next;
}

/** Pick the active path after closing `closed`, given the prior active path. */
export function nextActivePath(tabs: EditorTab[], closed: string, prevActive: string | null): string | null {
  const remaining = tabs.filter((t) => t.path !== closed);
  if (remaining.length === 0) return null;
  if (prevActive && prevActive !== closed && remaining.some((t) => t.path === prevActive)) return prevActive;
  const idx = tabs.findIndex((t) => t.path === closed);
  return (remaining[Math.min(idx, remaining.length - 1)] ?? remaining[remaining.length - 1]).path;
}
