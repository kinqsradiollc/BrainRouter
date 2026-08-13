/**
 * Production planner projection for issue documents already persisted by the
 * connector runtime. The connector remains the source of truth; this module
 * only maps explicit source facts into a mirrored PlannerItem.
 */
import { createHash } from 'node:crypto';
import type {
  ConnectorDocumentRecord,
  ConnectorRecord,
  ConnectorSource,
} from '@kinqs/brainrouter-types';
import type { Hlc } from '../sync/hybridClock.js';
import type { PlannerItem } from './itemMerge.js';
import type { SourceAdapter } from './sourceAdapter.js';

const SUPPORTED_ISSUE_SOURCES = new Set<ConnectorSource>([
  'github', 'gitlab', 'jira', 'linear',
]);

export interface ConnectorIssueProjectionInput {
  /** Stable product connector id, not a temporary runtime-workspace id. */
  connectorId: string;
  source: ConnectorSource;
  sourceLabel: string;
  documents: readonly ConnectorDocumentRecord[];
}

export interface PlannerProjectionSummary {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

function usableUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sourceStamp(input: ConnectorIssueProjectionInput, document: ConnectorDocumentRecord): Hlc {
  const physical = Date.parse(document.updatedAt ?? document.lastSeenAt);
  return {
    physical: Number.isFinite(physical) ? Math.max(0, physical) : 0,
    logical: 0,
    deviceId: `source:${input.connectorId}`.slice(0, 200),
  };
}

function stablePlannerId(connectorId: string, externalId: string): string {
  const digest = createHash('sha256')
    .update(connectorId)
    .update('\0')
    .update(externalId)
    .digest('hex')
    .slice(0, 32);
  return `src_${digest}`;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function estimateMinutes(metadata: Record<string, unknown>): number | undefined {
  const minutes = positiveNumber(metadata.estimateMinutes);
  if (minutes !== undefined) return minutes;
  const seconds = positiveNumber(metadata.estimateSeconds);
  return seconds === undefined ? undefined : Math.max(1, Math.round(seconds / 60));
}

function explicitBlockedReason(metadata: Record<string, unknown>): string | undefined {
  if (typeof metadata.blockedReason === 'string' && metadata.blockedReason.trim()) {
    return metadata.blockedReason.trim();
  }
  const state = [metadata.status, metadata.state]
    .find((value) => typeof value === 'string' && /\b(blocked|waiting)\b/i.test(value));
  if (typeof state === 'string') return state.trim();
  const labels = Array.isArray(metadata.labels)
    ? metadata.labels.filter((label): label is string => typeof label === 'string')
    : [];
  const label = labels.find((candidate) => /^(blocked|waiting)(?:\b|[: -])/i.test(candidate.trim()));
  return label?.trim();
}

/** Map one supported, actionable issue document. Completion is never inferred. */
export function connectorIssueToPlannerItem(
  input: ConnectorIssueProjectionInput,
  document: ConnectorDocumentRecord,
): PlannerItem | null {
  if (!SUPPORTED_ISSUE_SOURCES.has(input.source)) return null;
  if (document.kind !== 'issue' || document.source !== input.source || !usableUrl(document.url)) return null;
  const title = document.title.trim();
  if (!title) return null;

  const at = sourceStamp(input, document);
  const estimate = estimateMinutes(document.metadata);
  const blockedReason = explicitBlockedReason(document.metadata);
  const fetchedAt = document.lastSeenAt;
  return {
    id: stablePlannerId(input.connectorId, document.id),
    origin: 'mirrored',
    source: `connector:${input.connectorId}`,
    fetchedAt,
    provenance: {
      sourceId: `connector:${input.connectorId}`,
      sourceLabel: input.sourceLabel,
      externalId: document.id,
      sourceUrl: document.url,
      fetchedAt,
    },
    title: { value: title, at },
    ...(estimate !== undefined ? { estimateMinutes: estimate, estimateUpdatedAt: at } : {}),
    ...(blockedReason ? { blockedReason: { value: blockedReason, at } } : {}),
    // Intentionally no `completed`: source state may select or describe an
    // issue, but it never completes the user's planner intention by inference.
  };
}

/** A real SourceAdapter over connector issue records, including source freshness. */
export function createConnectorIssueSourceAdapter(input: ConnectorIssueProjectionInput): SourceAdapter {
  const latestFetch = input.documents
    .map((document) => document.lastSeenAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1) ?? null;
  return {
    id: `connector:${input.connectorId}`,
    label: input.sourceLabel,
    mirrored: true,
    lastFetchedAt: latestFetch,
    async list() {
      return input.documents
        .map((document) => connectorIssueToPlannerItem(input, document))
        .filter((item): item is PlannerItem => item !== null);
    },
  };
}

/*
 * `refreshLocalPlannerFromConnectorIssues` — a local/solo projection sink over
 * `readPlanner`/`writePlanner` — was **retired 2026-08-12** with no caller. Its
 * doc comment said "used by production callers that explicitly own a local
 * planner scope", and there were none: the projection that runs is the SERVER's
 * (`brainrouter/src/memory/planner/backend.ts:543`), which walks the same
 * adapter into durable rows under an authenticated scope. A second copy writing
 * a device-local file would have produced two answers to "what is mirrored
 * here", and only one of them syncs.
 *
 * `PlannerProjectionSummary` stays: it is the shape the server's projection
 * returns.
 */

export interface PlannerIssueProjectionRequest {
  connector: ConnectorRecord;
  documents: readonly ConnectorDocumentRecord[];
}

export type PlannerIssueProjection = (
  request: PlannerIssueProjectionRequest,
) => number | Promise<number>;
