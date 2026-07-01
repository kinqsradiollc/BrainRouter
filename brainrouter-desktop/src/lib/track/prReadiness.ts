export type PrRollupLike = {
  isDraft?: boolean;
  mergeable?: string;
  statusCheckRollup?: unknown[];
};

export type PrReadiness = {
  state: 'ready' | 'blocked' | 'pending' | 'missing';
  passing: number;
  failing: number;
  pending: number;
  notes: string[];
};

function rollupBucket(raw: unknown): 'pass' | 'fail' | 'pending' | 'neutral' {
  if (!raw || typeof raw !== 'object') return 'neutral';
  const r = raw as Record<string, unknown>;
  const values = ['bucket', 'state', 'status', 'conclusion'].map((k) => String(r[k] ?? '').toLowerCase()).filter(Boolean);
  if (values.some((v) => ['pass', 'success', 'successful', 'completed'].includes(v)) && !values.some((v) => ['failure', 'failed', 'fail', 'cancelled', 'canceled', 'timed_out'].includes(v))) return 'pass';
  if (values.some((v) => ['failure', 'failed', 'fail', 'cancelled', 'canceled', 'timed_out', 'startup_failure'].includes(v))) return 'fail';
  if (values.some((v) => ['pending', 'queued', 'in_progress', 'waiting', 'requested', 'expected'].includes(v))) return 'pending';
  return 'neutral';
}

export function summarizePrReadiness(pr: PrRollupLike | null | undefined): PrReadiness {
  if (!pr) return { state: 'missing', passing: 0, failing: 0, pending: 0, notes: ['No pull request for this branch.'] };
  const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  let passing = 0, failing = 0, pending = 0;
  for (const c of rollup) {
    const bucket = rollupBucket(c);
    if (bucket === 'pass') passing++;
    else if (bucket === 'fail') failing++;
    else if (bucket === 'pending') pending++;
  }
  const notes: string[] = [];
  if (pr.isDraft) notes.push('Draft pull request.');
  const mergeable = String(pr.mergeable ?? '').toUpperCase();
  if (mergeable === 'CONFLICTING') notes.push('Merge conflicts detected.');
  else if (mergeable === 'UNKNOWN') notes.push('Mergeability is still being calculated.');
  if (failing) notes.push(`${failing} failing check${failing === 1 ? '' : 's'}.`);
  if (pending) notes.push(`${pending} pending check${pending === 1 ? '' : 's'}.`);
  if (!rollup.length) notes.push('No check rollup reported yet.');
  const blocked = pr.isDraft || mergeable === 'CONFLICTING' || failing > 0;
  const waiting = mergeable === 'UNKNOWN' || pending > 0;
  return { state: blocked ? 'blocked' : waiting ? 'pending' : 'ready', passing, failing, pending, notes: notes.length ? notes : ['Ready to merge.'] };
}
