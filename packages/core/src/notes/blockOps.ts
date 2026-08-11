/**
 * ADR-029 E1 / ADR-038 — execute Core's pure Notes gesture plans locally.
 *
 * `gesturePlan.ts` owns every editing judgement. This module is deliberately a
 * thin adapter over `noteStore`: it preserves local leases, HLC stamps, outbox
 * entries and one-step undo while the Dashboard executes the identical plan on
 * the server. Keeping policy out of this adapter is what prevents Enter or
 * Backspace from becoming a different gesture on each surface.
 */
import {
  planNoteGesture,
  type BlockOpFailure,
  type BlockOpResult,
  type NoteGesture,
  type NoteGesturePlan,
  type NoteGestureStep,
} from './gesturePlan.js';
import { UNDO_LABELS } from './noteHistory.js';
import {
  asOneUndo, createBlock, deleteBlock, mintNoteBlockId, moveBlock, readNotes, updateBlock,
  type BlockWriteResult,
} from './noteStore.js';

export type {
  BlockOpAction, BlockOpFailure, BlockOpOk, BlockOpResult,
} from './gesturePlan.js';

function failed(result: BlockWriteResult): BlockOpFailure | null {
  if (result.ok) return null;
  if (result.reason === 'locked') {
    return { ok: false, reason: 'locked', detail: result.detail };
  }
  if (result.reason === 'not_found') {
    return { ok: false, reason: 'not_found', detail: 'That block is gone.' };
  }
  return { ok: false, reason: 'refused', detail: result.detail };
}

function executeStep(
  userId: string | undefined,
  step: NoteGestureStep,
  nowMs: number,
): BlockOpFailure | null {
  switch (step.type) {
    case 'create':
      try {
        createBlock(userId, {
          ...step.block,
          id: step.block.id,
          parentId: step.block.parentId,
          rank: step.block.rank,
        }, nowMs);
        return null;
      } catch (error) {
        return {
          ok: false,
          reason: 'refused',
          detail: error instanceof Error ? error.message : 'The block could not be created.',
        };
      }
    case 'update':
      return failed(updateBlock(userId, step.blockId, step.patch, nowMs));
    case 'move':
      return failed(moveBlock(userId, step.blockId, {
        parentId: step.parentId,
        rank: step.rank,
      }, nowMs));
    case 'delete':
      deleteBlock(userId, step.blockId, nowMs);
      return null;
  }
}

/**
 * Execute a plan through the local store's only write path.
 *
 * Exported for store-backed hosts that need a precomputed plan (templates are
 * one); browser callers import and execute the pure plan through their host.
 */
export function executeNoteGesturePlan(
  userId: string | undefined,
  plan: NoteGesturePlan,
  label: string,
  nowMs: number,
): BlockOpResult {
  if (!plan.ok) return plan.result;
  return asOneUndo(userId, label, () => {
    for (const step of plan.steps) {
      const failure = executeStep(userId, step, nowMs);
      if (failure) return failure;
    }
    return plan.result;
  });
}

function labelFor(gesture: NoteGesture): string {
  switch (gesture.type) {
    case 'split': return UNDO_LABELS.split;
    case 'merge': return UNDO_LABELS.merge;
    case 'indent': return UNDO_LABELS.indent;
    case 'outdent': return UNDO_LABELS.outdent;
    case 'move': return UNDO_LABELS.move;
    case 'duplicate': return UNDO_LABELS.duplicate;
  }
}

function run(
  userId: string | undefined,
  gesture: NoteGesture,
  nowMs: number,
): BlockOpResult {
  const plan = planNoteGesture(Object.values(readNotes(userId).blocks), gesture, {
    mintId: () => mintNoteBlockId(userId, nowMs),
  });
  return executeNoteGesturePlan(userId, plan, labelFor(gesture), nowMs);
}

/** Enter — split at the caret, or apply the context-specific continuation rule. */
export function splitBlock(
  userId: string | undefined,
  id: string,
  caret: number,
  nowMs: number,
): BlockOpResult {
  return run(userId, { type: 'split', blockId: id, caret }, nowMs);
}

/** Backspace at column zero — unstyle, outdent, remove or merge as Core decides. */
export function mergeIntoPrevious(
  userId: string | undefined,
  id: string,
  nowMs: number,
): BlockOpResult {
  return run(userId, { type: 'merge', blockId: id }, nowMs);
}

/** Tab — nest under the previous sibling. */
export function indentBlock(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  return run(userId, { type: 'indent', blockId: id }, nowMs);
}

/** Shift-Tab — lift one level without leaving the current page. */
export function outdentBlock(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  return run(userId, { type: 'outdent', blockId: id }, nowMs);
}

/** Move one position among siblings. */
export function moveBlockBy(
  userId: string | undefined,
  id: string,
  direction: -1 | 1,
  nowMs: number,
): BlockOpResult {
  return run(userId, { type: 'move', blockId: id, direction }, nowMs);
}

export function moveBlockUp(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  return moveBlockBy(userId, id, -1, nowMs);
}

export function moveBlockDown(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  return moveBlockBy(userId, id, 1, nowMs);
}

/** Duplicate a block and its subtree, remapping references that stay inside it. */
export function duplicateBlock(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  return run(userId, { type: 'duplicate', blockId: id }, nowMs);
}
