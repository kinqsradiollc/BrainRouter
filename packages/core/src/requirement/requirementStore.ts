/**
 * REQUIREMENT-RECORDS (0.4.15) — durable per-workspace store for Requirement
 * Records: a structured unit of intent a chat can be anchored to (title,
 * status, priority, acceptance criteria, clarifying Q&A, and links back to the
 * session / tasks / artifacts / memory it produced).
 *
 * Persisted at `<workspace cli state>/requirements.json`, keyed by requirement
 * id, exactly like sessionMetaStore / sessionRuntimeStore. The shared record
 * shape lives in `@kinqs/brainrouter-types` (RequirementRecord) — this module
 * never redefines it, it only reads/writes/merges. All helpers are pure
 * functions of (workspaceRoot, …) so they are trivially testable without a REPL.
 */
import { randomUUID } from 'node:crypto';
import {
  type RequirementRecord,
  type RequirementStatus,
  type RequirementPriority,
  type ClarifyingQA,
} from '@kinqs/brainrouter-types';
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';

type RequirementStore = Record<string, RequirementRecord>;

function requirementsFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'requirements.json');
}

/** Every requirement persisted for a workspace, keyed by id. */
export function readRequirementsAll(workspaceRoot: string): RequirementStore {
  return readJsonFile<RequirementStore>(requirementsFile(workspaceRoot), {});
}

/** One requirement by id, or `undefined` when it doesn't exist. */
export function getRequirement(workspaceRoot: string, id: string): RequirementRecord | undefined {
  return readRequirementsAll(workspaceRoot)[id];
}

/** Fields a caller may supply at creation time. The store stamps id/timestamps
 *  and defaults everything else so a `{ title }` call is enough. */
export interface CreateRequirementInput {
  title: string;
  description?: string;
  status?: RequirementStatus;
  priority?: RequirementPriority;
  acceptanceCriteria?: string[];
  clarifyingQuestions?: ClarifyingQA[];
  sessionKey?: string;
  taskIds?: string[];
  artifactIds?: string[];
  linkedMemoryIds?: string[];
  sourceEventId?: string;
  origin?: 'manual' | 'auto';
}

/**
 * Create a draft requirement. Generates a `req_<8hex>` id (matching the
 * `wkr_`/`hook_` short-id convention used by the other CLI stores), stamps
 * createdAt/updatedAt, and persists it. Returns the stored record.
 */
export function createRequirement(
  workspaceRoot: string,
  input: CreateRequirementInput,
): RequirementRecord {
  const title = input.title?.trim();
  if (!title) {
    throw new Error('Requirement title must be a non-empty string.');
  }
  const all = readRequirementsAll(workspaceRoot);
  const now = new Date().toISOString();
  const id = `req_${randomUUID().slice(0, 8)}`;
  const record: RequirementRecord = {
    id,
    title,
    status: input.status ?? 'draft',
    priority: input.priority ?? 'medium',
    acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
    clarifyingQuestions: [...(input.clarifyingQuestions ?? [])],
    workspaceRoot,
    taskIds: [...(input.taskIds ?? [])],
    artifactIds: [...(input.artifactIds ?? [])],
    linkedMemoryIds: [...(input.linkedMemoryIds ?? [])],
    createdAt: now,
    updatedAt: now,
  };
  // Optional fields are only set when present, so an in-memory record matches
  // its JSON round-trip exactly (no `key: undefined` that disappears on read).
  const description = input.description?.trim();
  if (description) record.description = description;
  if (input.sessionKey) record.sessionKey = input.sessionKey;
  if (input.sourceEventId) record.sourceEventId = input.sourceEventId;
  if (input.origin) record.origin = input.origin;
  all[id] = record;
  writeJsonFile(requirementsFile(workspaceRoot), all);
  return record;
}

/** A merge-able patch for an existing requirement. `id`, `workspaceRoot`,
 *  `createdAt`, and `updatedAt` are owned by the store and cannot be patched. */
export type RequirementPatch = Partial<
  Omit<RequirementRecord, 'id' | 'workspaceRoot' | 'createdAt' | 'updatedAt'>
>;

/**
 * Merge a patch into an existing requirement and bump `updatedAt`. Returns the
 * updated record, or `undefined` when no requirement has that id. The store
 * keeps ownership of id/workspaceRoot/createdAt — those are never overwritten.
 */
export function updateRequirement(
  workspaceRoot: string,
  id: string,
  patch: RequirementPatch,
): RequirementRecord | undefined {
  const all = readRequirementsAll(workspaceRoot);
  const existing = all[id];
  if (!existing) return undefined;
  const next: RequirementRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    workspaceRoot: existing.workspaceRoot,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  all[id] = next;
  writeJsonFile(requirementsFile(workspaceRoot), all);
  return next;
}

export interface RequirementFilter {
  status?: RequirementStatus;
  sessionKey?: string;
}

/**
 * List a workspace's requirements newest-first, optionally narrowed by status
 * and/or sessionKey. Both filters are ANDed when supplied.
 */
export function listRequirements(
  workspaceRoot: string,
  filter?: RequirementFilter,
): RequirementRecord[] {
  const all = Object.values(readRequirementsAll(workspaceRoot));
  const filtered = all.filter((r) => {
    if (filter?.status && r.status !== filter.status) return false;
    if (filter?.sessionKey && r.sessionKey !== filter.sessionKey) return false;
    return true;
  });
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Link targets for {@link linkRequirement}. Any subset may be supplied. */
export interface RequirementLink {
  taskId?: string;
  artifactId?: string;
  memoryId?: string;
}

/**
 * Push a task / artifact / memory id into the requirement's link arrays,
 * de-duplicating so the same id is never stored twice. No-op (but still bumps
 * updatedAt) when every supplied id is already present. Returns the updated
 * record, or `undefined` when the id doesn't exist.
 */
export function linkRequirement(
  workspaceRoot: string,
  id: string,
  link: RequirementLink,
): RequirementRecord | undefined {
  const existing = getRequirement(workspaceRoot, id);
  if (!existing) return undefined;
  const taskIds = pushUnique(existing.taskIds, link.taskId);
  const artifactIds = pushUnique(existing.artifactIds, link.artifactId);
  const linkedMemoryIds = pushUnique(existing.linkedMemoryIds, link.memoryId);
  return updateRequirement(workspaceRoot, id, { taskIds, artifactIds, linkedMemoryIds });
}

/**
 * The clarifying questions still awaiting an answer — pure, fs-free, so it can
 * be unit-tested against a plain record. A question is "open" when its answer
 * is missing or only whitespace.
 */
export function openClarifyingQuestions(rec: RequirementRecord): ClarifyingQA[] {
  return rec.clarifyingQuestions.filter((qa) => !qa.answer || qa.answer.trim() === '');
}

/**
 * Append a clarifying question (no answer yet) to a requirement, bumping
 * `updatedAt`. A `draft` requirement transitions to `clarifying` the moment it
 * gains an open question. Returns the updated record, or `null` when the id
 * doesn't exist or `question` is empty after trimming.
 */
export function addClarifyingQuestion(
  workspaceRoot: string,
  id: string,
  question: string,
): RequirementRecord | null {
  const text = question?.trim();
  if (!text) return null;
  const existing = getRequirement(workspaceRoot, id);
  if (!existing) return null;
  const clarifyingQuestions: ClarifyingQA[] = [...existing.clarifyingQuestions, { question: text }];
  const patch: RequirementPatch = { clarifyingQuestions };
  // Asking the first question of a still-draft requirement opens clarification.
  if (existing.status === 'draft') patch.status = 'clarifying';
  return updateRequirement(workspaceRoot, id, patch) ?? null;
}

/**
 * Record the answer to the clarifying question at `index` (0-based), bumping
 * `updatedAt`. Returns the updated record, `null` when the id doesn't exist,
 * the index is out of range, or `answer` is empty after trimming. Other
 * questions are left untouched.
 */
export function answerClarifyingQuestion(
  workspaceRoot: string,
  id: string,
  index: number,
  answer: string,
): RequirementRecord | null {
  const text = answer?.trim();
  if (!text) return null;
  const existing = getRequirement(workspaceRoot, id);
  if (!existing) return null;
  if (!Number.isInteger(index) || index < 0 || index >= existing.clarifyingQuestions.length) {
    return null;
  }
  const clarifyingQuestions = existing.clarifyingQuestions.map((qa, i) =>
    i === index ? { ...qa, answer: text } : qa,
  );
  return updateRequirement(workspaceRoot, id, { clarifyingQuestions }) ?? null;
}

/**
 * Replace a requirement's clarifying Q&A wholesale, bumping `updatedAt`. Useful
 * for bulk edits where per-item helpers would be awkward. Returns the updated
 * record, or `null` when the id doesn't exist.
 */
export function setClarifyingQuestions(
  workspaceRoot: string,
  id: string,
  qa: ClarifyingQA[],
): RequirementRecord | null {
  if (!getRequirement(workspaceRoot, id)) return null;
  return updateRequirement(workspaceRoot, id, { clarifyingQuestions: [...qa] }) ?? null;
}

/** Delete a requirement. Returns `true` if one was removed, `false` otherwise. */
export function deleteRequirement(workspaceRoot: string, id: string): boolean {
  const all = readRequirementsAll(workspaceRoot);
  if (!all[id]) return false;
  delete all[id];
  writeJsonFile(requirementsFile(workspaceRoot), all);
  return true;
}

/** Return a copy of `list` with `value` appended iff it's a non-empty string
 *  not already present. Pure — never mutates the input array. */
function pushUnique(list: string[], value: string | undefined): string[] {
  if (!value) return list;
  if (list.includes(value)) return list;
  return [...list, value];
}
