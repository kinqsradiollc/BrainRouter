/**
 * CONNECTORS (parity, desktop connector catalog) — pure presentation helpers
 * for the Connectors panel. The host owns the catalog + ingestion runtime
 * (`connectors-catalog`/`connectors-list`); this shapes a ConnectorRecord[] for
 * display (sort by health, status label, counts, error flag, last-activity,
 * subtitle) so the logic is unit-testable without the host.
 */
import type { ConnectorRecord, ConnectorStatus } from '@kinqs/brainrouter-types';

/** Sort priority: active first (healthy), then error (needs attention), paused, deleting. */
const STATUS_ORDER: Record<ConnectorStatus, number> = { active: 0, error: 1, paused: 2, deleting: 3 };

/** By health then name (A→Z). Pure — never mutates the input array. */
export function sortConnectors(records: ConnectorRecord[]): ConnectorRecord[] {
  return [...records].sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    return s !== 0 ? s : a.name.localeCompare(b.name);
  });
}

/** Capitalize a status for a pill: "active" → "Active". */
export function connectorStatusLabel(status: ConnectorStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Tally by status (every key present) plus a total. */
export function connectorCounts(
  records: ConnectorRecord[],
): Record<ConnectorStatus, number> & { total: number } {
  const counts = { active: 0, paused: 0, error: 0, deleting: 0, total: 0 } as
    Record<ConnectorStatus, number> & { total: number };
  for (const r of records) {
    counts[r.status] += 1;
    counts.total += 1;
  }
  return counts;
}

/** Needs attention: error status OR a recorded lastError string. */
export function hasError(record: ConnectorRecord): boolean {
  return record.status === 'error' || Boolean(record.lastError);
}

/** A short activity word derived from the run fields (no wall-clock, so it's pure). */
export function lastActivityLabel(record: ConnectorRecord): string {
  if (record.lastError) return 'Error';
  if (record.lastSuccessAt) return 'Synced';
  if (record.lastRunAt) return 'Ran';
  return 'Never run';
}

/** List-row subtitle: "github · 2 flows" (pluralized). */
export function connectorSubtitle(record: ConnectorRecord): string {
  const flows = record.flows.length;
  return `${record.source} · ${flows} flow${flows === 1 ? '' : 's'}`;
}
