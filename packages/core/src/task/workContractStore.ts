/**
 * Durable Work Contract v1 storage and legacy plan migration.
 *
 * The store is session-scoped beside `tasks.json`. It persists only references
 * and hashes, uses optimistic revisions to prevent lost steer updates, and
 * derives a conservative first contract from an existing authoritative plan.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { getSessionStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';
import { loadWorkspaceManifest } from '../workspace/manifest.js';
import { readPlan } from './taskStore.js';
import {
  projectContractStatus,
  projectPlanReference,
  projectPlanTasks,
} from './workContractProjection.js';
import {
  WORK_CONTRACT_SCHEMA_VERSION,
  assertWorkContract,
  type WorkContract,
  type WorkRecordRef,
  type WorkTaskRef,
} from './workContract.js';

export interface CreateWorkContractInput {
  workspaceId?: string;
  sessionKey: string;
  profileId: string;
  goal?: WorkRecordRef;
  requirements?: WorkRecordRef[];
  decisions?: WorkRecordRef[];
  plan: WorkContract['plan'];
  tasks?: WorkTaskRef[];
  evidence?: WorkRecordRef[];
  artifacts?: WorkRecordRef[];
  reviews?: WorkRecordRef[];
  status?: WorkContract['status'];
}

export interface MigrateWorkContractOptions {
  workspaceId?: string;
  profileId?: string;
}

export function workContractPath(workspaceRoot: string, sessionKey: string): string {
  return getSessionStateFile(workspaceRoot, sessionKey, 'work-contract.json');
}

export function readWorkContract(
  workspaceRoot: string,
  sessionKey: string,
): WorkContract | null {
  const filePath = workContractPath(workspaceRoot, sessionKey);
  if (!fs.existsSync(filePath)) return null;
  const raw = readJsonFile<unknown>(filePath, null);
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Number((raw as { schemaVersion?: unknown }).schemaVersion) > WORK_CONTRACT_SCHEMA_VERSION
  ) {
    return null;
  }
  try {
    assertWorkContract(raw);
    return raw;
  } catch {
    quarantineInvalidContract(filePath);
    return null;
  }
}

export function createWorkContract(
  workspaceRoot: string,
  input: CreateWorkContractInput,
): WorkContract {
  const filePath = workContractPath(workspaceRoot, input.sessionKey);
  if (readWorkContract(workspaceRoot, input.sessionKey)) {
    throw new Error('A Work Contract already exists for this session.');
  }
  if (fs.existsSync(filePath)) {
    throw new Error('A newer Work Contract exists for this session and cannot be overwritten.');
  }
  const now = new Date().toISOString();
  const contract: WorkContract = {
    schemaVersion: WORK_CONTRACT_SCHEMA_VERSION,
    id: createOpaqueId('work'),
    workspaceId: input.workspaceId ?? deriveWorkspaceId(workspaceRoot),
    sessionKey: input.sessionKey,
    profileId: input.profileId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...(input.goal ? { goal: input.goal } : {}),
    requirements: input.requirements ?? [],
    decisions: input.decisions ?? [],
    plan: input.plan,
    tasks: input.tasks ?? [],
    evidence: input.evidence ?? [],
    artifacts: input.artifacts ?? [],
    reviews: input.reviews ?? [],
    steering: [],
    status: input.status ?? 'draft',
  };
  assertWorkContract(contract);
  writeJsonFile(filePath, contract);
  return contract;
}

export function reviseWorkContract(
  workspaceRoot: string,
  sessionKey: string,
  expectedRevision: number,
  revise: (current: WorkContract) => WorkContract,
): WorkContract {
  const current = readWorkContract(workspaceRoot, sessionKey);
  if (!current) throw new Error('No Work Contract exists for this session.');
  if (current.revision !== expectedRevision) {
    throw new Error(
      `Work Contract revision conflict: expected ${expectedRevision}, current ${current.revision}.`,
    );
  }
  const candidate = revise(structuredClone(current));
  const next: WorkContract = {
    ...candidate,
    schemaVersion: WORK_CONTRACT_SCHEMA_VERSION,
    id: current.id,
    workspaceId: current.workspaceId,
    sessionKey: current.sessionKey,
    revision: current.revision + 1,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  assertWorkContract(next);
  writeJsonFile(workContractPath(workspaceRoot, sessionKey), next);
  return next;
}

/**
 * Create a conservative Work Contract for a legacy plan. Empty sessions remain
 * untouched; migration never invents requirements, approval, or completion.
 */
export function readOrMigrateWorkContract(
  workspaceRoot: string,
  sessionKey: string,
  options: MigrateWorkContractOptions = {},
): WorkContract | null {
  const existing = readWorkContract(workspaceRoot, sessionKey);
  if (existing) return existing;
  if (fs.existsSync(workContractPath(workspaceRoot, sessionKey))) return null;
  const plan = readPlan(workspaceRoot, sessionKey);
  if (plan.items.length === 0) return null;
  const requirementRefs = plan.requirementId ? [{ id: plan.requirementId }] : [];
  return createWorkContract(workspaceRoot, {
    workspaceId: options.workspaceId,
    sessionKey,
    profileId: options.profileId ?? loadWorkspaceManifest(workspaceRoot)?.profile ?? 'custom',
    requirements: requirementRefs,
    plan: projectPlanReference(sessionKey, plan),
    tasks: projectPlanTasks(plan),
    status: projectContractStatus(plan),
  });
}

function deriveWorkspaceId(workspaceRoot: string): string {
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  return opaqueHashId('workspace', canonical);
}

function createOpaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function opaqueHashId(prefix: string, value: string): string {
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function quarantineInvalidContract(filePath: string): void {
  try {
    fs.renameSync(filePath, `${filePath}.invalid-${Date.now()}`);
  } catch {
    // Best effort: an invalid contract must not brick the session.
  }
}
