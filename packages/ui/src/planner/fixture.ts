/**
 * ADR-038 — deterministic acceptance data for every Planner host.
 *
 * Twenty records is the canonical density case: sixteen active, four complete,
 * local and connected work, estimates, a blocked item, moved work, and four
 * queued changes. Keeping it in the shared package prevents each host from
 * rehearsing a different product during visual review.
 */
import type {
  PlannerBlockView,
  PlannerItemView,
  PlannerSyncView,
} from './types.js';

export interface PlannerFixture {
  today: string;
  items: PlannerItemView[];
  blocks: PlannerBlockView[];
  sync: PlannerSyncView;
  staleSources: string[];
  driftNote: string;
}

function dateAt(today: string, offsetDays: number, hour?: number): string {
  const value = new Date(`${today}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  if (hour === undefined) return value.toISOString().slice(0, 10);
  value.setUTCHours(hour);
  return value.toISOString();
}

export function createPlannerFixture(today = '2026-08-11'): PlannerFixture {
  const owned = (id: string, title: string, over: Partial<PlannerItemView> = {}): PlannerItemView => ({
    id,
    title,
    completed: false,
    origin: 'owned',
    conflictFields: [],
    ...over,
  });
  const connected = (
    id: string,
    title: string,
    externalId: string,
    over: Partial<PlannerItemView> = {},
  ): PlannerItemView => owned(id, title, {
    origin: 'mirrored',
    provenance: {
      source: 'GitHub',
      kind: 'issue',
      url: `https://github.com/kinqsradiollc/BrainRouter/issues/${externalId}`,
      externalId: `#${externalId}`,
      updatedAt: dateAt(today, -1, 6),
      fetchedAt: dateAt(today, -1, 7),
    },
    source: 'GitHub',
    sourceKind: 'issue',
    sourceUrl: `https://github.com/kinqsradiollc/BrainRouter/issues/${externalId}`,
    externalId: `#${externalId}`,
    sourceUpdatedAt: dateAt(today, -1, 6),
    sourceFreshness: { label: 'Refreshed 1 day ago', fetchedAt: dateAt(today, -1, 7), stale: true },
    ...over,
  });

  const items: PlannerItemView[] = [
    connected('github:1382', 'Make planner sync failures actionable', '1382', { dueDate: dateAt(today, -1), priority: 1 }),
    owned('itm_release', 'Prepare the 0.4.20 release notes', { dueDate: today, priority: 1, estimateMinutes: 60 }),
    owned('itm_qa', 'Run planner visual acceptance', { dueDate: today, priority: 2 }),
    connected('github:1374', 'Review connected-issue provenance', '1374', { dueDate: today }),
    owned('itm_keyboard', 'Verify keyboard capture and completion', { priority: 2 }),
    owned('itm_tokens', 'Check light and high-contrast tokens'),
    owned('itm_blocked', 'Confirm Windows packaged-app screenshots', {
      blockedReason: 'Waiting for the Windows runner',
    }),
    connected('github:1361', 'Remove the dashboard planner duplicate', '1361'),
    owned('itm_docs', 'Answer ADR-038 open questions', { dueDate: dateAt(today, 1) }),
    owned('itm_review', 'Read automated security review', { dueDate: dateAt(today, 2) }),
    connected('github:1355', 'Project connector issues into the planner', '1355', { dueDate: dateAt(today, 3) }),
    owned('itm_followup', 'Write the verification walkthrough', { dueDate: dateAt(today, 5) }),
    owned('itm_notes', 'Promote planner context into a note page', {
      notes: 'The planner and notes surfaces should share one presentation layer.',
    }),
    owned('itm_estimate', 'Compare estimate drift after the release'),
    owned('itm_cleanup', 'Remove compatibility styles after migration'),
    connected('github:1338', 'Follow up on the mobile planner request', '1338'),
    owned('itm_done_1', 'Create the isolated ADR-038 worktree', { completed: true }),
    owned('itm_done_2', 'Audit the planner wire contract', { completed: true }),
    connected('github:1324', 'Confirm release branch target', '1324', { completed: true }),
    owned('itm_done_4', 'Define the canonical density fixture', { completed: true }),
  ];

  const blocks: PlannerBlockView[] = [
    { id: 'blk_release', itemId: 'itm_release', scheduledFor: dateAt(today, 0, 9), estimateMinutes: 60, carriedOver: 1 },
    { id: 'blk_qa', itemId: 'itm_qa', scheduledFor: dateAt(today, 0, 11), estimateMinutes: 90, carriedOver: 0 },
    { id: 'blk_issue', itemId: 'github:1374', scheduledFor: dateAt(today, 0, 14), estimateMinutes: 45, carriedOver: 0 },
    { id: 'blk_keyboard', itemId: 'itm_keyboard', estimateMinutes: 30, carriedOver: 3 },
    { id: 'blk_tokens', itemId: 'itm_tokens', estimateMinutes: 45, carriedOver: 0 },
    { id: 'blk_docs', itemId: 'itm_docs', scheduledFor: dateAt(today, 1, 10), estimateMinutes: 60, carriedOver: 0 },
    { id: 'blk_review', itemId: 'itm_review', scheduledFor: dateAt(today, 2, 13), estimateMinutes: 30, carriedOver: 0 },
    { id: 'blk_done_1', itemId: 'itm_done_1', estimateMinutes: 20, actualMinutes: 18, carriedOver: 0, completedAt: dateAt(today, -1, 8) },
    { id: 'blk_done_2', itemId: 'itm_done_2', estimateMinutes: 60, actualMinutes: 75, carriedOver: 0, completedAt: dateAt(today, -1, 10) },
  ];

  const pending = [items[0]!, items[1]!, items[4]!, items[8]!];
  return {
    today,
    items,
    blocks,
    sync: {
      label: '4 changes waiting to sync.',
      pendingCount: 4,
      issues: pending.map((item, index) => ({
        id: `fixture-op-${index + 1}`,
        entity: index === 3 ? 'block' : 'item',
        itemId: item.id,
        itemTitle: item.title,
        action: index === 0 ? 'update' : index === 1 ? 'create' : 'update',
        createdAt: dateAt(today, -1, 8 + index),
        ageLabel: `${4 - index}h`,
        attempts: index === 0 ? 5 : 0,
        ...(index === 0 ? { lastError: 'The server refused this change. Check the source and retry.' } : {}),
        stuck: index === 0,
      })),
      lastSyncedAt: dateAt(today, -1, 17),
    },
    staleSources: ['GitHub last refreshed 1 day ago.'],
    driftNote: 'Work here takes about 1.2× its estimate. Estimates that account for that will hold better.',
  };
}
