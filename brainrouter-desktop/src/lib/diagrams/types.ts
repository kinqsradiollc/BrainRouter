/**
 * ADR-056 D-A5 — the renderer's view of a workspace diagram, as the host
 * queries return it. Mirrors the core receipt shape without importing core:
 * the diagram subsystem is Node-only (git, fs, crypto) and the renderer bundle
 * must stay browser-safe (rules 06 §1), so these are plain data contracts.
 */

export type DiagramKindName = 'architecture' | 'workflow' | 'sequence' | 'dataflow' | 'lifecycle';

export interface DiagramCheckView { id: string; ok: boolean; detail?: string }

export interface DiagramReceiptView {
  receiptVersion: 1;
  kind: DiagramKindName;
  title: string;
  ok: boolean;
  checks: DiagramCheckView[];
  specification: { sha256: string; bytes: number };
  artifact: { sha256: string; bytes: number; format: 'html' };
  renderer: { name: string; version: string };
  evidence: 'verified' | 'authored' | 'mixed';
}

/** One row of `diagram-list`. */
export interface DiagramListRow {
  slug: string;
  title?: string;
  kind?: DiagramKindName;
  hasHtml: boolean;
  hasReceipt: boolean;
  /** Present when a receipt exists: checks passed / total and the evidence summary. */
  checksPassed?: number;
  checksTotal?: number;
  evidence?: DiagramReceiptView['evidence'];
}

/** A source an element cites, as stored in the specification. */
export interface DiagramSourceView { path: string; lines?: [number, number]; revision?: string }

/** `diagram-read`: the artifact plus what the panel needs from the specification. */
export interface DiagramReadResult {
  slug: string;
  html: string | null;
  receipt: DiagramReceiptView | null;
  kind?: DiagramKindName;
  title?: string;
  /** Element id → its cited sources (for Open file / Open in Atlas). */
  sources: Array<{ id: string; label: string; sources: DiagramSourceView[]; evidence?: string }>;
}

export interface DiagramDeltaFactView {
  kind: 'added' | 'removed' | 'changed' | 'moved' | 'rerouted';
  subject: string;
  id: string;
  label?: string;
  fields?: Array<{ field: string; before?: string; after?: string }>;
}

/** `diagram-delta`: the working-tree specification against the one committed at `base`. */
export interface DiagramDeltaResult {
  slug: string;
  base: string;
  identical: boolean;
  counts: Record<DiagramDeltaFactView['kind'], number>;
  facts: DiagramDeltaFactView[];
  html: string | null;
  error?: string;
}
