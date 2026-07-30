/**
 * Backend adapter for one tenant- and run-bound assurance finding collection.
 *
 * Core sees the minimal finding port while the backend pins every operation to
 * the worker's organization and exact durable run.
 */

import type { AssuranceFinding } from "@kinqs/brainrouter-types/review";
import type { AssuranceFindingPort } from "@kinqs/brainrouter-core/review";

export interface RepositoryAssuranceFindingPersistenceStore {
  getRepositoryAssuranceFinding(
    orgId: string,
    runId: string,
    findingId: string,
  ): Promise<AssuranceFinding | null>;
  saveRepositoryAssuranceFinding(input: {
    orgId: string;
    runId: string;
    finding: AssuranceFinding;
  }): Promise<AssuranceFinding>;
}

export interface BackendAssuranceFindingPortContext {
  organizationId: string;
  runId: string;
}

export class BackendAssuranceFindingPort implements AssuranceFindingPort {
  constructor(
    private readonly store: RepositoryAssuranceFindingPersistenceStore,
    private readonly context: BackendAssuranceFindingPortContext,
  ) {
    if (!context.organizationId.trim()) {
      throw new Error("Assurance finding port organization id must be non-empty.");
    }
    if (!context.runId.trim()) {
      throw new Error("Assurance finding port run id must be non-empty.");
    }
  }

  get(findingId: string): Promise<AssuranceFinding | null> {
    return this.store.getRepositoryAssuranceFinding(
      this.context.organizationId,
      this.context.runId,
      findingId,
    );
  }

  save(finding: AssuranceFinding): Promise<AssuranceFinding> {
    return this.store.saveRepositoryAssuranceFinding({
      orgId: this.context.organizationId,
      runId: this.context.runId,
      finding,
    });
  }
}

export function createBackendAssuranceFindingPort(
  store: RepositoryAssuranceFindingPersistenceStore,
  context: BackendAssuranceFindingPortContext,
): BackendAssuranceFindingPort {
  return new BackendAssuranceFindingPort(store, context);
}
