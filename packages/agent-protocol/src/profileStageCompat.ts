/**
 * ADR-040 A40-4 — the compatibility record for current profile-stage consumers.
 *
 * The canonical execution map (executionMap.ts) is the new source of truth for a
 * run's shape. This projects a canonical execution — its record, its logical
 * nodes, and their occurrences — back onto the legacy `ProfileStageEventView`
 * that existing hosts already render via `onProfileStageUpdate`, so those hosts
 * keep working while the canonical map becomes what actually drives them.
 *
 * It is a PURE, TOTAL, LOSSY projection. Pure: no I/O, no dependencies beyond the
 * two type modules in this leaf package. Total: every canonical status and
 * selection source maps to a legacy one, no `default: throw`. Lossy on purpose:
 * the legacy palette is smaller than the canonical one, and the mappings below
 * name each place where a canonical fact is collapsed — most importantly
 * `degraded`, which the legacy palette cannot express and which is shown on the
 * VISIBLE (failed) side rather than being quietly greened into success.
 */
import type {
  ExecutionRecord,
  ExecutionLogicalNode,
  ExecutionNodeOccurrence,
  NodeOccurrenceStatus,
  SelectionSource,
} from './executionMap.js';
import type { ProfileStageEventView } from './events.js';

type LegacyStageState = ProfileStageEventView['stages'][number]['state'];
type LegacySelectionSource = ProfileStageEventView['selectionSource'];

/**
 * Canonical selection source -> the legacy four-value set. `explicit-user` is the
 * only one a person actively chose; `adaptive` is the only model-driven one;
 * `fallback-direct` is the safe baseline; the rule-based sources
 * (`workspace-default`, `inherited-goal`) are `deterministic`.
 */
export function toLegacySelectionSource(source: SelectionSource): LegacySelectionSource {
  switch (source) {
    case 'explicit-user': return 'explicit';
    case 'adaptive': return 'adaptive-model';
    case 'fallback-direct': return 'fallback';
    case 'workspace-default': return 'deterministic';
    case 'inherited-goal': return 'deterministic';
    default: return 'deterministic';
  }
}

/**
 * Canonical occurrence status -> the legacy stage palette. The lossy edges are
 * named: `waiting-approval` is still in flight, so it reads as `running`;
 * `interrupted` was a Stop, not an error, so it reads as `cancelled`; `blocked`
 * never proceeded, so it reads as `failed`; and `degraded` — a run that produced
 * a result but lost part of what was asked — has no legacy equivalent and is NOT
 * collapsed into `succeeded`, because "it mostly worked" reading as "it worked"
 * is exactly the failure A40-7 removed. It reads as `failed`: the visible side.
 */
export function toLegacyStageState(status: NodeOccurrenceStatus): LegacyStageState {
  switch (status) {
    case 'planned': return 'planned';
    case 'running': return 'running';
    case 'waiting-approval': return 'running';
    case 'succeeded': return 'succeeded';
    case 'degraded': return 'failed';
    case 'failed': return 'failed';
    case 'blocked': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'interrupted': return 'cancelled';
    case 'skipped': return 'skipped';
    default: return 'failed';
  }
}

const TERMINAL = new Set<string>([
  'succeeded', 'degraded', 'failed', 'blocked', 'cancelled', 'interrupted',
]);

/**
 * Pick the occurrence that represents a node's CURRENT state: the latest attempt,
 * and within an attempt the deepest iteration. A retried node shows its retry,
 * not its first try.
 */
function latestOccurrence(
  occurrences: readonly ExecutionNodeOccurrence[],
): ExecutionNodeOccurrence | undefined {
  let best: ExecutionNodeOccurrence | undefined;
  for (const occ of occurrences) {
    if (!best) { best = occ; continue; }
    if (occ.attempt > best.attempt) { best = occ; continue; }
    if (occ.attempt === best.attempt && occ.iterationPath.length >= best.iterationPath.length) best = occ;
  }
  return best;
}

/**
 * Project a canonical execution onto the legacy profile-stage view. `nodes` order
 * is preserved as the stage order — the view is a flat, ordered stage list.
 */
export function projectProfileStageView(
  record: ExecutionRecord,
  nodes: readonly ExecutionLogicalNode[],
  occurrences: readonly ExecutionNodeOccurrence[],
): ProfileStageEventView {
  const byNode = new Map<string, ExecutionNodeOccurrence[]>();
  for (const occ of occurrences) {
    const list = byNode.get(occ.nodeId);
    if (list) list.push(occ);
    else byNode.set(occ.nodeId, [occ]);
  }

  const stages = nodes.map((node) => {
    const latest = latestOccurrence(byNode.get(node.nodeId) ?? []);
    return {
      id: node.nodeId,
      state: toLegacyStageState(latest?.status ?? 'planned'),
      // The legacy view knows only primary vs role; a node with a declared role
      // is a role executor, everything else is primary.
      executor: (node.roleId ? 'role' : 'primary') as 'primary' | 'role',
      ...(node.roleId ? { roleId: node.roleId } : {}),
      skillIds: [...node.skillIds],
      // Canonical occurrences do not track a single "active" skill, so the compat
      // view does not invent one.
    };
  });

  // `terminated` once the run is terminal; before that, `resolved` while nothing
  // has run yet (the profile was just chosen), `updated` once work has occurred.
  const phase: ProfileStageEventView['phase'] = TERMINAL.has(record.status)
    ? 'terminated'
    : occurrences.length === 0 ? 'resolved' : 'updated';

  return {
    phase,
    workspaceProfileId: record.workspaceProfileId,
    ...(record.planProfileId !== undefined ? { planProfileId: record.planProfileId } : {}),
    // The deprecated alias mirrors the plan profile, falling back to the
    // workspace profile so it is never empty for a legacy reader.
    profileId: record.planProfileId ?? record.workspaceProfileId,
    strategyId: record.strategyId ?? '',
    selectionSource: toLegacySelectionSource(record.selectionSource),
    stages,
  };
}
