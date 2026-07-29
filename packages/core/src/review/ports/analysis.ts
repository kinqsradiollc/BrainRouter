/**
 * Host-neutral source, index, and impact-packet ports.
 *
 * Core coordinates exact-revision work through opaque references. Git
 * credentials, checkout paths, parser handles, and retained source bodies stay
 * inside the host adapters that implement these ports.
 */

import type {
  AssembleAssuranceImpactPacketsInput,
  AssuranceCodeIndexResult,
  AssuranceImpactPacketAssembly,
  PrepareAssuranceSourceInput,
  PrepareAssuranceSourceResult,
  UpdateAssuranceIndexInput,
} from '@kinqs/brainrouter-types/review';

export interface AssuranceOperationCancellation {
  isCancellationRequested(): boolean | Promise<boolean>;
}

export interface RepositoryAssuranceSourcePort {
  prepare(
    input: PrepareAssuranceSourceInput,
    cancellation?: AssuranceOperationCancellation,
  ): Promise<PrepareAssuranceSourceResult>;
  release(checkoutRef: string): Promise<void>;
}

export interface RepositoryAssuranceIndexPort {
  update(
    input: UpdateAssuranceIndexInput,
    cancellation?: AssuranceOperationCancellation,
  ): Promise<AssuranceCodeIndexResult>;
  release(indexRef: string): Promise<void>;
}

export interface RepositoryAssuranceImpactPort {
  assemble(input: AssembleAssuranceImpactPacketsInput): Promise<AssuranceImpactPacketAssembly>;
}
