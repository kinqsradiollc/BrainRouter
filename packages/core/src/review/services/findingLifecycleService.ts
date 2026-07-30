/**
 * Port-backed finding lifecycle reconciliation.
 *
 * Core calculates deterministic transitions; the host persists them
 * idempotently. Incomplete evidence is passed through unchanged so absence can
 * never auto-fix a durable finding.
 */

import {
  reconcileFindingLifecycle,
  type LifecycleTransition,
} from '../domain/findingLifecycle.js';
import type {
  AssuranceFindingLifecyclePort,
  ReconcileAssuranceLifecycleInput,
} from '../ports/assurance.js';

export class AssuranceFindingLifecycleService {
  constructor(private readonly findings: AssuranceFindingLifecyclePort) {}

  async reconcile(input: ReconcileAssuranceLifecycleInput): Promise<LifecycleTransition[]> {
    const previous = await this.findings.listCurrent(input.scope);
    const result = reconcileFindingLifecycle({
      lens: input.scope.program,
      previous,
      incoming: input.incoming,
      complete: input.complete,
    });
    await this.findings.apply(input.scope, result.transitions);
    return result.transitions;
  }
}

export function createAssuranceFindingLifecycleService(
  findings: AssuranceFindingLifecyclePort,
): AssuranceFindingLifecycleService {
  return new AssuranceFindingLifecycleService(findings);
}
