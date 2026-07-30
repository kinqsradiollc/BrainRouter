/**
 * Compatibility entrypoint for the Work Contract domain.
 *
 * Shared data contracts live in the leaf types package while core retains the
 * persistence validator. Existing core callers keep one stable import path.
 */
export {
  WORK_CONTRACT_SCHEMA_VERSION,
} from '@kinqs/brainrouter-types/work-contract';
export type {
  SteeringReceipt,
  WorkContract,
  WorkContractStatus,
  WorkPlanRef,
  WorkRecordRef,
  WorkReviewDisposition,
  WorkTaskReadiness,
  WorkTaskRef,
  WorkTaskStatus,
} from '@kinqs/brainrouter-types/work-contract';
export {
  assertWorkContract,
  validateWorkContract,
} from './workContractValidation.js';
