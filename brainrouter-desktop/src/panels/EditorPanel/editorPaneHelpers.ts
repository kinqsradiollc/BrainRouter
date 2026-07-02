/**
 * Small, dependency-light helpers shared by EditorPanel and its extracted
 * sub-components — the pane id union, a byte formatter for the binary-file card,
 * and the quiet drag-image trick for the tab strip. Kept browser-safe (no node
 * imports) so the renderer bundle stays clean.
 */
import React from 'react';

export type EditorPaneId = 'primary' | 'secondary';

export function fmtBytes(n?: number): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function setQuietDragImage(e: React.DragEvent<HTMLElement>): void {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  e.dataTransfer.setDragImage(canvas, 0, 0);
}
