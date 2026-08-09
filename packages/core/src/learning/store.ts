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
import { redactText } from '../session/transcript/sessionStore.js';
import type {
  LearnedItem, LearnedTenant, LearningLogEntry, LearningReconciliationState,
  LearningSessionObservationState, LearningState,
} from './types.js';
import { learningSessionIdentity } from './sessionIdentity.js';

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

/** Filesystem-safe, human-readable prefix. Identity comes from the hash below. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 28) || 'local';
}

function legacySafeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'local';
}

function legacyLearningDir(tenant: LearnedTenant): string {
  const normalized = normalizedTenant(tenant);
  return path.join(
    getBrainrouterHome(),
    'learning',
    `${legacySafeSegment(normalized.orgId ?? 'personal')}__${legacySafeSegment(normalized.userId)}`,
  );
}

function normalizedTenant(tenant: LearnedTenant): Required<LearnedTenant> {
  const orgId = typeof tenant?.orgId === 'string' ? tenant.orgId.trim() : '';
  const userId = typeof tenant?.userId === 'string' ? tenant.userId.trim() : '';
  return {
    orgId: orgId || null,
    userId: userId || 'local',
  };
}

function sameTenant(left: LearnedTenant, right: LearnedTenant): boolean {
  const a = normalizedTenant(left);
  const b = normalizedTenant(right);
  return a.orgId === b.orgId && a.userId === b.userId;
}

/**
 * The directory for one tenant. Both halves of the key are in the PATH rather
 * than filtered out of a shared file: a partition you cannot accidentally read
 * across beats a partition you remembered to filter.
 */
export function learningDir(tenant: LearnedTenant): string {
  const normalized = normalizedTenant(tenant);
  const org = safeSegment(normalized.orgId ?? 'personal');
  const user = safeSegment(normalized.userId);
  // The prefix is only for inspection. Hash the typed, untruncated identity so
  // punctuation replacement, 64-char truncation, and literal "personal"
  // values can never collapse two tenants into one directory.
  const identity = JSON.stringify([normalized.orgId, normalized.userId]);
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return path.join(getBrainrouterHome(), 'learning', `${org}__${user}__${hash}`);
}

export function learningStateFile(tenant: LearnedTenant): string {
  return path.join(learningDir(tenant), 'state.json');
}

/** Safe one-time move from the pre-hash directory. A lossy legacy collision is
 * never guessed through: only the tenant written inside the state file may
 * claim that directory. */
function migrateLegacyLearningState(tenant: LearnedTenant): void {
  const target = learningDir(tenant);
  const targetState = path.join(target, 'state.json');
  if (fs.existsSync(targetState)) return;
  const legacy = legacyLearningDir(tenant);
  if (legacy === target || !fs.existsSync(path.join(legacy, 'state.json'))) return;
  try {
    const stored = readJsonFile<Partial<LearningState>>(path.join(legacy, 'state.json'), {});
    if (!stored.tenant || !sameTenant(stored.tenant, tenant)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.renameSync(legacy, target);
    else {
      fs.cpSync(legacy, target, { recursive: true, errorOnExist: false, force: false });
      fs.rmSync(legacy, { recursive: true, force: true });
    }
  } catch {
    // A concurrent process may have completed the move. Either the hashed
    // state now exists or the next access retries; never fall back to reading
    // the collision-prone path directly.
  }
}

export function readLearningState(tenant: LearnedTenant): LearningState {
  migrateLegacyLearningState(tenant);
  const stored = readJsonFile<Partial<LearningState>>(learningStateFile(tenant), {});
  if (stored.tenant && !sameTenant(stored.tenant, tenant)) {
    // A partition mismatch is never repaired by relabelling. Fail closed.
    return {
      schemaVersion: 1,
      tenant: normalizedTenant(tenant),
      items: {},
      log: [],
      sessions: {},
      reconciliation: emptyReconciliationState(),
    };
  }
  const rawItems = stored.items && typeof stored.items === 'object' ? stored.items : {};
  const items = Object.fromEntries(Object.entries(rawItems).filter(([, item]) => (
    !!item && sameTenant((item as LearnedItem).tenant, tenant)
  )));
  const sessions = normalizeLearningSessions(stored.sessions, items);
  const reconciliation = normalizeReconciliationState(stored.reconciliation, items, sessions);
  return {
    schemaVersion: 1,
    tenant: normalizedTenant(tenant),
    // A stored file from an older schema may be missing whole sections. A
    // learning store that throws on read would take the agent down with it;
    // starting empty is recoverable and visible.
    items: { ...items },
    log: Array.isArray(stored.log) ? stored.log.slice(-MAX_LOG_ENTRIES) : [],
    sessions,
    reconciliation,
  };
}

function normalizeLearningSessions(
  raw: LearningState['sessions'],
  items: Record<string, LearnedItem>,
): Record<string, LearningSessionObservationState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const normalized: Record<string, LearningSessionObservationState> = {};
  for (const [identity, candidate] of Object.entries(raw)) {
    if (!/^[a-f0-9]{64}$/.test(identity) || !candidate || typeof candidate !== 'object') continue;
    const deliveredItemIds = [...new Set(
      (Array.isArray(candidate.deliveredItemIds) ? candidate.deliveredItemIds : [])
        .filter((id): id is string => typeof id === 'string' && !!items[id]),
    )];
    const delivered = new Set(deliveredItemIds);
    const outcomes: LearningSessionObservationState['outcomes'] = {};
    const rawOutcomes = candidate.outcomes && typeof candidate.outcomes === 'object'
      && !Array.isArray(candidate.outcomes)
      ? candidate.outcomes
      : {};
    for (const [itemId, observation] of Object.entries(rawOutcomes)) {
      if (!delivered.has(itemId) || !observation || typeof observation !== 'object') continue;
      if (observation.outcome !== 'confirmed' && observation.outcome !== 'contradicted') continue;
      if (typeof observation.observedAt !== 'string' || !Number.isFinite(Date.parse(observation.observedAt))) continue;
      outcomes[itemId] = {
        outcome: observation.outcome,
        observedAt: observation.observedAt,
        centralSync: observation.centralSync
          && (observation.centralSync.status === 'pending' || observation.centralSync.status === 'synced')
          && observation.centralSync.outcome === observation.outcome
          && typeof observation.centralSync.updatedAt === 'string'
          && Number.isFinite(Date.parse(observation.centralSync.updatedAt))
          ? {
            status: observation.centralSync.status,
            outcome: observation.centralSync.outcome,
            detail: typeof observation.centralSync.detail === 'string'
              ? observation.centralSync.detail.slice(0, 240)
              : '',
            updatedAt: observation.centralSync.updatedAt,
          }
          : {
            // Pre-event ledgers may already have projected this aggregate.
            // Treat it as synced rather than replaying and double-counting it;
            // a later contradiction becomes a new pending semantic event.
            status: 'synced',
            outcome: observation.outcome,
            detail: '',
            updatedAt: observation.observedAt,
          },
      };
    }
    if (deliveredItemIds.length > 0 || Object.keys(outcomes).length > 0) {
      normalized[identity] = { deliveredItemIds, outcomes };
    }
  }
  return normalized;
}

function sessionObservationState(
  state: LearningState,
  sessionIdentity: string,
): LearningSessionObservationState {
  state.sessions ??= {};
  return state.sessions[sessionIdentity] ??= { deliveredItemIds: [], outcomes: {} };
}

const OUTCOME_SYNC_SEPARATOR = ':';

function outcomeSyncKey(sessionIdentity: string, itemId: string): string {
  return `${sessionIdentity}${OUTCOME_SYNC_SEPARATOR}${itemId}`;
}

function pendingOutcomeSyncKeys(
  sessions: Record<string, LearningSessionObservationState>,
): Set<string> {
  const pending = new Set<string>();
  for (const [sessionIdentity, session] of Object.entries(sessions)) {
    for (const [itemId, observation] of Object.entries(session.outcomes)) {
      if (observation.centralSync?.status === 'pending'
        && observation.centralSync.outcome === observation.outcome) {
        pending.add(outcomeSyncKey(sessionIdentity, itemId));
      }
    }
  }
  return pending;
}

function emptyReconciliationState(): LearningReconciliationState {
  return { dirtyQueue: [], dirtyRevisions: {}, nextRevision: 0, outcomeQueue: [] };
}

function normalizeReconciliationState(
  raw: LearningState['reconciliation'],
  items: Record<string, LearnedItem>,
  sessions: Record<string, LearningSessionObservationState>,
): LearningReconciliationState {
  const source = raw && typeof raw === 'object' ? raw : emptyReconciliationState();
  const dirtyRevisions: Record<string, number> = {};
  for (const [id, revision] of Object.entries(source.dirtyRevisions ?? {})) {
    if (items[id] && Number.isSafeInteger(revision) && revision > 0) dirtyRevisions[id] = revision;
  }
  const dirtyQueue: string[] = [];
  for (const id of Array.isArray(source.dirtyQueue) ? source.dirtyQueue : []) {
    if (dirtyRevisions[id] && !dirtyQueue.includes(id)) dirtyQueue.push(id);
  }
  for (const id of Object.keys(dirtyRevisions).sort()) {
    if (!dirtyQueue.includes(id)) dirtyQueue.push(id);
  }
  const pendingOutcomes = pendingOutcomeSyncKeys(sessions);
  const outcomeQueue: string[] = [];
  for (const key of Array.isArray(source.outcomeQueue) ? source.outcomeQueue : []) {
    if (pendingOutcomes.has(key) && !outcomeQueue.includes(key)) outcomeQueue.push(key);
  }
  for (const key of [...pendingOutcomes].sort()) {
    if (!outcomeQueue.includes(key)) outcomeQueue.push(key);
  }
  let nextRevision = Math.max(
    0,
    ...Object.values(dirtyRevisions),
    Number.isSafeInteger(source.nextRevision) ? Math.max(0, source.nextRevision) : 0,
  );
  // Older state files predate the durable queue. Recover visibly pending or
  // lifecycle-inconsistent rows on first read so an upgrade does not strand
  // the exact failures this queue was added to heal.
  for (const item of Object.values(items)) {
    const desired = item.status === 'active' ? 'active' : 'archived';
    const needsReconciliation = item.memoryLifecycle?.status === 'record-pending'
      || (!!item.memoryRecordId && item.memoryLifecycle?.status !== desired);
    if (!needsReconciliation || dirtyRevisions[item.id]) continue;
    nextRevision += 1;
    dirtyRevisions[item.id] = nextRevision;
    dirtyQueue.push(item.id);
  }
  return {
    ...(typeof source.lifecycleCursor === 'string' && source.lifecycleCursor
      ? { lifecycleCursor: source.lifecycleCursor }
      : {}),
    dirtyQueue,
    dirtyRevisions,
    nextRevision,
    outcomeQueue,
  };
}

function reconciliationState(state: LearningState): LearningReconciliationState {
  const normalized = normalizeReconciliationState(state.reconciliation, state.items, state.sessions ?? {});
  state.reconciliation = normalized;
  return normalized;
}

function markLearningOutcomePending(
  state: LearningState,
  sessionIdentity: string,
  itemId: string,
): void {
  const reconciliation = reconciliationState(state);
  const key = outcomeSyncKey(sessionIdentity, itemId);
  reconciliation.outcomeQueue ??= [];
  if (!reconciliation.outcomeQueue.includes(key)) reconciliation.outcomeQueue.push(key);
}

function markLearningItemDirty(state: LearningState, itemId: string): number {
  if (!state.items[itemId]) return 0;
  const reconciliation = reconciliationState(state);
  reconciliation.nextRevision += 1;
  reconciliation.dirtyRevisions[itemId] = reconciliation.nextRevision;
  if (!reconciliation.dirtyQueue.includes(itemId)) reconciliation.dirtyQueue.push(itemId);
  return reconciliation.nextRevision;
}

const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Cross-process serialization for every read-modify-write lifecycle mutation. */
function withLearningLock<T>(tenant: LearnedTenant, operation: () => T): T {
  migrateLegacyLearningState(tenant);
  const dir = learningDir(tenant);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.state.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(
        lock,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
          | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      fs.writeFileSync(descriptor, `${process.pid} ${Date.now()}\n`, 'utf8');
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(lock);
      } catch { /* another writer released it */ }
      if (Date.now() >= deadline) throw new Error('timed out waiting for learning state lock');
      Atomics.wait(sleepCell, 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
    try { fs.unlinkSync(lock); } catch { /* best effort */ }
  }
}

function mutateLearningState<T>(tenant: LearnedTenant, mutation: (state: LearningState) => T): T {
  return withLearningLock(tenant, () => {
    const state = readLearningState(tenant);
    const result = mutation(state);
    writeLearningState(state);
    return result;
  });
}

export interface LearningReconciliationEntry {
  readonly item: LearnedItem;
  /** Absent for a cursor-only lifecycle poll. Present entries may be removed
   * from the dirty queue only if this exact revision still owns the row. */
  readonly dirtyRevision?: number;
}

/**
 * Claim one fair, crash-safe reconciliation pass.
 *
 * Half the budget rotates through locally dirty rows (active and inactive),
 * while the other half advances a durable cursor across every linked row so a
 * hosted revert cannot sit forever behind four failing records. Claiming never
 * removes work: dirty ids rotate to the tail and are cleared only after a
 * successful compare-by-revision completion.
 */
export function claimLearningReconciliationBatch(
  tenant: LearnedTenant,
  limit = 4,
): LearningReconciliationEntry[] {
  const boundedLimit = Math.max(1, Math.min(16, Math.floor(limit)));
  return mutateLearningState(tenant, (state) => {
    const reconciliation = reconciliationState(state);
    const selected = new Map<string, LearningReconciliationEntry>();
    const dirtyQuota = Math.max(1, Math.ceil(boundedLimit / 2));
    const dirtyCount = Math.min(dirtyQuota, reconciliation.dirtyQueue.length);
    for (let index = 0; index < dirtyCount; index += 1) {
      const id = reconciliation.dirtyQueue.shift();
      if (!id) break;
      reconciliation.dirtyQueue.push(id);
      const item = state.items[id];
      const revision = reconciliation.dirtyRevisions[id];
      if (item && revision) selected.set(id, { item, dirtyRevision: revision });
    }

    const linkedIds = Object.values(state.items)
      .filter((item) => !!item.memoryRecordId && item.status !== 'reverted')
      .map((item) => item.id)
      .sort();
    if (linkedIds.length > 0 && selected.size < boundedLimit) {
      const cursorIndex = reconciliation.lifecycleCursor
        ? linkedIds.indexOf(reconciliation.lifecycleCursor)
        : -1;
      let lastPolled: string | undefined;
      for (let offset = 1; offset <= linkedIds.length && selected.size < boundedLimit; offset += 1) {
        const id = linkedIds[(cursorIndex + offset) % linkedIds.length]!;
        lastPolled = id;
        if (!selected.has(id)) selected.set(id, { item: state.items[id]! });
      }
      if (lastPolled) reconciliation.lifecycleCursor = lastPolled;
    }

    // If the linked partition is small, spend the remaining budget rotating
    // dirty work rather than leaving capacity idle.
    const remainingDirty = reconciliation.dirtyQueue.length;
    for (let index = dirtyCount; index < remainingDirty && selected.size < boundedLimit; index += 1) {
      const id = reconciliation.dirtyQueue.shift();
      if (!id) break;
      reconciliation.dirtyQueue.push(id);
      const item = state.items[id];
      const revision = reconciliation.dirtyRevisions[id];
      if (item && revision && !selected.has(id)) selected.set(id, { item, dirtyRevision: revision });
    }
    return [...selected.values()];
  });
}

/** Snapshot the current row and dirty revision immediately before a remote
 * projection write. A later local mutation increments the revision, preventing
 * the in-flight write from clearing newer work. */
export function learningReconciliationSnapshot(
  tenant: LearnedTenant,
  itemId: string,
): LearningReconciliationEntry | undefined {
  const state = readLearningState(tenant);
  const item = state.items[itemId];
  if (!item) return undefined;
  const revision = state.reconciliation?.dirtyRevisions[itemId];
  return { item, ...(revision ? { dirtyRevision: revision } : {}) };
}

export function completeLearningReconciliation(
  tenant: LearnedTenant,
  itemId: string,
  dirtyRevision: number | undefined,
): boolean {
  if (!dirtyRevision) return true;
  return mutateLearningState(tenant, (state) => {
    const reconciliation = reconciliationState(state);
    if (reconciliation.dirtyRevisions[itemId] !== dirtyRevision) return false;
    delete reconciliation.dirtyRevisions[itemId];
    reconciliation.dirtyQueue = reconciliation.dirtyQueue.filter((id) => id !== itemId);
    return true;
  });
}

/** One bounded semantic outcome delivery to the normalized central ledger. */
export interface LearningOutcomeSyncEvent {
  readonly sessionIdentity: string;
  readonly itemId: string;
  readonly recordId: string;
  readonly outcome: 'confirmed' | 'contradicted';
  readonly detail: string;
  readonly observedAt: string;
}

function outcomeSyncEventFromState(
  state: LearningState,
  key: string,
): LearningOutcomeSyncEvent | undefined {
  const separator = key.indexOf(OUTCOME_SYNC_SEPARATOR);
  if (separator !== 64) return undefined;
  const sessionIdentity = key.slice(0, separator);
  const itemId = key.slice(separator + 1);
  const item = state.items[itemId];
  const observation = state.sessions?.[sessionIdentity]?.outcomes[itemId];
  const delivery = observation?.centralSync;
  if (!item?.memoryRecordId || !observation || !delivery
    || delivery.status !== 'pending' || delivery.outcome !== observation.outcome) return undefined;
  return {
    sessionIdentity,
    itemId,
    recordId: item.memoryRecordId,
    outcome: observation.outcome,
    detail: delivery.detail.slice(0, 240),
    observedAt: observation.observedAt,
  };
}

/** Exact current-session event, used to deliver an outcome before projecting
 * its aggregate/lifecycle change. */
export function pendingLearningOutcomeSyncForSession(
  tenant: LearnedTenant,
  sessionKey: string,
  itemId: string,
): LearningOutcomeSyncEvent | undefined {
  const state = readLearningState(tenant);
  const identity = learningSessionIdentity(tenant, sessionKey);
  return outcomeSyncEventFromState(state, outcomeSyncKey(identity, itemId));
}

/** Rotate through a bounded number of pending session/item events. Claiming is
 * non-destructive: a crash or failed request leaves the event queued. */
export function claimLearningOutcomeSyncBatch(
  tenant: LearnedTenant,
  limit = 4,
): LearningOutcomeSyncEvent[] {
  const boundedLimit = Math.max(1, Math.min(16, Math.floor(limit)));
  return mutateLearningState(tenant, (state) => {
    const reconciliation = reconciliationState(state);
    const queue = reconciliation.outcomeQueue ??= [];
    const inspected = Math.min(queue.length, boundedLimit);
    const events: LearningOutcomeSyncEvent[] = [];
    for (let index = 0; index < inspected; index += 1) {
      const key = queue.shift();
      if (!key) break;
      queue.push(key);
      const event = outcomeSyncEventFromState(state, key);
      if (event) events.push(event);
    }
    return events;
  });
}

export function hasPendingLearningOutcomeSync(
  tenant: LearnedTenant,
  itemId: string,
): boolean {
  const state = readLearningState(tenant);
  return Object.values(state.sessions ?? {}).some((session) => (
    session.outcomes[itemId]?.centralSync?.status === 'pending'
  ));
}

/** Mark only the exact event that was acknowledged. A same-session
 * confirmation upgraded while this request was in flight remains pending. */
export function completeLearningOutcomeSync(
  tenant: LearnedTenant,
  event: LearningOutcomeSyncEvent,
  now = new Date(),
): boolean {
  return mutateLearningState(tenant, (state) => {
    const item = state.items[event.itemId];
    const observation = state.sessions?.[event.sessionIdentity]?.outcomes[event.itemId];
    const delivery = observation?.centralSync;
    if (!item || item.memoryRecordId !== event.recordId || !observation || !delivery
      || observation.outcome !== event.outcome || delivery.outcome !== event.outcome) return false;
    delivery.status = 'synced';
    delivery.updatedAt = now.toISOString();
    const reconciliation = reconciliationState(state);
    const key = outcomeSyncKey(event.sessionIdentity, event.itemId);
    reconciliation.outcomeQueue = (reconciliation.outcomeQueue ?? []).filter((entry) => entry !== key);
    return true;
  });
}

export function writeLearningState(state: LearningState): void {
  fs.mkdirSync(learningDir(state.tenant), { recursive: true });
  writeJsonFile(learningStateFile(state.tenant), {
    ...state,
    log: state.log.slice(-MAX_LOG_ENTRIES),
  });
}

export function appendLearningLog(state: LearningState, entry: LearningLogEntry): void {
  state.log.push({ ...entry, detail: redactText(entry.detail.slice(0, 400)) });
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
  /** Items retired by the capacity bound during this write. Callers with a
   * central port must reconcile these just like policy-driven retirement. */
  readonly capacityRetired: LearnedItem[];
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
  return mutateLearningState(tenant, (state) => {
    const existing = findByStatement(state, item.statement);
    const at = now.toISOString();

    if (existing && existing.status === 'reverted') {
      appendLearningLog(state, {
        at,
        op: 'rejected',
        itemId: existing.id,
        detail: 'a person reverted this statement — re-learning it needs an explicit correction',
      });
      return { item: existing, reinforced: false, capacityRetired: [] };
    }

    if (existing) {
      // Re-derivation is useful audit evidence, but it is NOT an observed
      // outcome. Counting it as confirmation made a model able to validate its
      // own belief and immediately restore a demoted item.
      if (item.tier === 'instruction') existing.tier = 'instruction';
      existing.updatedAt = at;
      appendLearningLog(state, {
        at,
        op: 'reinforced',
        itemId: existing.id,
        detail: `re-derived in ${item.provenance.sessionKey}; awaiting observed outcome`,
      });
      markLearningItemDirty(state, existing.id);
      return { item: existing, reinforced: true, capacityRetired: [] };
    }

    item.statusChangedAt ??= at;
    state.items[item.id] = item;
    appendLearningLog(state, {
      at,
      op: 'admitted',
      itemId: item.id,
      detail: `${item.tier}/${item.form} from ${item.provenance.sessionKey} (${item.provenance.checkpoint}): ${item.provenance.gateReasoning}`,
    });
    markLearningItemDirty(state, item.id);
    const capacityRetired = enforceCapacity(state, at);
    return { item, reinforced: false, capacityRetired };
  });
}

/**
 * Keep the live set bounded by retiring the weakest, never by refusing the new.
 * Weakest = fewest confirmations, then least recently useful.
 */
function enforceCapacity(state: LearningState, at: string): LearnedItem[] {
  const live = Object.values(state.items).filter(
    (item) => item.status === 'active' || item.status === 'demoted',
  );
  if (live.length <= MAX_ACTIVE_ITEMS) return [];
  const ranked = live.sort((a, b) => (
    a.outcome.confirmations - b.outcome.confirmations
    || a.outcome.retrievals - b.outcome.retrievals
    || a.updatedAt.localeCompare(b.updatedAt)
  ));
  const retired = ranked.slice(0, live.length - MAX_ACTIVE_ITEMS);
  for (const item of retired) {
    item.status = 'retired';
    item.statusChangedAt = at;
    item.statusReason = 'retired to keep the live set bounded — it had paid off least';
    item.updatedAt = at;
    if (item.memoryRecordId) {
      item.memoryLifecycle = {
        status: 'archive-pending', updatedAt: at, attempts: item.memoryLifecycle?.attempts ?? 0,
      };
    }
    markLearningItemDirty(state, item.id);
    appendLearningLog(state, {
      at, op: 'retired', itemId: item.id, detail: 'capacity: least corroborated item in the partition',
    });
  }
  return retired;
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

/** Exact learned items that reached this logical session.  Lifetime retrieval
 * totals are deliberately insufficient: an item shown yesterday cannot gain an
 * outcome from today's unrelated trajectory. */
export function listLearnedItemsDeliveredInSession(
  tenant: LearnedTenant,
  sessionKey: string,
): LearnedItem[] {
  const state = readLearningState(tenant);
  const session = state.sessions?.[learningSessionIdentity(tenant, sessionKey)];
  if (!session) return [];
  return session.deliveredItemIds
    .map((id) => state.items[id])
    .filter((item): item is LearnedItem => (
      !!item && item.status !== 'retired' && item.status !== 'reverted'
    ));
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
  return mutateLearningState(tenant, (state) => {
    const item = state.items[id];
    if (!item) return undefined;
    const at = now.toISOString();
    item.status = 'reverted';
    item.statusChangedAt = at;
    item.statusReason = redactText(reason.trim().slice(0, 400)) || 'reverted by a person';
    item.updatedAt = at;
    if (item.memoryRecordId) {
      item.memoryLifecycle = {
        status: 'archive-pending',
        updatedAt: at,
        attempts: item.memoryLifecycle?.attempts ?? 0,
      };
      appendLearningLog(state, {
        at,
        op: 'memory-archive-pending',
        itemId: id,
        detail: item.memoryRecordId,
      });
    }
    appendLearningLog(state, { at, op: 'reverted', itemId: id, detail: item.statusReason });
    markLearningItemDirty(state, item.id);
    return item;
  });
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
  sessionKey: string,
  ids: readonly string[],
  now = new Date(),
): void {
  if (ids.length === 0) return;
  const sessionIdentity = learningSessionIdentity(tenant, sessionKey);
  mutateLearningState(tenant, (state) => {
    const at = now.toISOString();
    const session = sessionObservationState(state, sessionIdentity);
    const delivered = new Set(session.deliveredItemIds);
    let touched = 0;
    for (const id of new Set(ids)) {
      const item = state.items[id];
      if (!item || item.status !== 'active') continue;
      item.outcome = {
        ...item.outcome,
        retrievals: item.outcome.retrievals + 1,
        lastRetrievedAt: at,
      };
      item.updatedAt = at;
      markLearningItemDirty(state, item.id);
      delivered.add(item.id);
      touched += 1;
    }
    session.deliveredItemIds = [...delivered];
    if (touched > 0) appendLearningLog(state, {
      at, op: 'retrieved', detail: `${touched} item(s) placed in context for one logical session`,
    });
  });
}

/**
 * D6's real signal — did the thing it predicted actually happen?
 *
 * `contradicted` means the falsifier was OBSERVED, which is the strongest
 * evidence this store can get and the reason D2 insists every item name one.
 */
export function noteLearnedOutcome(
  tenant: LearnedTenant,
  sessionKey: string,
  outcomes: ReadonlyArray<{ id: string; outcome: 'confirmed' | 'contradicted'; detail?: string }>,
  now = new Date(),
): LearnedItem[] {
  if (outcomes.length === 0) return [];
  const sessionIdentity = learningSessionIdentity(tenant, sessionKey);
  const unique = new Map<string, typeof outcomes[number]>();
  for (const entry of outcomes.slice(0, 32)) {
    const previous = unique.get(entry.id);
    if (!previous || entry.outcome === 'contradicted') unique.set(entry.id, entry);
  }
  return mutateLearningState(tenant, (state) => {
    const at = now.toISOString();
    const changed: LearnedItem[] = [];
    const session = sessionObservationState(state, sessionIdentity);
    const delivered = new Set(session.deliveredItemIds);
    for (const entry of unique.values()) {
      const item = state.items[entry.id];
      if (!delivered.has(entry.id)) continue;
      if (!item || item.status === 'reverted' || item.status === 'retired') continue;
      const previous = session.outcomes[entry.id];
      // One logical session contributes to at most one counter.  A falsifier
      // is authoritative if the same session first appeared successful and
      // later exposed the contradiction; the inverse may never erase it.
      if (previous?.outcome === 'contradicted') continue;
      let appliedOutcome: 'confirmed' | 'contradicted';
      if (entry.outcome === 'confirmed') {
        if (previous?.outcome === 'confirmed') continue;
        appliedOutcome = 'confirmed';
        item.outcome = {
          ...item.outcome,
          confirmations: item.outcome.confirmations + 1,
          lastConfirmedAt: at,
        };
      } else {
        appliedOutcome = 'contradicted';
        item.outcome = {
          ...item.outcome,
          confirmations: previous?.outcome === 'confirmed'
            ? Math.max(0, item.outcome.confirmations - 1)
            : item.outcome.confirmations,
          contradictions: item.outcome.contradictions + 1,
          lastContradictedAt: at,
        };
        if (item.outcome.confirmations === 0) delete item.outcome.lastConfirmedAt;
      }
      const detail = redactText((entry.detail ?? '').slice(0, 240))
        || `${entry.outcome} by session observation`;
      session.outcomes[entry.id] = {
        outcome: appliedOutcome,
        observedAt: at,
        centralSync: {
          status: 'pending',
          outcome: appliedOutcome,
          detail,
          updatedAt: at,
        },
      };
      markLearningOutcomePending(state, sessionIdentity, entry.id);
      item.updatedAt = at;
      markLearningItemDirty(state, item.id);
      appendLearningLog(state, {
        at,
        op: appliedOutcome,
        itemId: item.id,
        detail,
      });
      changed.push(item);
    }
    return changed;
  });
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
  return mutateLearningState(tenant, (state) => {
    const at = now.toISOString();
    const changed: LearnedItem[] = [];
    for (const transition of transitions) {
      const item = state.items[transition.id];
      if (!item || item.status === 'reverted') continue;
      if (transition.tier) item.tier = transition.tier;
      item.status = transition.status;
      item.statusChangedAt = at;
      item.statusReason = redactText(transition.reason.slice(0, 400));
      item.updatedAt = at;
      if ((transition.status === 'retired' || transition.status === 'demoted') && item.memoryRecordId) {
        item.memoryLifecycle = {
          status: 'archive-pending', updatedAt: at, attempts: item.memoryLifecycle?.attempts ?? 0,
        };
      }
      appendLearningLog(state, {
        at,
        op: transition.status === 'retired' ? 'retired' : 'demoted',
        itemId: item.id,
        detail: item.statusReason,
      });
      markLearningItemDirty(state, item.id);
      changed.push(item);
    }
    return changed;
  });
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
  return mutateLearningState(tenant, (state) => {
    const item = state.items[itemId];
    if (!item || item.status !== 'active') return undefined;
    if (item.skillId && item.skillId !== skillId) return undefined;
    const otherOwner = Object.values(state.items).some(
      (candidate) => candidate.id !== itemId && candidate.skillId === skillId,
    );
    if (otherOwner) return undefined;
    const at = now.toISOString();
    item.skillId = skillId;
    item.updatedAt = at;
    appendLearningLog(state, { at, op: 'skill-written', itemId, detail: skillId });
    markLearningItemDirty(state, item.id);
    return item;
  });
}

/** Persist the central-memory pointer; mutating the object returned by
 * `storeLearnedItem` is not durable and previously orphaned every record. */
export function attachLearnedMemoryRecord(
  tenant: LearnedTenant,
  itemId: string,
  recordId: string,
  now = new Date(),
): LearnedItem | undefined {
  const normalizedId = recordId.trim().slice(0, 200);
  if (!normalizedId) return undefined;
  return mutateLearningState(tenant, (state) => {
    const item = state.items[itemId];
    if (!item) return undefined;
    const at = now.toISOString();
    item.memoryRecordId = normalizedId;
    item.memoryLifecycle = { status: 'active', updatedAt: at, attempts: 1 };
    item.updatedAt = at;
    appendLearningLog(state, { at, op: 'memory-linked', itemId, detail: normalizedId });
    markLearningItemDirty(state, item.id);
    return item;
  });
}

export function updateLearnedMemoryLifecycle(
  tenant: LearnedTenant,
  itemId: string,
  update: {
    status: NonNullable<LearnedItem['memoryLifecycle']>['status'];
    error?: string;
    incrementAttempts?: boolean;
  },
  now = new Date(),
): LearnedItem | undefined {
  return mutateLearningState(tenant, (state) => {
    const item = state.items[itemId];
    if (!item) return undefined;
    const at = now.toISOString();
    const attempts = (item.memoryLifecycle?.attempts ?? 0) + (update.incrementAttempts ? 1 : 0);
    item.memoryLifecycle = {
      status: update.status,
      updatedAt: at,
      attempts,
      ...(update.error ? { lastError: redactText(update.error.slice(0, 240)) } : {}),
    };
    item.updatedAt = at;
    const op = update.status === 'active'
      ? 'memory-restored'
      : update.status === 'archived'
      ? 'memory-archived'
      : update.status === 'archive-pending'
        ? (update.error ? 'memory-archive-failed' : 'memory-archive-pending')
        : 'memory-record-failed';
    appendLearningLog(state, {
      at,
      op,
      itemId,
      detail: update.error ? redactText(update.error.slice(0, 240)) : update.status,
    });
    markLearningItemDirty(state, item.id);
    return item;
  });
}

/** Record a rejection. A gate nobody can audit is a gate nobody trusts (D2). */
export function logLearningRejection(
  tenant: LearnedTenant,
  detail: string,
  now = new Date(),
): void {
  mutateLearningState(tenant, (state) => {
    appendLearningLog(state, { at: now.toISOString(), op: 'rejected', detail: detail.slice(0, 400) });
  });
}

export function readLearningLog(tenant: LearnedTenant): LearningLogEntry[] {
  return [...readLearningState(tenant).log].reverse();
}
