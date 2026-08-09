/**
 * ADR-032 D4/D8 — where learned state lives, and how it is taken back.
 *
 * **The partition is `(org_id, user_id)`** — the same one memory, notes and the
 * planner use. There is no cross-tenant read anywhere in this file: every entry
 * point takes ONE tenant and resolves ONE path from it. D8 is blunt about why —
 * a lesson learned in one customer's workspace reaching another is a data leak
 * with a pleasant name, and it is the kind of feature that is easy to add later
 * and impossible to take back.
 *
 * **Undo is an operation, not a database edit (D4).** `revertLearnedItem` is
 * the only supported way back, it records who asked and why, and it never
 * deletes the row — a reverted item stays visible with its provenance so
 * "why did it do that, and why did it stop" are both answerable. That is not
 * politeness: D6 retires things automatically, and a system that can delete
 * what it learned needs an audit trail MORE than one that only appends.
 *
 * Local-first, like notes and the planner: the file under the brainrouter home
 * is authoritative with no server configured, because solo is the normal mode
 * rather than a degraded one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getBrainrouterHome, readJsonFile, writeJsonFile } from '../storage/store.js';
import type {
  LearnedItem, LearnedTenant, LearningLogEntry, LearningState,
} from './types.js';

/**
 * The audit log is bounded. An unbounded log on a store that writes on every
 * turn end is a file that grows until somebody notices — ADR-027's bounded
 * queues made the same call for the same reason.
 */
export const MAX_LOG_ENTRIES = 500;

/**
 * A partition holds at most this many live items. Past it the weakest are
 * retired rather than the newest refused: D6's whole argument is that a store
 * which only grows becomes noise, and refusing new learning to preserve stale
 * learning gets that exactly backwards.
 */
export const MAX_ACTIVE_ITEMS = 200;

/** Filesystem-safe partition segment. Identical rule to `notesFile`'s. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'local';
}

/**
 * The directory for one tenant. Both halves of the key are in the PATH rather
 * than filtered out of a shared file: a partition you cannot accidentally read
 * across beats a partition you remembered to filter.
 */
export function learningDir(tenant: LearnedTenant): string {
  const org = safeSegment(tenant.orgId?.trim() || 'personal');
  const user = safeSegment(tenant.userId?.trim() || 'local');
  return path.join(getBrainrouterHome(), 'learning', `${org}__${user}`);
}

export function learningStateFile(tenant: LearnedTenant): string {
  return path.join(learningDir(tenant), 'state.json');
}

export function readLearningState(tenant: LearnedTenant): LearningState {
  const stored = readJsonFile<Partial<LearningState>>(learningStateFile(tenant), {});
  const items = stored.items && typeof stored.items === 'object' ? stored.items : {};
  return {
    schemaVersion: 1,
    tenant,
    // A stored file from an older schema may be missing whole sections. A
    // learning store that throws on read would take the agent down with it;
    // starting empty is recoverable and visible.
    items: { ...items },
    log: Array.isArray(stored.log) ? stored.log.slice(-MAX_LOG_ENTRIES) : [],
  };
}

export function writeLearningState(state: LearningState): void {
  fs.mkdirSync(learningDir(state.tenant), { recursive: true });
  writeJsonFile(learningStateFile(state.tenant), {
    ...state,
    log: state.log.slice(-MAX_LOG_ENTRIES),
  });
}

export function appendLearningLog(state: LearningState, entry: LearningLogEntry): void {
  state.log.push(entry);
  if (state.log.length > MAX_LOG_ENTRIES) state.log = state.log.slice(-MAX_LOG_ENTRIES);
}

/** Stable, collision-free id. The audit trail is keyed by it, so it is minted once. */
export function newLearnedItemId(): string {
  return `lrn_${crypto.randomBytes(9).toString('hex')}`;
}

/**
 * Two items are the same lesson when they say the same thing, regardless of
 * which session noticed. Fingerprinting on the statement rather than the id is
 * what stops the same correction being stored on every turn of a session that
 * keeps making the same mistake — which is precisely the session that triggers
 * the most checkpoints.
 */
export function learnedFingerprint(statement: string): string {
  const normalized = statement.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function findByStatement(state: LearningState, statement: string): LearnedItem | undefined {
  const fingerprint = learnedFingerprint(statement);
  return Object.values(state.items).find(
    (item) => learnedFingerprint(item.statement) === fingerprint,
  );
}

export interface StoreLearnedItemResult {
  readonly item: LearnedItem;
  /** True when an existing item was reinforced rather than a new one created. */
  readonly reinforced: boolean;
}

/**
 * Write an admitted item, or reinforce the one already saying it.
 *
 * Reinforcement RESTORES a demoted item rather than leaving it demoted: the
 * ladder in D6 goes both ways, and an item the agent just re-derived from a
 * fresh trajectory has paid for its slot again. A `reverted` item is the
 * exception — a person took that one back, and re-learning it silently would
 * make undo a suggestion.
 */
export function storeLearnedItem(
  tenant: LearnedTenant,
  item: LearnedItem,
  now = new Date(),
): StoreLearnedItemResult {
  const state = readLearningState(tenant);
  const existing = findByStatement(state, item.statement);
  const at = now.toISOString();

  if (existing && existing.status === 'reverted') {
    appendLearningLog(state, {
      at,
      op: 'rejected',
      itemId: existing.id,
      detail: 'a person reverted this statement — re-learning it needs an explicit correction',
    });
    writeLearningState(state);
    return { item: existing, reinforced: false };
  }

  if (existing) {
    existing.outcome = {
      ...existing.outcome,
      confirmations: existing.outcome.confirmations + 1,
      lastConfirmedAt: at,
    };
    // The tier only ever climbs on reinforcement when the NEW sighting earned
    // it — a human correction of something previously inferred is a promotion;
    // a second inference of something a person said is not a demotion.
    if (item.tier === 'instruction') existing.tier = 'instruction';
    existing.status = 'active';
    existing.statusReason = 'reinforced by a later session';
    existing.updatedAt = at;
    appendLearningLog(state, {
      at,
      op: 'confirmed',
      itemId: existing.id,
      detail: `re-derived in ${item.provenance.sessionKey}`,
    });
    writeLearningState(state);
    return { item: existing, reinforced: true };
  }

  state.items[item.id] = item;
  appendLearningLog(state, {
    at,
    op: 'admitted',
    itemId: item.id,
    detail: `${item.tier}/${item.form} from ${item.provenance.sessionKey} (${item.provenance.checkpoint}): ${item.provenance.gateReasoning}`,
  });
  enforceCapacity(state, at);
  writeLearningState(state);
  return { item, reinforced: false };
}

/**
 * Keep the live set bounded by retiring the weakest, never by refusing the new.
 * Weakest = fewest confirmations, then least recently useful.
 */
function enforceCapacity(state: LearningState, at: string): void {
  const live = Object.values(state.items).filter(
    (item) => item.status === 'active' || item.status === 'demoted',
  );
  if (live.length <= MAX_ACTIVE_ITEMS) return;
  const ranked = live.sort((a, b) => (
    a.outcome.confirmations - b.outcome.confirmations
    || a.outcome.retrievals - b.outcome.retrievals
    || a.updatedAt.localeCompare(b.updatedAt)
  ));
  for (const item of ranked.slice(0, live.length - MAX_ACTIVE_ITEMS)) {
    item.status = 'retired';
    item.statusReason = 'retired to keep the live set bounded — it had paid off least';
    item.updatedAt = at;
    appendLearningLog(state, {
      at, op: 'retired', itemId: item.id, detail: 'capacity: least corroborated item in the partition',
    });
  }
}

/** Everything in the partition, newest first. The inspection surface (§5 Q4). */
export function listLearnedItems(
  tenant: LearnedTenant,
  opts?: { includeInactive?: boolean },
): LearnedItem[] {
  const state = readLearningState(tenant);
  return Object.values(state.items)
    .filter((item) => opts?.includeInactive || item.status === 'active' || item.status === 'demoted')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getLearnedItem(tenant: LearnedTenant, id: string): LearnedItem | undefined {
  return readLearningState(tenant).items[id];
}

/**
 * D4 — the way back, and the reason the rest of this file records so much.
 *
 * Reverting keeps the row. A learned item that vanishes takes its provenance
 * with it, and then "the agent used to do this and stopped" has no answer.
 */
export function revertLearnedItem(
  tenant: LearnedTenant,
  id: string,
  reason: string,
  now = new Date(),
): LearnedItem | undefined {
  const state = readLearningState(tenant);
  const item = state.items[id];
  if (!item) return undefined;
  const at = now.toISOString();
  item.status = 'reverted';
  item.statusReason = reason.trim().slice(0, 400) || 'reverted by a person';
  item.updatedAt = at;
  appendLearningLog(state, { at, op: 'reverted', itemId: id, detail: item.statusReason });
  writeLearningState(state);
  return item;
}

/**
 * D6's first signal — the item was actually placed in front of the model.
 *
 * Weak on its own, which is why `noteLearnedOutcome` exists; but "never
 * retrieved" is a fact worth having, because an item nothing ever selects is
 * costing a slot and paying nothing.
 */
export function noteLearnedRetrieval(
  tenant: LearnedTenant,
  ids: readonly string[],
  now = new Date(),
): void {
  if (ids.length === 0) return;
  const state = readLearningState(tenant);
  const at = now.toISOString();
  let touched = false;
  for (const id of ids) {
    const item = state.items[id];
    if (!item) continue;
    item.outcome = {
      ...item.outcome,
      retrievals: item.outcome.retrievals + 1,
      lastRetrievedAt: at,
    };
    item.updatedAt = at;
    touched = true;
  }
  if (!touched) return;
  appendLearningLog(state, {
    at, op: 'retrieved', detail: `${ids.length} item(s) placed in context`,
  });
  writeLearningState(state);
}

/**
 * D6's real signal — did the thing it predicted actually happen?
 *
 * `contradicted` means the falsifier was OBSERVED, which is the strongest
 * evidence this store can get and the reason D2 insists every item name one.
 */
export function noteLearnedOutcome(
  tenant: LearnedTenant,
  outcomes: ReadonlyArray<{ id: string; outcome: 'confirmed' | 'contradicted'; detail?: string }>,
  now = new Date(),
): LearnedItem[] {
  if (outcomes.length === 0) return [];
  const state = readLearningState(tenant);
  const at = now.toISOString();
  const changed: LearnedItem[] = [];
  for (const entry of outcomes) {
    const item = state.items[entry.id];
    if (!item) continue;
    if (entry.outcome === 'confirmed') {
      item.outcome = {
        ...item.outcome,
        confirmations: item.outcome.confirmations + 1,
        lastConfirmedAt: at,
      };
    } else {
      item.outcome = {
        ...item.outcome,
        contradictions: item.outcome.contradictions + 1,
        lastContradictedAt: at,
      };
    }
    item.updatedAt = at;
    appendLearningLog(state, {
      at,
      op: entry.outcome === 'confirmed' ? 'confirmed' : 'contradicted',
      itemId: item.id,
      detail: (entry.detail ?? '').slice(0, 240) || `${entry.outcome} by session observation`,
    });
    changed.push(item);
  }
  writeLearningState(state);
  return changed;
}

/**
 * Apply a status/tier transition decided by `retirement.ts`.
 *
 * Kept here rather than there so every write to the store goes through one
 * file, and the audit trail cannot be bypassed by a caller that decided to be
 * helpful.
 */
export function applyLearnedTransition(
  tenant: LearnedTenant,
  transitions: ReadonlyArray<{
    id: string;
    tier?: LearnedItem['tier'];
    status: LearnedItem['status'];
    reason: string;
  }>,
  now = new Date(),
): LearnedItem[] {
  if (transitions.length === 0) return [];
  const state = readLearningState(tenant);
  const at = now.toISOString();
  const changed: LearnedItem[] = [];
  for (const transition of transitions) {
    const item = state.items[transition.id];
    if (!item) continue;
    if (transition.tier) item.tier = transition.tier;
    item.status = transition.status;
    item.statusReason = transition.reason;
    item.updatedAt = at;
    appendLearningLog(state, {
      at,
      op: transition.status === 'retired' ? 'retired' : 'demoted',
      itemId: item.id,
      detail: transition.reason,
    });
    changed.push(item);
  }
  writeLearningState(state);
  return changed;
}

/**
 * D3 — link an item to the learned skill its procedure was promoted to.
 *
 * A dedicated write rather than a second `storeLearnedItem` call: that path
 * fingerprints on the statement, so re-storing the same item would find the row
 * it just created, treat it as a re-derivation, and inflate the confirmation
 * count with a confirmation that never happened — a measurement corrupting the
 * signal D6 retires on.
 */
export function attachLearnedSkill(
  tenant: LearnedTenant,
  itemId: string,
  skillId: string,
  now = new Date(),
): LearnedItem | undefined {
  const state = readLearningState(tenant);
  const item = state.items[itemId];
  if (!item) return undefined;
  const at = now.toISOString();
  item.skillId = skillId;
  item.updatedAt = at;
  appendLearningLog(state, { at, op: 'skill-written', itemId, detail: skillId });
  writeLearningState(state);
  return item;
}

/** Record a rejection. A gate nobody can audit is a gate nobody trusts (D2). */
export function logLearningRejection(
  tenant: LearnedTenant,
  detail: string,
  now = new Date(),
): void {
  const state = readLearningState(tenant);
  appendLearningLog(state, { at: now.toISOString(), op: 'rejected', detail: detail.slice(0, 400) });
  writeLearningState(state);
}

export function readLearningLog(tenant: LearnedTenant): LearningLogEntry[] {
  return [...readLearningState(tenant).log].reverse();
}
