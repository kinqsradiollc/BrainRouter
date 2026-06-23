/**
 * useEditor — the editor's state + host round-trips, self-contained (it owns its
 * own `ed:`-namespaced query ids + onEvent subscription, like TerminalPanel) so
 * it barely touches App's main event loop. Reads/writes go through the host
 * file-read / action:file-save endpoints (never the renderer fs).
 */
import { useEffect, useRef, useState } from 'react';
import {
  openTab, setContent, markSaved, revertTab, closeTab, nextActivePath,
  reorderTabs, isDirty, anyDirty, dirtyPaths, findTab, type EditorTab, type FileReadResult,
} from './editorModel.js';

interface SaveResult { ok?: boolean; mtimeMs?: number; conflict?: boolean; error?: string }

export interface EditorApi {
  tabs: EditorTab[];
  activePath: string | null;
  conflictPaths: string[];
  saving: boolean;
  anyDirty: boolean;
  /** When set, the editor should reveal this line of `path`. `seq` bumps on every
   *  request so the same path+line re-triggers a reveal (e.g. re-clicking a symbol). */
  revealLine: { path: string; line: number; seq: number } | null;
  open: (path: string, line?: number) => void;
  select: (path: string) => void;
  change: (path: string, content: string) => void;
  save: (path: string) => void;
  saveAll: () => void;
  revert: (path: string) => void;
  close: (path: string) => void;
  reorder: (draggedPath: string, targetPath: string) => void;
}

export function useEditor(opts?: { workspaceRoot?: string | null; onSaved?: (path: string) => void; onToast?: (msg: string) => void }): EditorApi {
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [conflictPaths, setConflictPaths] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [revealLine, setRevealLine] = useState<{ path: string; line: number; seq: number } | null>(null);
  const revealSeq = useRef(0);

  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const optsRef = useRef(opts); optsRef.current = opts;
  const workspaceRootRef = useRef(opts?.workspaceRoot); workspaceRootRef.current = opts?.workspaceRoot;
  const pendingSave = useRef<Record<string, string>>({});

  useEffect(() => {
    const off = window.brainrouter.onEvent((msg) => {
      const resultRoot = (msg as { workspaceRoot?: string }).workspaceRoot;
      if (resultRoot && workspaceRootRef.current && resultRoot !== workspaceRootRef.current) return;
      const e = msg.event as { kind: string; id?: string; ok?: boolean; result?: unknown };
      if (e.kind !== 'query-result' || !e.id || !e.id.startsWith('ed:')) return;
      const parts = e.id.split(':');
      const op = parts[1];
      const path = parts.slice(2).join(':');
      if (op === 'read') {
        const r = e.result as FileReadResult | undefined;
        if (!r) return;
        if (r.error) { optsRef.current?.onToast?.(`Can't open ${path}: ${r.error}`); return; }
        if (r.kind === 'directory') return; // directories belong to the Files tree
        setTabs((ts) => openTab(ts, r));
        setActivePath(r.path);
      } else if (op === 'save') {
        setSaving(false);
        const r = e.result as SaveResult | undefined;
        if (r?.ok) {
          const saved = pendingSave.current[path];
          delete pendingSave.current[path];
          setTabs((ts) => markSaved(ts, path, saved ?? (findTab(ts, path)?.content ?? ''), r.mtimeMs));
          setConflictPaths((c) => c.filter((p) => p !== path));
          optsRef.current?.onSaved?.(path);
        } else if (r?.conflict) {
          setConflictPaths((c) => (c.includes(path) ? c : [...c, path]));
          optsRef.current?.onToast?.(`${path} changed on disk — save was blocked.`);
        } else {
          optsRef.current?.onToast?.(`Save failed: ${r?.error ?? 'unknown error'}`);
        }
      }
    });
    return off;
  }, []);

  const open = (path: string, line?: number): void => {
    if (typeof line === 'number' && line > 0) {
      revealSeq.current += 1;
      setRevealLine({ path, line, seq: revealSeq.current });
    }
    const existing = findTab(tabsRef.current, path);
    if (existing) { setActivePath(path); if (!isDirty(existing)) sendRead(path); return; }
    sendRead(path);
  };
  const sendRead = (path: string): void => {
    window.brainrouter.send({ kind: 'query', id: `ed:read:${path}`, name: 'file-read', args: { path } });
  };
  const select = (path: string): void => setActivePath(path);
  const change = (path: string, content: string): void => setTabs((ts) => setContent(ts, path, content));
  const save = (path: string): void => {
    const tab = findTab(tabsRef.current, path);
    if (!tab || !isDirty(tab)) return;
    pendingSave.current[path] = tab.content;
    setSaving(true);
    setConflictPaths((c) => c.filter((p) => p !== path));
    window.brainrouter.send({ kind: 'query', id: `ed:save:${path}`, name: 'action:file-save', args: { path, content: tab.content, expectedMtimeMs: tab.mtimeMs } });
  };
  const saveAll = (): void => { for (const p of dirtyPaths(tabsRef.current)) save(p); };
  const revert = (path: string): void => setTabs((ts) => revertTab(ts, path));
  const close = (path: string): void => {
    setActivePath((a) => nextActivePath(tabsRef.current, path, a));
    setTabs((ts) => closeTab(ts, path));
    setConflictPaths((c) => c.filter((p) => p !== path));
  };
  const reorder = (draggedPath: string, targetPath: string): void => {
    setTabs((ts) => reorderTabs(ts, draggedPath, targetPath));
  };

  return { tabs, activePath, conflictPaths, saving, anyDirty: anyDirty(tabs), revealLine, open, select, change, save, saveAll, revert, close, reorder };
}
