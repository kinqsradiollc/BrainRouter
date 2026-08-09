import {
  getLearnedItem,
  revertLearnedItem,
  updateLearnedMemoryLifecycle,
} from './store.js';
import { removeLearnedSkill } from './learnedSkills.js';
import type { LearnedItem, LearnedTenant } from './types.js';
import type { HostLearnedProjection } from '../mcp/hostLearning.js';

/** Stable JSON shape shared by the memory record, hosted API and dashboard.
 * The local audit log remains authoritative; this bounded projection is safe
 * to mirror without exposing an unbounded trajectory. */
export function learnedItemMemoryMetadata(item: LearnedItem): HostLearnedProjection {
  return {
    schemaVersion: 1,
    itemId: item.id,
    tier: item.tier,
    origin: item.origin,
    form: item.form,
    status: item.status,
    statusReason: item.statusReason?.slice(0, 400),
    statusChangedAt: item.statusChangedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    falsifier: item.falsifier.slice(0, 400),
    expectation: item.outcome.expectation.slice(0, 400),
    provenance: {
      sessionKey: item.provenance.sessionKey.slice(0, 200),
      capturedAt: item.provenance.capturedAt,
      checkpoint: item.provenance.checkpoint,
      evidence: item.provenance.evidence.slice(0, 6).map((line) => line.slice(0, 240)),
      corroboratingActionIds: item.provenance.corroboratingActionIds?.slice(0, 8),
      sawUntrustedContent: item.provenance.sawUntrustedContent,
      gateReasoning: item.provenance.gateReasoning.slice(0, 400),
    },
    outcome: {
      retrievals: item.outcome.retrievals,
      confirmations: item.outcome.confirmations,
      contradictions: item.outcome.contradictions,
      lastRetrievedAt: item.outcome.lastRetrievedAt,
      lastConfirmedAt: item.outcome.lastConfirmedAt,
      lastContradictedAt: item.outcome.lastContradictedAt,
    },
    skillId: item.skillId,
    allowedTools: item.allowedTools?.slice(0, 32),
    memoryLifecycle: item.memoryLifecycle
      ? {
        status: item.memoryLifecycle.status,
        updatedAt: item.memoryLifecycle.updatedAt,
        attempts: item.memoryLifecycle.attempts,
        lastError: item.memoryLifecycle.lastError?.slice(0, 240),
      }
      : undefined,
  };
}

/** Host adapter for the central memory engine. Archiving is recoverable and
 * keeps the memory audit record, unlike deleting it. */
export interface LearnedMemoryLifecyclePort {
  archive(input: {
    recordId: string;
    itemId: string;
    tenant: LearnedTenant;
    reason: string;
  }): Promise<void>;
  restore?(input: {
    recordId: string;
    itemId: string;
    tenant: LearnedTenant;
    reason: string;
  }): Promise<void>;
}

export interface LearnedLifecycleResult {
  readonly item?: LearnedItem;
  readonly found: boolean;
  readonly localStatus?: LearnedItem['status'];
  readonly skill: { readonly id?: string; readonly removed: boolean };
  readonly memory: {
    readonly recordId?: string;
    readonly status: 'not-linked' | 'active' | 'archive-pending' | 'archived';
    readonly error?: string;
  };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

/**
 * One coordinated, Promise-returning undo operation for CLI, Desktop and API
 * callers. Local behaviour is disabled first (fail closed), then the learned
 * skill is removed and the linked central-memory fact is archived. A failed
 * remote archive remains explicit and retryable instead of pretending the undo
 * was complete.
 */
export async function revertLearnedItemLifecycle(input: {
  tenant: LearnedTenant;
  id: string;
  reason: string;
  memory?: LearnedMemoryLifecyclePort;
  now?: Date;
}): Promise<LearnedLifecycleResult> {
  if (input.reason.trim().length < 3) {
    throw new Error('A reason of at least 3 characters is required to revert learned behaviour.');
  }
  const now = input.now ?? new Date();
  const item = revertLearnedItem(input.tenant, input.id, input.reason, now);
  if (!item) {
    return {
      found: false,
      skill: { removed: false },
      memory: { status: 'not-linked' },
    };
  }

  const skillRemoved = item.skillId
    ? removeLearnedSkill(input.tenant, item.skillId, item.id)
    : false;
  if (!item.memoryRecordId) {
    return {
      found: true,
      item: getLearnedItem(input.tenant, item.id) ?? item,
      localStatus: 'reverted',
      skill: { id: item.skillId, removed: skillRemoved },
      memory: { status: 'not-linked' },
    };
  }

  if (!input.memory) {
    updateLearnedMemoryLifecycle(input.tenant, item.id, {
      status: 'archive-pending',
      error: 'central memory lifecycle port unavailable',
      incrementAttempts: true,
    }, now);
    return {
      found: true,
      item: getLearnedItem(input.tenant, item.id) ?? item,
      localStatus: 'reverted',
      skill: { id: item.skillId, removed: skillRemoved },
      memory: {
        recordId: item.memoryRecordId,
        status: 'archive-pending',
        error: 'central memory lifecycle port unavailable',
      },
    };
  }

  try {
    await input.memory.archive({
      recordId: item.memoryRecordId,
      itemId: item.id,
      tenant: input.tenant,
      reason: item.statusReason ?? input.reason,
    });
    const updated = updateLearnedMemoryLifecycle(input.tenant, item.id, {
      status: 'archived', incrementAttempts: true,
    }, now) ?? item;
    return {
      found: true,
      item: updated,
      localStatus: 'reverted',
      skill: { id: item.skillId, removed: skillRemoved },
      memory: { recordId: item.memoryRecordId, status: 'archived' },
    };
  } catch (error) {
    const message = errorText(error);
    const updated = updateLearnedMemoryLifecycle(input.tenant, item.id, {
      status: 'archive-pending', error: message, incrementAttempts: true,
    }, now) ?? item;
    return {
      found: true,
      item: updated,
      localStatus: 'reverted',
      skill: { id: item.skillId, removed: skillRemoved },
      memory: {
        recordId: item.memoryRecordId,
        status: 'archive-pending',
        error: message,
      },
    };
  }
}

/** Apply an explicit human revert observed in central memory to the local
 * ledger. Generic `archived` is intentionally insufficient: automatic
 * demotion also archives central recall, so only explicit learned status
 * `reverted` may take this path. */
export function applyCentralLearnedRevert(input: {
  tenant: LearnedTenant;
  id: string;
  reason: string;
  now?: Date;
}): LearnedLifecycleResult {
  const now = input.now ?? new Date();
  const reason = input.reason.trim().slice(0, 400);
  if (reason.length < 3) throw new Error('Central learned revert is missing its required reason.');
  const item = revertLearnedItem(input.tenant, input.id, reason, now);
  if (!item) {
    return { found: false, skill: { removed: false }, memory: { status: 'not-linked' } };
  }
  const removed = item.skillId
    ? removeLearnedSkill(input.tenant, item.skillId, item.id)
    : false;
  const updated = item.memoryRecordId
    ? updateLearnedMemoryLifecycle(input.tenant, item.id, {
      status: 'archived', incrementAttempts: false,
    }, now) ?? item
    : item;
  return {
    found: true,
    item: updated,
    localStatus: 'reverted',
    skill: { id: item.skillId, removed },
    memory: {
      recordId: item.memoryRecordId,
      status: item.memoryRecordId ? 'archived' : 'not-linked',
    },
  };
}

/** Retry the central-memory half for any inactive item. Resolver/context checks
 * already keep it disabled while the remote archive is pending. */
export async function synchronizeLearnedItemLifecycle(input: {
  tenant: LearnedTenant;
  item: LearnedItem;
  memory?: LearnedMemoryLifecyclePort;
  now?: Date;
}): Promise<LearnedLifecycleResult> {
  if (input.item.status === 'active') {
    if (
      input.item.memoryRecordId
      && input.item.memoryLifecycle
      && input.item.memoryLifecycle.status !== 'active'
      && input.memory?.restore
    ) {
      try {
        await input.memory.restore({
          recordId: input.item.memoryRecordId,
          itemId: input.item.id,
          tenant: input.tenant,
          reason: input.item.statusReason ?? 'restored by a newly observed confirmation',
        });
        const updated = updateLearnedMemoryLifecycle(input.tenant, input.item.id, {
          status: 'active', incrementAttempts: true,
        }, input.now) ?? input.item;
        return {
          found: true,
          item: updated,
          localStatus: input.item.status,
          skill: { id: input.item.skillId, removed: false },
          memory: { recordId: input.item.memoryRecordId, status: 'active' },
        };
      } catch (error) {
        const message = errorText(error);
        const updated = updateLearnedMemoryLifecycle(input.tenant, input.item.id, {
          status: 'archive-pending', error: message, incrementAttempts: true,
        }, input.now) ?? input.item;
        return {
          found: true,
          item: updated,
          localStatus: input.item.status,
          skill: { id: input.item.skillId, removed: false },
          memory: {
            recordId: input.item.memoryRecordId,
            status: 'archive-pending',
            error: message,
          },
        };
      }
    }
    return {
      found: true,
      item: input.item,
      localStatus: input.item.status,
      skill: { id: input.item.skillId, removed: false },
      memory: {
        recordId: input.item.memoryRecordId,
        status: input.item.memoryRecordId ? 'active' : 'not-linked',
      },
    };
  }
  const now = input.now ?? new Date();
  // Automatic demotion/retirement disables the skill by authority (the skill
  // resolver checks item status) but keeps its file so a later, genuinely
  // observed confirmation can restore it. Human revert is the destructive
  // skill-removal path above.
  if (!input.item.memoryRecordId) {
    return {
      found: true,
      item: input.item,
      localStatus: input.item.status,
      skill: { id: input.item.skillId, removed: false },
      memory: { status: 'not-linked' },
    };
  }
  if (!input.memory) {
    const message = 'central memory lifecycle port unavailable';
    const updated = updateLearnedMemoryLifecycle(input.tenant, input.item.id, {
      status: 'archive-pending', error: message, incrementAttempts: true,
    }, now) ?? input.item;
    return {
      found: true,
      item: updated,
      localStatus: input.item.status,
      skill: { id: input.item.skillId, removed: false },
      memory: { recordId: input.item.memoryRecordId, status: 'archive-pending', error: message },
    };
  }
  try {
    await input.memory.archive({
      recordId: input.item.memoryRecordId,
      itemId: input.item.id,
      tenant: input.tenant,
      reason: input.item.statusReason ?? `learning item ${input.item.status}`,
    });
    const updated = updateLearnedMemoryLifecycle(input.tenant, input.item.id, {
      status: 'archived', incrementAttempts: true,
    }, now) ?? input.item;
    return {
      found: true,
      item: updated,
      localStatus: input.item.status,
      skill: { id: input.item.skillId, removed: false },
      memory: { recordId: input.item.memoryRecordId, status: 'archived' },
    };
  } catch (error) {
    const message = errorText(error);
    const updated = updateLearnedMemoryLifecycle(input.tenant, input.item.id, {
      status: 'archive-pending', error: message, incrementAttempts: true,
    }, now) ?? input.item;
    return {
      found: true,
      item: updated,
      localStatus: input.item.status,
      skill: { id: input.item.skillId, removed: false },
      memory: { recordId: input.item.memoryRecordId, status: 'archive-pending', error: message },
    };
  }
}
