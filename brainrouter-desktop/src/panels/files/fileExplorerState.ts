import { useEffect, useSyncExternalStore } from 'react';

const STORAGE_PREFIX = 'br-file-explorer-v1:';
const MAX_FILTER_LENGTH = 200;
const MAX_SELECTED_PATH_LENGTH = 1_000;
const MAX_EXPANDED_PATH_LENGTH = 500;
const MAX_EXPANDED_PATHS = 200;

export interface FileExplorerState {
  filter: string;
  expanded: readonly string[];
  selectedPath: string | null;
}

interface FileExplorerEntry {
  state: FileExplorerState;
  listeners: Set<() => void>;
}

const EMPTY_STATE: FileExplorerState = Object.freeze({
  filter: '',
  expanded: Object.freeze([]),
  selectedPath: null,
});

const entries = new Map<string, FileExplorerEntry>();

function storageKey(workspaceKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(workspaceKey)}`;
}

function isSafeRelativePath(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.split('/').includes('..');
}

export function parseFileExplorerState(raw: string | null): FileExplorerState {
  if (!raw) return EMPTY_STATE;
  try {
    const value = JSON.parse(raw) as {
      filter?: unknown;
      expanded?: unknown;
      selectedPath?: unknown;
    };
    const filter = typeof value.filter === 'string'
      ? value.filter.slice(0, MAX_FILTER_LENGTH)
      : '';
    const expanded = Array.isArray(value.expanded)
      ? [...new Set(value.expanded.filter((path) => isSafeRelativePath(path, MAX_EXPANDED_PATH_LENGTH)))].slice(0, MAX_EXPANDED_PATHS)
      : [];
    const selectedPath = isSafeRelativePath(value.selectedPath, MAX_SELECTED_PATH_LENGTH)
      ? value.selectedPath
      : null;
    return { filter, expanded, selectedPath };
  } catch {
    return EMPTY_STATE;
  }
}

export function pruneFileExplorerState(state: FileExplorerState, files: readonly string[]): FileExplorerState {
  const fileSet = new Set(files);
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  const expanded = state.expanded.filter((path) => directories.has(path));
  const selectedPath = state.selectedPath && fileSet.has(state.selectedPath) ? state.selectedPath : null;
  if (
    expanded.length === state.expanded.length
    && expanded.every((path, index) => path === state.expanded[index])
    && selectedPath === state.selectedPath
  ) return state;
  return { ...state, expanded, selectedPath };
}

function readStoredState(workspaceKey: string): FileExplorerState {
  if (typeof localStorage === 'undefined') return EMPTY_STATE;
  try {
    return parseFileExplorerState(localStorage.getItem(storageKey(workspaceKey)));
  } catch {
    return EMPTY_STATE;
  }
}

function ensureEntry(workspaceKey: string): FileExplorerEntry {
  const current = entries.get(workspaceKey);
  if (current) return current;
  const entry = { state: readStoredState(workspaceKey), listeners: new Set<() => void>() };
  entries.set(workspaceKey, entry);
  return entry;
}

function publish(workspaceKey: string, next: FileExplorerState): void {
  const entry = ensureEntry(workspaceKey);
  entry.state = next;
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(storageKey(workspaceKey), JSON.stringify(next)); } catch { /* presentation state is best effort */ }
  }
  for (const listener of entry.listeners) listener();
}

export interface FileExplorerStateApi {
  state: FileExplorerState;
  setFilter: (filter: string) => void;
  toggleExpanded: (path: string) => void;
  select: (path: string) => void;
}

export function useFileExplorerState(workspaceKey: string, files: readonly string[], filesReady = true): FileExplorerStateApi {
  const subscribe = (listener: () => void): (() => void) => {
    const entry = ensureEntry(workspaceKey);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  };
  const getSnapshot = (): FileExplorerState => ensureEntry(workspaceKey).state;
  const state = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_STATE);

  useEffect(() => {
    if (!filesReady) return;
    const current = ensureEntry(workspaceKey).state;
    const pruned = pruneFileExplorerState(current, files);
    if (pruned !== current) publish(workspaceKey, pruned);
  }, [workspaceKey, files, filesReady]);

  return {
    state,
    setFilter: (filter) => publish(workspaceKey, {
      ...ensureEntry(workspaceKey).state,
      filter: filter.slice(0, MAX_FILTER_LENGTH),
    }),
    toggleExpanded: (path) => {
      if (!isSafeRelativePath(path, MAX_EXPANDED_PATH_LENGTH)) return;
      const current = ensureEntry(workspaceKey).state;
      const expanded = new Set(current.expanded);
      if (expanded.has(path)) expanded.delete(path);
      else if (expanded.size < MAX_EXPANDED_PATHS) expanded.add(path);
      publish(workspaceKey, { ...current, expanded: [...expanded] });
    },
    select: (path) => {
      if (!isSafeRelativePath(path, MAX_SELECTED_PATH_LENGTH)) return;
      publish(workspaceKey, { ...ensureEntry(workspaceKey).state, selectedPath: path });
    },
  };
}

/** Test-only reset for the renderer-local shared presentation store. */
export function __resetFileExplorerState(): void {
  entries.clear();
}
