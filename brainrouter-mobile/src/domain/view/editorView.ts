import type { EditorTab } from './editorModel.js';

export interface EditorCursor {
  line: number;
  column: number;
}

export interface EditorViewPrefs {
  wordWrap: boolean;
  minimap: boolean;
}

export function parseEditorViewPrefs(rawWrap: string | null, rawMinimap: string | null): EditorViewPrefs {
  return {
    wordWrap: rawWrap === '1',
    minimap: rawMinimap === '1',
  };
}

export function serializeEditorPref(value: boolean): string {
  return value ? '1' : '0';
}

export function editorBreadcrumbs(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function editorBasename(path: string): string {
  return editorBreadcrumbs(path).pop() ?? path;
}

export function editorStatusItems(tab: EditorTab, cursor: EditorCursor): string[] {
  const items = [
    `Ln ${Math.max(1, cursor.line)}, Col ${Math.max(1, cursor.column)}`,
    tab.language || 'plaintext',
    'UTF-8',
  ];
  if (tab.size !== undefined) items.push(formatEditorBytes(tab.size));
  if (tab.readOnly) items.push('read-only');
  return items;
}

export function formatEditorBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
