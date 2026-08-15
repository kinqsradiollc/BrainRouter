import type {
  ExecutionIntentHandle,
  ExecutionIntentRecord,
  ExecutionIntentSource,
} from '@kinqs/brainrouter-types/agent';
import {
  normalizedExecutionTargetSnapshot,
  type NormalizedExecutionIntentTarget,
} from './normalization.js';

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 15 * 60_000;

export type ExecutionIntentFailureReason =
  | 'unknown-handle'
  | 'owner-mismatch'
  | 'binding-mismatch'
  | 'turn-mismatch'
  | 'source-mismatch'
  | 'request-mismatch'
  | 'target-mismatch'
  | 'expired'
  | 'not-issued'
  | 'not-active';

export interface ExecutionIntentOwnerToken {
  readonly __executionIntentOwner?: never;
}

interface Binding {
  workspaceRoot: string;
  sessionKey: string;
  userId: string;
}

interface IntentState {
  owner: ExecutionIntentOwnerToken;
  record: ExecutionIntentRecord;
  targetKey: string;
  dispatchArgs: Readonly<Record<string, unknown>>;
  status: 'issued' | 'active' | 'consumed' | 'expired';
  dispatchReceiptIssued: boolean;
}

export interface ExecutionDispatchReceipt {
  readonly __executionDispatchReceipt?: never;
}

interface DispatchReceiptState {
  record: ExecutionIntentRecord;
  targetKey: string;
  runId: string;
  parentExecutionId: string;
  assertAuthorityCurrent: () => void;
  used: boolean;
}

const owners = new WeakMap<object, Readonly<Binding>>();
const handles = new WeakMap<object, IntentState>();
const dispatchReceipts = new WeakMap<object, DispatchReceiptState>();

function normalizeBinding(input: Binding): Binding {
  const workspaceRoot = input.workspaceRoot?.trim();
  const sessionKey = input.sessionKey?.trim();
  const userId = input.userId?.trim();
  if (!workspaceRoot || !sessionKey || !userId) {
    throw new Error('execution intent owner requires workspaceRoot, sessionKey, and userId');
  }
  return { workspaceRoot, sessionKey, userId };
}

function sameBinding(left: Binding, right: Binding): boolean {
  return left.workspaceRoot === right.workspaceRoot
    && left.sessionKey === right.sessionKey
    && left.userId === right.userId;
}

function failure(reason: ExecutionIntentFailureReason) {
  return { ok: false as const, reason };
}

function freezeRecord(record: ExecutionIntentRecord): ExecutionIntentRecord {
  Object.freeze(record.target);
  return Object.freeze(record);
}

export function createExecutionIntentOwnerToken(
  input: Binding,
): ExecutionIntentOwnerToken {
  const token = Object.freeze({}) as ExecutionIntentOwnerToken;
  owners.set(token, Object.freeze(normalizeBinding(input)));
  return token;
}

export function issueExecutionIntent(
  owner: ExecutionIntentOwnerToken,
  input: {
    source: ExecutionIntentSource;
    requestId: string;
    turnId: string;
    target: NormalizedExecutionIntentTarget;
    now?: number;
    ttlMs?: number;
  },
): ExecutionIntentHandle {
  const binding = owners.get(owner as object);
  if (!binding) throw new Error('execution intent owner is not recognized');
  if (input.source === 'authorized-workflow') {
    throw new Error('authorized-workflow intent can only be derived by the owning runtime');
  }
  if (input.source !== 'user-command' && input.source !== 'reviewed-ui') {
    throw new Error('execution intent source is not recognized');
  }
  const snapshot = normalizedExecutionTargetSnapshot(input.target);
  if (!snapshot) throw new Error('execution intent target is not a Core-normalized target');
  const requestId = input.requestId?.trim();
  const turnId = input.turnId?.trim();
  if (!requestId || !turnId) throw new Error('execution intent requires requestId and turnId');
  const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (!opaqueIdPattern.test(requestId) || !opaqueIdPattern.test(turnId)) {
    throw new Error(
      'execution intent requestId and turnId must be opaque IDs of at most 128 safe characters',
    );
  }
  const now = input.now ?? Date.now();
  const requestedTtl = input.ttlMs ?? DEFAULT_TTL_MS;
  const ttlMs = Math.max(1, Math.min(MAX_TTL_MS, Math.trunc(requestedTtl)));
  const record = freezeRecord({
    version: 1,
    ...binding,
    source: input.source,
    requestId,
    turnId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    target: snapshot.record,
  });
  const handle = Object.freeze({}) as ExecutionIntentHandle;
  handles.set(handle, {
    owner,
    record,
    targetKey: snapshot.comparisonKey,
    dispatchArgs: snapshot.dispatchArgs,
    status: 'issued',
    dispatchReceiptIssued: false,
  });
  return handle;
}

export function readExecutionIntentRecord(
  handle: unknown,
): ExecutionIntentRecord | null {
  if (!handle || typeof handle !== 'object') return null;
  return handles.get(handle)?.record ?? null;
}

export function activateExecutionIntent(
  owner: ExecutionIntentOwnerToken,
  handle: ExecutionIntentHandle,
  input: Binding & { turnId: string; now?: number },
): { ok: true; record: ExecutionIntentRecord } | { ok: false; reason: ExecutionIntentFailureReason } {
  const state = handles.get(handle as object);
  if (!state) return failure('unknown-handle');
  if (state.owner !== owner) return failure('owner-mismatch');
  if (state.status !== 'issued') return failure('not-issued');
  const ownerBinding = owners.get(owner as object);
  let binding: Binding;
  try {
    binding = normalizeBinding(input);
  } catch {
    state.status = 'expired';
    return failure('binding-mismatch');
  }
  if (!ownerBinding || !sameBinding(ownerBinding, binding) || !sameBinding(state.record, binding)) {
    state.status = 'expired';
    return failure('binding-mismatch');
  }
  if (input.turnId !== state.record.turnId) {
    state.status = 'expired';
    return failure('turn-mismatch');
  }
  if ((input.now ?? Date.now()) >= Date.parse(state.record.expiresAt)) {
    state.status = 'expired';
    return failure('expired');
  }
  state.status = 'active';
  return { ok: true, record: state.record };
}

export function consumeExecutionIntent(
  owner: ExecutionIntentOwnerToken,
  handle: ExecutionIntentHandle,
  input: Binding & {
    source: ExecutionIntentSource;
    requestId: string;
    turnId: string;
    target: NormalizedExecutionIntentTarget;
    now?: number;
  },
):
  | {
    ok: true;
    record: ExecutionIntentRecord;
    dispatchArgs: Readonly<Record<string, unknown>>;
  }
  | { ok: false; reason: ExecutionIntentFailureReason } {
  const state = handles.get(handle as object);
  if (!state) return failure('unknown-handle');
  if (state.owner !== owner) return failure('owner-mismatch');
  if (state.status !== 'active') return failure('not-active');

  const burn = (reason: ExecutionIntentFailureReason) => {
    state.status = 'expired';
    return failure(reason);
  };
  const ownerBinding = owners.get(owner as object);
  let binding: Binding;
  try {
    binding = normalizeBinding(input);
  } catch {
    return burn('binding-mismatch');
  }
  if (!ownerBinding || !sameBinding(ownerBinding, binding) || !sameBinding(state.record, binding)) {
    return burn('binding-mismatch');
  }
  if (input.turnId !== state.record.turnId) return burn('turn-mismatch');
  if ((input.now ?? Date.now()) >= Date.parse(state.record.expiresAt)) return burn('expired');
  if (input.source !== state.record.source) return burn('source-mismatch');
  if (input.requestId !== state.record.requestId) return burn('request-mismatch');
  const target = normalizedExecutionTargetSnapshot(input.target);
  if (!target || target.comparisonKey !== state.targetKey) return burn('target-mismatch');
  state.status = 'consumed';
  return {
    ok: true,
    record: state.record,
    dispatchArgs: state.dispatchArgs,
  };
}

/**
 * Side-effect-free success path used before extension/shell hooks. A mismatch
 * still burns the active bearer, so hooks never observe an unauthorized or
 * variant durable-launch request that could later be retried.
 */
export function validateExecutionIntent(
  owner: ExecutionIntentOwnerToken,
  handle: ExecutionIntentHandle,
  input: Binding & {
    source: ExecutionIntentSource;
    requestId: string;
    turnId: string;
    target: NormalizedExecutionIntentTarget;
    now?: number;
  },
):
  | { ok: true; record: ExecutionIntentRecord }
  | { ok: false; reason: ExecutionIntentFailureReason } {
  const state = handles.get(handle as object);
  if (!state) return failure('unknown-handle');
  if (state.owner !== owner) return failure('owner-mismatch');
  if (state.status !== 'active') return failure('not-active');

  const burn = (reason: ExecutionIntentFailureReason) => {
    state.status = 'expired';
    return failure(reason);
  };
  const ownerBinding = owners.get(owner as object);
  let binding: Binding;
  try {
    binding = normalizeBinding(input);
  } catch {
    return burn('binding-mismatch');
  }
  if (!ownerBinding || !sameBinding(ownerBinding, binding) || !sameBinding(state.record, binding)) {
    return burn('binding-mismatch');
  }
  if (input.turnId !== state.record.turnId) return burn('turn-mismatch');
  if ((input.now ?? Date.now()) >= Date.parse(state.record.expiresAt)) return burn('expired');
  if (input.source !== state.record.source) return burn('source-mismatch');
  if (input.requestId !== state.record.requestId) return burn('request-mismatch');
  const target = normalizedExecutionTargetSnapshot(input.target);
  if (!target || target.comparisonKey !== state.targetKey) return burn('target-mismatch');
  return { ok: true, record: state.record };
}

export function expireExecutionIntent(
  owner: ExecutionIntentOwnerToken,
  handle: ExecutionIntentHandle,
  turnId: string,
): void {
  const state = handles.get(handle as object);
  if (!state || state.owner !== owner || state.record.turnId !== turnId) return;
  if (state.status !== 'consumed') state.status = 'expired';
}

/** Minted only for the exact owner/handle after its one-shot consume. */
export function createExecutionDispatchReceipt(
  owner: ExecutionIntentOwnerToken,
  handle: ExecutionIntentHandle,
  input: {
    runId: string;
    parentExecutionId: string;
    assertAuthorityCurrent: () => void;
  },
): ExecutionDispatchReceipt {
  const state = handles.get(handle as object);
  if (
    !state
    || state.owner !== owner
    || state.status !== 'consumed'
    || state.dispatchReceiptIssued
  ) {
    throw new Error(
      'Execution dispatch receipt requires the exact freshly consumed intent.',
    );
  }
  const runId = input.runId?.trim();
  const parentExecutionId = input.parentExecutionId?.trim();
  if (!runId || !parentExecutionId) {
    throw new Error('Execution dispatch receipt requires run and parent execution IDs.');
  }
  if (typeof input.assertAuthorityCurrent !== 'function') {
    throw new Error('Execution dispatch receipt requires a live authority guard.');
  }
  state.dispatchReceiptIssued = true;
  const receipt = Object.freeze({}) as ExecutionDispatchReceipt;
  dispatchReceipts.set(receipt, {
    record: state.record,
    targetKey: state.targetKey,
    runId,
    parentExecutionId,
    assertAuthorityCurrent: input.assertAuthorityCurrent,
    used: false,
  });
  return receipt;
}

/** Durable-executor chokepoint. Structural/serialized lookalikes fail closed. */
export function consumeExecutionDispatchReceipt(
  receipt: unknown,
  input: {
    record: ExecutionIntentRecord;
    runId: string;
    parentExecutionId: string;
    target: NormalizedExecutionIntentTarget;
  },
): () => void {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('Durable execution requires an unforgeable Core dispatch receipt.');
  }
  const state = dispatchReceipts.get(receipt);
  const target = normalizedExecutionTargetSnapshot(input.target);
  if (
    !state
    || state.used
  ) {
    throw new Error('Durable execution dispatch receipt is unknown or already consumed.');
  }
  // The first attempt made with a real receipt is terminal, including a target
  // mismatch. This prevents a caller from probing variants before replaying the
  // reviewed target.
  state.used = true;
  if (
    state.record !== input.record
    || state.runId !== input.runId
    || state.parentExecutionId !== input.parentExecutionId
    || !target
    || state.targetKey !== target.comparisonKey
  ) {
    throw new Error('Durable execution dispatch receipt is unknown, mismatched, or already consumed.');
  }
  state.assertAuthorityCurrent();
  return state.assertAuthorityCurrent;
}

/** Burn a genuine receipt when dispatch fails before a canonical target exists. */
export function rejectExecutionDispatchReceipt(receipt: unknown): void {
  if (!receipt || typeof receipt !== 'object') return;
  const state = dispatchReceipts.get(receipt);
  if (state) state.used = true;
}
