/**
 * ADR-038 — plain browser presentation contracts for the shared Planner.
 *
 * These are projections, not storage or wire records. Desktop can map its
 * local-first cache and Dashboard can map stamped API records without making
 * this package depend on either host or on Core's Node-capable planner barrel.
 */
import type { ReactNode } from 'react';

export interface PlannerItemView {
  id: string;
  title: string;
  notes?: string;
  dueDate?: string;
  priority?: number;
  completed: boolean;
  origin: 'owned' | 'mirrored';
  /** Structured source identity; legacy source fields remain accepted below. */
  provenance?: PlannerProvenanceView;
  source?: string;
  sourceUrl?: string;
  sourceKind?: string;
  sourceUpdatedAt?: string;
  externalId?: string;
  /** Item-level planning metadata survives source refreshes. */
  estimateMinutes?: number;
  blockedReason?: string;
  /** Host-resolved local actions; omitted capabilities default to owned-only. */
  capabilities?: PlannerItemCapabilities;
  sourceFreshness?: PlannerSourceFreshnessView;
  /** Both retained versions, named neutrally because neither host can infer authorship. */
  conflicts?: PlannerConflictView[];
  /** Compatibility field for hosts that can only project conflict names. */
  conflictFields: string[];
}

export interface PlannerConflictView {
  field: string;
  versionA: { label: string; value: string };
  versionB: { label: string; value: string };
}

export interface PlannerItemCapabilities {
  editTitle?: boolean;
  complete?: boolean;
  delete?: boolean;
}

export interface PlannerProvenanceView {
  source: string;
  kind?: string;
  externalId?: string;
  url?: string;
  fetchedAt?: string;
  updatedAt?: string;
}

export interface PlannerSourceFreshnessView {
  label?: string;
  fetchedAt?: string;
  updatedAt?: string;
  stale: boolean;
}

export interface PlannerBlockView {
  id: string;
  itemId: string;
  scheduledFor?: string;
  estimateMinutes: number;
  actualMinutes?: number;
  carriedOver: number;
  completedAt?: string;
}

export type PlannerView = 'today' | 'calendar' | 'notes';
export type TodayGroup = 'overdue' | 'due' | 'scheduled' | 'next' | 'anytime';

export interface PlannerSyncIssue {
  id: string;
  entity: 'item' | 'block';
  itemId?: string;
  itemTitle?: string;
  action: string;
  createdAt?: string;
  ageLabel?: string;
  attempts: number;
  lastError?: string;
  stuck: boolean;
  /**
   * A targeted retry has been asked for and has not resolved.
   *
   * The control hides while this is true. Showing it after the click makes the
   * surface stop acknowledging the action — the row looks identical before and
   * after, so the only feedback is that nothing happened, and the obvious
   * response is to click again.
   */
  retryRequested?: boolean;
}

export interface PlannerSyncView {
  label: string;
  pendingCount: number;
  issues: PlannerSyncIssue[];
  retrying?: boolean;
  lastSyncedAt?: string;
  onRetry?: () => void;
  onRetryIssue?: (issueId: string) => void;
}

export interface PlannerOps {
  addItem?: (title: string) => void;
  toggleComplete?: (id: string, completed: boolean) => void;
  setDueDate?: (id: string, date: string | null) => void;
  deleteItem?: (id: string) => void;
  scheduleBlock?: (itemId: string, minutes: number, at?: string) => void;
  /** Move an existing time block without creating or replacing its item. */
  rescheduleBlock?: (blockId: string, scheduledFor: string) => void;
  /** Close a block with measured time so estimate drift is actionable. */
  recordActual?: (blockId: string, actualMinutes: number) => void;
  resolveConflict?: (id: string, field: string, keep: 'ours' | 'theirs') => void;
  blockTimeAt?: (iso: string) => void;
  openNotesPage?: (itemId: string, title: string, notes: string) => void;
  openRef?: (uri: string) => void;
  openSource?: (url: string) => void;
}

export interface PlannerSurfaceProps {
  items: PlannerItemView[];
  blocks: PlannerBlockView[];
  today: string;
  sync: PlannerSyncView;
  staleSources?: string[];
  driftNote?: string | null;
  refLabels?: Record<string, string>;
  ops: PlannerOps;
  initialView?: PlannerView;
  renderNotesText?: (text: string, labels: Record<string, string>, onOpen?: (uri: string) => void) => ReactNode;
}
