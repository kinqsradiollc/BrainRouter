/**
 * Stable façade for durable repository-assurance SQL.
 *
 * Identity/state policy, row mapping, creation, receipt mutation, and lifecycle
 * transitions live in focused siblings. Importers keep this unchanged path.
 */

export type {
  AssuranceRunTransition,
  CreateRepositoryAssuranceRunInput,
  ReplaceableAssuranceRunsInput,
  SaveRepositoryAssuranceFindingInput,
} from "./assuranceQueries/contracts.js";
export {
  isAssuranceRunTransitionAllowed,
  isAssuranceStageTransitionAllowed,
  isSourceSnapshotTransitionAllowed,
  repositoryAssuranceIdempotencyKey,
} from "./assuranceQueries/policy.js";
export { createRepositoryAssuranceRun } from "./assuranceQueries/create.js";
export {
  getRepositoryAssuranceFinding,
  isAssuranceFindingTransitionAllowed,
  listRepositoryAssuranceFindings,
  saveRepositoryAssuranceFinding,
} from "./assuranceQueries/findings.js";
export {
  getRepositoryAssuranceRun,
  getRepositoryAssuranceRunForJob,
  listReplaceableRepositoryAssuranceRunIds,
} from "./assuranceQueries/records.js";
export { transitionRepositoryAssuranceRun } from "./assuranceQueries/lifecycle.js";
export {
  recordRepositoryAssuranceStage,
  updateRepositoryAssuranceCoverage,
  updateRepositorySourceSnapshot,
} from "./assuranceQueries/receipts.js";
