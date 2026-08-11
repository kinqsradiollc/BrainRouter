/**
 * ADR-038 — Notes gestures as pure plans.
 *
 * This is the one policy both local store-backed editing and remote Dashboard
 * editing execute. It accepts the blocks a host may see and returns primitive
 * creates, field writes, moves and tombstones; it never reads a file, talks to a
 * server or invents a second persistence path.
 */
import {
  CONTINUING_KINDS, holdsProse, isCollapsed, isLiveBlock, STYLED_TEXT_KINDS,
  type NoteBlock, type NoteBlockKind,
} from './block.js';
import type { NoteMutationBlockFields, NoteMutationPosition } from './editingContract.js';
import { remapNoteRefs } from './noteRefRemap.js';
import { buildNoteTree, subtreeBlockIds, type NoteTreeNode } from './noteTree.js';
import { compareRank, FIRST_RANK, rankBetween } from './rank.js';
import type { Hlc } from '../sync/hybridClock.js';

export type BlockOpAction =
  | 'split'
  | 'merge'
  | 'unstyle'
  | 'indent'
  | 'outdent'
  | 'duplicate'
  | 'move'
  | 'remove-previous'
  | 'noop';

export interface BlockOpOk {
  ok: true;
  action: BlockOpAction;
  focusId: string | null;
  caret: number;
  createdId?: string;
  removedIds?: string[];
}

export type BlockOpFailure =
  | { ok: false; reason: 'not_found'; detail: string }
  | { ok: false; reason: 'locked'; detail: string }
  | { ok: false; reason: 'not_splittable'; detail: string }
  | { ok: false; reason: 'refused'; detail: string };

export type BlockOpResult = BlockOpOk | BlockOpFailure;

export type NoteGesture =
  | { type: 'split'; blockId: string; caret: number }
  | { type: 'merge'; blockId: string }
  | { type: 'duplicate'; blockId: string }
  | { type: 'indent'; blockId: string }
  | { type: 'outdent'; blockId: string }
  | { type: 'move'; blockId: string; direction: -1 | 1 };

export interface PlannedBlockCreate extends NoteMutationBlockFields {
  id: string;
  parentId: string | null;
  rank: string;
}

export type NoteGestureStep =
  | { type: 'create'; block: PlannedBlockCreate }
  | { type: 'update'; blockId: string; patch: NoteMutationBlockFields }
  | { type: 'move'; blockId: string; parentId: string | null; rank: string }
  | { type: 'delete'; blockId: string; subtreeIds: string[] };

export type NoteGesturePlan =
  | { ok: true; result: BlockOpOk; steps: NoteGestureStep[] }
  | { ok: false; result: BlockOpFailure; steps: [] };

export type NoteSubtreeCopyPlan = NoteGesturePlan & {
  /** Original id to copied id, in reading order. */
  idMap: Map<string, string>;
};

export interface NoteGesturePlanOptions {
  /** Called in reading order. The returned id must be stable for a remote retry. */
  mintId: (sourceId: string, index: number) => string;
}

interface Positioned {
  block: NoteBlock;
  parentId: string | null;
  depth: number;
  children: NoteBlock[];
}

interface Layout {
  order: string[];
  at: Map<string, Positioned>;
}

const PLAN_AT: Hlc = { physical: 0, logical: 0, deviceId: 'notes-plan' };
const stamped = <T>(value: T) => ({ value, at: PLAN_AT });

function layout(blocks: Iterable<NoteBlock>): Layout {
  const tree = buildNoteTree(blocks);
  const order: string[] = [];
  const at = new Map<string, Positioned>();
  const walk = (nodes: readonly NoteTreeNode[], parentId: string | null): void => {
    for (const node of nodes) {
      order.push(node.block.id);
      at.set(node.block.id, {
        block: node.block,
        parentId,
        depth: node.depth,
        children: node.children.map((child) => child.block),
      });
      walk(node.children, node.block.id);
    }
  };
  walk(tree.roots, null);
  return { order, at };
}

function isContainerKind(kind: NoteBlockKind): boolean {
  return kind === 'page' || kind === 'database';
}

function enclosingPage(at: Map<string, Positioned>, id: string): string | null {
  const seen = new Set<string>([id]);
  let cursor = at.get(id)?.parentId ?? null;
  while (cursor !== null) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
    const parent = at.get(cursor);
    if (!parent) return null;
    if (isContainerKind(parent.block.kind.value)) return cursor;
    cursor = parent.parentId;
  }
  return null;
}

function depthOnPage(at: Map<string, Positioned>, id: string): number {
  const here = at.get(id);
  if (!here) return 0;
  const pageId = enclosingPage(at, id);
  const base = pageId === null ? -1 : (at.get(pageId)?.depth ?? -1);
  return Math.max(0, here.depth - base - 1);
}

function siblingsOf(at: Map<string, Positioned>, order: readonly string[], parentId: string | null): Positioned[] {
  return order
    .map((id) => at.get(id))
    .filter((entry): entry is Positioned => !!entry && entry.parentId === parentId);
}

function isTableRow(block: NoteBlock): boolean {
  return block.kind.value === 'table-row';
}

const missing = (id: string): BlockOpFailure => ({
  ok: false, reason: 'not_found', detail: `No block ${id}.`,
});

function continuationKind(kind: NoteBlockKind): NoteBlockKind {
  return CONTINUING_KINDS.includes(kind) ? kind : 'paragraph';
}

function createBlockShape(input: PlannedBlockCreate): NoteBlock {
  return {
    id: input.id,
    createdAt: PLAN_AT,
    parentId: stamped(input.parentId),
    rank: stamped(input.rank),
    kind: stamped(input.kind ?? 'paragraph'),
    text: stamped(input.text ?? ''),
    ...(input.level !== undefined ? { level: stamped(input.level) } : {}),
    ...(input.checked !== undefined ? { checked: stamped(input.checked) } : {}),
    ...(input.language !== undefined ? { language: stamped(input.language) } : {}),
    ...(input.collapsed !== undefined ? { collapsed: stamped(input.collapsed) } : {}),
    ...(input.icon !== undefined ? { icon: stamped(input.icon) } : {}),
    ...(input.cover !== undefined ? { cover: stamped(input.cover) } : {}),
    ...(input.favourite !== undefined ? { favourite: stamped(input.favourite) } : {}),
    ...(input.template !== undefined ? { template: stamped(input.template) } : {}),
    ...(input.props ? { props: Object.fromEntries(
      Object.entries(input.props).map(([id, value]) => [id, stamped(value)]),
    ) } : {}),
    ...(input.schema ? { schema: stamped(input.schema) } : {}),
    ...(input.views ? { views: stamped(input.views) } : {}),
  };
}

function updateBlockShape(block: NoteBlock, patch: NoteMutationBlockFields): NoteBlock {
  return {
    ...block,
    ...(patch.text !== undefined ? { text: stamped(patch.text) } : {}),
    ...(patch.kind !== undefined ? { kind: stamped(patch.kind) } : {}),
    ...(patch.level !== undefined ? { level: stamped(patch.level) } : {}),
    ...(patch.checked !== undefined ? { checked: stamped(patch.checked) } : {}),
    ...(patch.language !== undefined ? { language: stamped(patch.language) } : {}),
    ...(patch.collapsed !== undefined ? { collapsed: stamped(patch.collapsed) } : {}),
    ...(patch.icon !== undefined ? { icon: stamped(patch.icon) } : {}),
    ...(patch.cover !== undefined ? { cover: stamped(patch.cover) } : {}),
    ...(patch.favourite !== undefined ? { favourite: stamped(patch.favourite) } : {}),
    ...(patch.template !== undefined ? { template: stamped(patch.template) } : {}),
    ...(patch.props ? { props: {
      ...(block.props ?? {}),
      ...Object.fromEntries(Object.entries(patch.props).map(([id, value]) => [id, stamped(value)])),
    } } : {}),
    ...(patch.schema ? { schema: stamped(patch.schema) } : {}),
    ...(patch.views ? { views: stamped(patch.views) } : {}),
  };
}

function rawSiblings(
  blocks: Iterable<NoteBlock>,
  parentId: string | null,
  movingId?: string,
): NoteBlock[] {
  return [...blocks]
    .filter((block) => isLiveBlock(block)
      && block.id !== movingId
      && (block.parentId.value ?? null) === parentId)
    .sort((a, b) => compareRank(
      { rank: a.rank.value, id: a.id },
      { rank: b.rank.value, id: b.id },
    ));
}

/**
 * Resolve an id-relative position to the rank that must travel over sync.
 *
 * Exported for direct `block.create` / `block.move` and database-row creation,
 * so those operations do not grow their own almost-the-same placement rule.
 */
export function resolveNoteMutationPosition(
  blocks: Iterable<NoteBlock>,
  position: NoteMutationPosition,
  movingId?: string,
): { ok: true; parentId: string | null; rank: string } | { ok: false; detail: string } {
  if (position.after && position.before) {
    return { ok: false, detail: 'A position may name after or before, not both.' };
  }
  const all = [...blocks];
  const moving = movingId ? all.find((block) => block.id === movingId && isLiveBlock(block)) : undefined;
  if (movingId && !moving) return { ok: false, detail: `No block ${movingId}.` };
  const parentId = position.parentId === undefined
    ? (moving?.parentId.value ?? null)
    : position.parentId;

  if (parentId !== null && !all.some((block) => block.id === parentId && isLiveBlock(block))) {
    return { ok: false, detail: `No block ${parentId}.` };
  }

  if (movingId && parentId !== null && subtreeBlockIds(all, movingId).includes(parentId)) {
    return { ok: false, detail: 'A block cannot be moved inside one of its own children.' };
  }

  const siblings = rawSiblings(all, parentId, movingId);
  if (position.after) {
    const index = siblings.findIndex((block) => block.id === position.after);
    if (index < 0) return { ok: false, detail: `No sibling ${position.after} under this parent.` };
    return {
      ok: true,
      parentId,
      rank: rankBetween(siblings[index]!.rank.value, siblings[index + 1]?.rank.value ?? null),
    };
  }
  if (position.before) {
    const index = siblings.findIndex((block) => block.id === position.before);
    if (index < 0) return { ok: false, detail: `No sibling ${position.before} under this parent.` };
    return {
      ok: true,
      parentId,
      rank: rankBetween(siblings[index - 1]?.rank.value ?? null, siblings[index]!.rank.value),
    };
  }
  if (siblings.length === 0) return { ok: true, parentId, rank: FIRST_RANK };
  return {
    ok: true,
    parentId,
    rank: rankBetween(siblings[siblings.length - 1]!.rank.value, null),
  };
}

class PlanBuilder {
  readonly blocks: Map<string, NoteBlock>;
  readonly steps: NoteGestureStep[] = [];

  constructor(blocks: Iterable<NoteBlock>) {
    this.blocks = new Map([...blocks].map((block) => [block.id, block] as const));
  }

  values(): NoteBlock[] { return [...this.blocks.values()]; }

  create(block: PlannedBlockCreate): BlockOpFailure | null {
    if (this.blocks.has(block.id)) {
      return { ok: false, reason: 'refused', detail: `Block id ${block.id} already exists.` };
    }
    this.blocks.set(block.id, createBlockShape(block));
    this.steps.push({ type: 'create', block });
    return null;
  }

  update(blockId: string, patch: NoteMutationBlockFields): BlockOpFailure | null {
    const block = this.blocks.get(blockId);
    if (!block || !isLiveBlock(block)) return missing(blockId);
    this.blocks.set(blockId, updateBlockShape(block, patch));
    this.steps.push({ type: 'update', blockId, patch });
    return null;
  }

  move(blockId: string, to: NoteMutationPosition): BlockOpFailure | null {
    const block = this.blocks.get(blockId);
    if (!block || !isLiveBlock(block)) return missing(blockId);
    const placed = resolveNoteMutationPosition(this.values(), to, blockId);
    if (!placed.ok) return { ok: false, reason: 'refused', detail: placed.detail };
    this.blocks.set(blockId, {
      ...block,
      parentId: stamped(placed.parentId),
      rank: stamped(placed.rank),
    });
    this.steps.push({ type: 'move', blockId, parentId: placed.parentId, rank: placed.rank });
    return null;
  }

  delete(blockId: string): string[] {
    const ids = subtreeBlockIds(this.values(), blockId);
    for (const id of ids) {
      const block = this.blocks.get(id);
      if (block) this.blocks.set(id, { ...block, deletedAt: PLAN_AT });
    }
    if (ids.length > 0) this.steps.push({ type: 'delete', blockId, subtreeIds: ids });
    return ids;
  }
}

function makeCreate(
  plan: PlanBuilder,
  id: string,
  fields: NoteMutationBlockFields,
  position: NoteMutationPosition,
): BlockOpFailure | PlannedBlockCreate {
  const placed = resolveNoteMutationPosition(plan.values(), position);
  if (!placed.ok) return { ok: false, reason: 'refused', detail: placed.detail };
  const block: PlannedBlockCreate = {
    id,
    parentId: placed.parentId,
    rank: placed.rank,
    ...fields,
  };
  const failure = plan.create(block);
  return failure ?? block;
}

function ok(result: BlockOpOk, plan: PlanBuilder): NoteGesturePlan {
  return { ok: true, result, steps: plan.steps };
}

function fail(result: BlockOpFailure): NoteGesturePlan {
  return { ok: false, result, steps: [] };
}

function unstyle(plan: PlanBuilder, id: string): NoteGesturePlan {
  const failure = plan.update(id, { kind: 'paragraph' });
  return failure
    ? fail(failure)
    : ok({ ok: true, action: 'unstyle', focusId: id, caret: 0 }, plan);
}

function outdent(plan: PlanBuilder, id: string): NoteGesturePlan {
  const view = layout(plan.values());
  const here = view.at.get(id);
  if (!here) return fail(missing(id));
  if (here.parentId === null || isTableRow(here.block) || depthOnPage(view.at, id) === 0) {
    return ok({ ok: true, action: 'noop', focusId: id, caret: 0 }, plan);
  }
  const parent = view.at.get(here.parentId);
  const failure = plan.move(id, { parentId: parent?.parentId ?? null, after: here.parentId });
  return failure
    ? fail(failure)
    : ok({ ok: true, action: 'outdent', focusId: id, caret: 0 }, plan);
}

function split(
  plan: PlanBuilder,
  gesture: Extract<NoteGesture, { type: 'split' }>,
  options: NoteGesturePlanOptions,
): NoteGesturePlan {
  const view = layout(plan.values());
  const here = view.at.get(gesture.blockId);
  if (!here) return fail(missing(gesture.blockId));
  const kind = here.block.kind.value;
  if (kind === 'code') {
    return fail({
      ok: false,
      reason: 'not_splittable',
      detail: 'Enter inside a code block adds a line.',
    });
  }

  const id = options.mintId(`${gesture.blockId}:split`, 0);
  if (isTableRow(here.block)) {
    const made = makeCreate(plan, id, { kind: 'table-row', text: '' }, {
      parentId: here.parentId,
      after: gesture.blockId,
    });
    if ('ok' in made && made.ok === false) return fail(made);
    return ok({ ok: true, action: 'split', focusId: id, caret: 0, createdId: id }, plan);
  }

  if (!holdsProse(kind)) {
    const firstChild = here.children.find(isLiveBlock);
    const made = makeCreate(plan, id, { kind: 'paragraph', text: '' }, kind === 'page'
      ? { parentId: gesture.blockId, ...(firstChild ? { before: firstChild.id } : {}) }
      : { parentId: here.parentId, after: gesture.blockId });
    if ('ok' in made && made.ok === false) return fail(made);
    return ok({ ok: true, action: 'split', focusId: id, caret: 0, createdId: id }, plan);
  }

  const text = here.block.text.value;
  const cut = Math.min(Math.max(Math.trunc(gesture.caret), 0), text.length);
  if (CONTINUING_KINDS.includes(kind) && text.trim().length === 0) {
    return here.depth > 0 ? outdent(plan, gesture.blockId) : unstyle(plan, gesture.blockId);
  }

  const head = text.slice(0, cut);
  const tail = text.slice(cut);
  if (head !== text) {
    const failure = plan.update(gesture.blockId, { text: head });
    if (failure) return fail(failure);
  }
  const visibleChildren = here.children.filter(isLiveBlock);
  const nestUnder = visibleChildren.length > 0 && !isCollapsed(here.block);
  const made = makeCreate(plan, id, { kind: continuationKind(kind), text: tail }, nestUnder
    ? { parentId: gesture.blockId, before: visibleChildren[0]!.id }
    : { parentId: here.parentId, after: gesture.blockId });
  if ('ok' in made && made.ok === false) return fail(made);
  return ok({ ok: true, action: 'split', focusId: id, caret: 0, createdId: id }, plan);
}

function merge(plan: PlanBuilder, id: string): NoteGesturePlan {
  const view = layout(plan.values());
  const here = view.at.get(id);
  if (!here) return fail(missing(id));
  if (isTableRow(here.block)) {
    if (here.block.text.value.length > 0) {
      return ok({ ok: true, action: 'noop', focusId: id, caret: 0 }, plan);
    }
    const index = view.order.indexOf(id);
    const above = index > 0 ? view.order[index - 1]! : null;
    const removed = plan.delete(id);
    return ok({ ok: true, action: 'merge', focusId: above, caret: 0, removedIds: removed }, plan);
  }

  const kind = here.block.kind.value;
  if (STYLED_TEXT_KINDS.includes(kind)) return unstyle(plan, id);
  if (depthOnPage(view.at, id) > 0) return outdent(plan, id);

  const page = enclosingPage(view.at, id);
  const index = view.order.indexOf(id);
  let previousId: string | undefined;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = view.order[cursor]!;
    if (enclosingPage(view.at, candidate) === page) {
      previousId = candidate;
      break;
    }
  }
  if (!previousId) return ok({ ok: true, action: 'noop', focusId: id, caret: 0 }, plan);

  const previous = view.at.get(previousId)!;
  if (!holdsProse(previous.block.kind.value)) {
    if (previous.block.kind.value === 'page' || previous.children.some(isLiveBlock)) {
      return ok({ ok: true, action: 'noop', focusId: id, caret: 0 }, plan);
    }
    const removed = plan.delete(previousId);
    return ok({
      ok: true, action: 'remove-previous', focusId: id, caret: 0, removedIds: removed,
    }, plan);
  }

  const joinAt = previous.block.text.value.length;
  const failure = plan.update(previousId, {
    text: previous.block.text.value + here.block.text.value,
  });
  if (failure) return fail(failure);
  for (const child of here.children.filter(isLiveBlock)) {
    const moved = plan.move(child.id, { parentId: previousId });
    if (moved) return fail(moved);
  }
  const removed = plan.delete(id);
  return ok({
    ok: true, action: 'merge', focusId: previousId, caret: joinAt, removedIds: removed,
  }, plan);
}

function indent(plan: PlanBuilder, id: string): NoteGesturePlan {
  const view = layout(plan.values());
  const here = view.at.get(id);
  if (!here) return fail(missing(id));
  if (isTableRow(here.block)) return ok({ ok: true, action: 'noop', focusId: id, caret: 0 }, plan);
  const siblings = siblingsOf(view.at, view.order, here.parentId);
  const index = siblings.findIndex((entry) => entry.block.id === id);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  if (!previous) return ok({ ok: true, action: 'noop', focusId: id, caret: 0 }, plan);
  const failure = plan.move(id, { parentId: previous.block.id });
  return failure
    ? fail(failure)
    : ok({ ok: true, action: 'indent', focusId: id, caret: 0 }, plan);
}

function move(plan: PlanBuilder, id: string, direction: -1 | 1): NoteGesturePlan {
  const view = layout(plan.values());
  const here = view.at.get(id);
  if (!here) return fail(missing(id));
  const siblings = siblingsOf(view.at, view.order, here.parentId);
  const index = siblings.findIndex((entry) => entry.block.id === id);
  const target = siblings[index + direction];
  if (index < 0 || !target) return ok({ ok: true, action: 'noop', focusId: id, caret: 0 }, plan);
  const failure = plan.move(id, direction < 0
    ? { parentId: here.parentId, before: target.block.id }
    : { parentId: here.parentId, after: target.block.id });
  return failure
    ? fail(failure)
    : ok({ ok: true, action: 'move', focusId: id, caret: 0 }, plan);
}

function copiedFields(original: NoteBlock, text: string): NoteMutationBlockFields {
  return {
    kind: original.kind.value,
    text,
    ...(original.level ? { level: original.level.value } : {}),
    ...(original.checked ? { checked: original.checked.value } : {}),
    ...(original.language ? { language: original.language.value } : {}),
    ...(original.collapsed ? { collapsed: original.collapsed.value } : {}),
    ...(original.icon ? { icon: original.icon.value } : {}),
    ...(original.cover ? { cover: original.cover.value } : {}),
    ...(original.props ? { props: Object.fromEntries(
      Object.entries(original.props).map(([key, value]) => [key, value.value]),
    ) } : {}),
    ...(original.schema ? { schema: original.schema.value } : {}),
    ...(original.views ? { views: original.views.value } : {}),
  };
}

/** The shared subtree-copy policy used by duplicate and template hosts. */
export function planNoteSubtreeCopy(
  blocks: Iterable<NoteBlock>,
  rootId: string,
  position: NoteMutationPosition,
  options: NoteGesturePlanOptions & { keepTemplateMark?: boolean },
): NoteSubtreeCopyPlan {
  const originalBlocks = [...blocks];
  const source = originalBlocks.find((block) => block.id === rootId && isLiveBlock(block));
  if (!source) return { ...fail(missing(rootId)), idMap: new Map() };
  const ids = subtreeBlockIds(originalBlocks, rootId);
  const byId = new Map(originalBlocks.map((block) => [block.id, block] as const));
  const idMap = new Map(ids.map((id, index) => [id, options.mintId(id, index)] as const));
  const plan = new PlanBuilder(originalBlocks);

  for (const originalId of ids) {
    const original = byId.get(originalId);
    const copyId = idMap.get(originalId);
    if (!original || !copyId) continue;
    const isRoot = originalId === rootId;
    const parentId = isRoot
      ? (position.parentId === undefined ? (original.parentId.value ?? null) : position.parentId)
      : idMap.get(original.parentId.value ?? '') ?? null;
    if (!isRoot && parentId === null) continue;
    const at: NoteMutationPosition = isRoot
      ? {
          parentId,
          ...(position.after ? { after: position.after } : {}),
          ...(position.before ? { before: position.before } : {}),
          ...(position.after || position.before || position.parentId !== undefined
            ? {}
            : { after: rootId }),
        }
      : { parentId };
    const fields = copiedFields(original, remapNoteRefs(original.text.value, idMap));
    if (options.keepTemplateMark && original.template) fields.template = original.template.value;
    const made = makeCreate(plan, copyId, fields, at);
    if ('ok' in made && made.ok === false) return { ...fail(made), idMap };
  }

  const copiedRoot = idMap.get(rootId)!;
  return { ...ok({
    ok: true,
    action: 'duplicate',
    focusId: copiedRoot,
    caret: 0,
    createdId: copiedRoot,
  }, plan), idMap };
}

/** Decide one editor gesture without touching persistence. */
export function planNoteGesture(
  blocks: Iterable<NoteBlock>,
  gesture: NoteGesture,
  options: NoteGesturePlanOptions,
): NoteGesturePlan {
  const plan = new PlanBuilder(blocks);
  switch (gesture.type) {
    case 'split': return split(plan, gesture, options);
    case 'merge': return merge(plan, gesture.blockId);
    case 'indent': return indent(plan, gesture.blockId);
    case 'outdent': return outdent(plan, gesture.blockId);
    case 'move': return move(plan, gesture.blockId, gesture.direction);
    case 'duplicate':
      return planNoteSubtreeCopy(plan.values(), gesture.blockId, { after: gesture.blockId }, options);
  }
}
