/**
 * TRACK store — boards.
 *
 * Kanban-style boards: named columns, each mapping to one or more workflow
 * states. `boardView` buckets the (non-archived) work items into their columns,
 * with an `Unmapped` catch-all for statuses no column claims.
 */
import type { Board, WorkItem } from '@kinqs/brainrouter-types';
import { readTrack, writeTrack, shortId, nowIso } from './_internal.js';
import { ensureProject } from './project.js';
import type { CreateBoardInput } from './types.js';

export function createBoard(workspaceRoot: string, input: CreateBoardInput): Board {
  const project = ensureProject(workspaceRoot);
  const store = readTrack(workspaceRoot);
  const ts = nowIso();
  const board: Board = {
    id: shortId('bd'), workspaceRoot, name: input.name, type: input.type ?? 'kanban',
    columns: input.columns ?? project.workflowStates.map((s) => ({ name: s.name, stateIds: [s.id] })),
    swimlaneField: input.swimlaneField, filter: input.filter, createdAt: ts, updatedAt: ts,
  };
  store.boards[board.id] = board;
  writeTrack(workspaceRoot, store);
  return board;
}

export function listBoards(workspaceRoot: string): Board[] {
  return Object.values(readTrack(workspaceRoot).boards).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Group a board's items into its columns (board view). Items are matched by
 * `status` → column `stateIds`; anything unmatched lands in an `Unmapped` bucket.
 */
export function boardView(workspaceRoot: string, boardId: string): Array<{ column: string; items: WorkItem[] }> {
  const store = readTrack(workspaceRoot);
  const board = store.boards[boardId];
  if (!board) return [];
  const items = Object.values(store.workItems).filter((w) => !w.archivedAt);
  const cols = board.columns.map((c) => ({ column: c.name, items: items.filter((w) => c.stateIds.includes(w.status)) }));
  const mapped = new Set(board.columns.flatMap((c) => c.stateIds));
  const unmapped = items.filter((w) => !mapped.has(w.status));
  return unmapped.length ? [...cols, { column: 'Unmapped', items: unmapped }] : cols;
}
