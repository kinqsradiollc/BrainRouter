/**
 * Pure identity and lifecycle policy for durable assurance receipts.
 *
 * Keeping these rules free of SQL makes the state matrix directly testable and
 * prevents adapter call sites from inventing alternate transitions.
 */

import { createHash } from "node:crypto";
import type {
  AssuranceRunStatus,
  AssuranceStageStatus,
  RepositoryAssuranceRun,
  SourceSnapshotStatus,
} from "@kinqs/brainrouter-types/review";

const RUN_TRANSITIONS: Record<AssuranceRunStatus, ReadonlySet<AssuranceRunStatus>> = {
  queued: new Set(["running", "failed", "canceled", "superseded", "stale"]),
  running: new Set(["partial", "completed", "failed", "canceled", "superseded", "stale"]),
  partial: new Set(["superseded", "stale"]),
  completed: new Set(["superseded", "stale"]),
  failed: new Set(["superseded", "stale"]),
  canceled: new Set(["superseded", "stale"]),
  superseded: new Set(),
  stale: new Set(),
};

const STAGE_TRANSITIONS: Record<AssuranceStageStatus, ReadonlySet<AssuranceStageStatus>> = {
  pending: new Set(["running", "skipped", "canceled"]),
  running: new Set(["succeeded", "partial", "failed", "canceled"]),
  succeeded: new Set(),
  partial: new Set(),
  failed: new Set(),
  skipped: new Set(),
  canceled: new Set(),
};

const SOURCE_TRANSITIONS: Record<SourceSnapshotStatus, ReadonlySet<SourceSnapshotStatus>> = {
  pending: new Set(["ready", "partial", "failed", "stale"]),
  ready: new Set(["stale"]),
  partial: new Set(["stale"]),
  failed: new Set(["stale"]),
  stale: new Set(),
};

export function normalizedRepositorySlug(run: RepositoryAssuranceRun): string {
  const slug = run.repository.slug.trim();
  return run.repository.forge === "local" ? slug : slug.toLowerCase();
}

function canonicalRevision(run: RepositoryAssuranceRun): string {
  return JSON.stringify({
    forge: run.repository.forge,
    repository: run.repository.repositoryId?.trim() || normalizedRepositorySlug(run),
    program: run.program,
    headSha: run.revision.headSha,
    baseSha: run.revision.baseSha ?? "",
    mergeBaseSha: run.revision.mergeBaseSha ?? "",
    policyHash: run.policySnapshot.policyHash,
  });
}

/** Stable tenant-local identity for equivalent exact-revision work. */
export function repositoryAssuranceIdempotencyKey(run: RepositoryAssuranceRun): string {
  return createHash("sha256").update(canonicalRevision(run)).digest("hex");
}

export function isAssuranceRunTransitionAllowed(
  from: AssuranceRunStatus,
  to: AssuranceRunStatus,
): boolean {
  return from === to || RUN_TRANSITIONS[from].has(to);
}

export function isAssuranceStageTransitionAllowed(
  from: AssuranceStageStatus,
  to: AssuranceStageStatus,
): boolean {
  return from === to || STAGE_TRANSITIONS[from].has(to);
}

export function isSourceSnapshotTransitionAllowed(
  from: SourceSnapshotStatus,
  to: SourceSnapshotStatus,
): boolean {
  return from === to || SOURCE_TRANSITIONS[from].has(to);
}
