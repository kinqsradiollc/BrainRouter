/**
 * ADR-029 F3 — templates, and the copy that makes them honest.
 *
 * **A template is a page.** B4 already settled that a page is a block with
 * children and E3 settled that a database row is a page; a template type would
 * be the third exception to the same rule, and it would need its own
 * permissions, its own sync path and its own conflict rules before answering the
 * first question anyone asks ("can a template contain a database"). So marking
 * is the whole difference — `NoteBlock.template`, one stamped boolean — and
 * instantiating is a copy of a subtree with new ids.
 *
 * **The judgement this file exists for is what happens to references INSIDE a
 * template.** A3 argues that a document which is quietly wrong is worse than one
 * that is obviously empty, and a naive copy produces exactly the quiet kind: a
 * checklist in the template links to the template's own section, the copy links
 * to the *template's* section, and every page made from that template points at
 * one shared block. Nobody notices until two of them disagree.
 *
 * So the rule is:
 *
 *  - a reference to a block INSIDE the subtree being copied is rewritten to
 *    point at that block's copy — it was a reference to "this page's checklist",
 *    and it still is;
 *  - a reference to anything OUTSIDE is left exactly as it was — it was a
 *    reference to a real planner item, a real file, a real meeting, and A3 says
 *    a reference is live rather than a copy, so rewriting or dropping it would
 *    be inventing an intention nobody had.
 *
 * The same rewrite is what `duplicateBlock` needs, for the identical reason, so
 * both go through `copySubtree` rather than through two walks that drift.
 */
import { isLiveBlock, isTemplate, type NoteBlock } from './block.js';
import { asOneUndo, createBlock, readNotes, updateBlock, type BlockPosition } from './noteStore.js';
import { UNDO_LABELS } from './noteHistory.js';
import { remapNoteRefs } from './noteRefRemap.js';
import { subtreeBlockIds } from './noteTree.js';

export interface CopySubtreeResult {
  /** The copy of the root, or null when the source was not there. */
  rootId: string | null;
  /** Every original id mapped to its copy, in reading order. */
  idMap: Map<string, string>;
}

export interface CopySubtreeOptions extends BlockPosition {
  /** Copy the `template` mark too. Off by default — see `instantiateTemplate`. */
  keepTemplateMark?: boolean;
  /** What the undo entry is called. */
  label?: string;
}

/**
 * Copy a block and everything under it, with new ids.
 *
 * Copies are minted through `createBlock`, so each gets its own device-stamped
 * id and its own outbox entry — reusing ids with a suffix would put two blocks
 * with the same server key on one row, where the merge would silently make them
 * one.
 *
 * The whole copy is ONE undo entry (F4): a person who duplicates a forty-block
 * page and presses ⌘Z means "not that", not "forty times not that".
 *
 * `favourite` is deliberately not carried: a copy is a draft, and quietly adding
 * a second entry to the sidebar for it is a surprise. The `template` mark is not
 * carried either unless asked for, because a page made FROM a template is a
 * page — leaving the mark on would turn every filled-in copy into another
 * template in the "new page from…" list.
 */
export function copySubtree(
  userId: string | undefined,
  rootId: string,
  at: CopySubtreeOptions,
  nowMs: number,
): CopySubtreeResult {
  const state = readNotes(userId);
  const source = state.blocks[rootId];
  if (!source || !isLiveBlock(source)) return { rootId: null, idMap: new Map() };

  const blocks = Object.values(state.blocks);
  const ids = subtreeBlockIds(blocks, rootId);
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const idMap = new Map<string, string>();
  let copiedRoot: string | null = null;

  asOneUndo(userId, at.label ?? UNDO_LABELS.duplicate, () => {
    // PASS ONE mints every copy. The remap needs the whole map before any text
    // is written, because a template's first block routinely links to its last —
    // rewriting as we go would leave forward references pointing at the
    // original, which is the half-copied outcome that is worst of all: some
    // links follow the copy and some follow the template.
    for (const originalId of ids) {
      const original = byId.get(originalId);
      if (!original) continue;

      const isRoot = originalId === rootId;
      const parentId = isRoot
        ? (at.parentId === undefined ? (original.parentId.value ?? null) : at.parentId)
        : idMap.get(original.parentId.value ?? '') ?? null;
      // A descendant whose copied parent is missing would land at the top level
      // and scatter the copy across the workspace. Skipping keeps it a subtree.
      if (!isRoot && parentId === null) continue;

      const copy = createBlock(userId, {
        kind: original.kind.value,
        text: original.text.value,
        parentId,
        ...(isRoot
          ? {
            ...(at.after ? { after: at.after } : {}),
            ...(at.before ? { before: at.before } : {}),
            ...(at.after || at.before || at.parentId !== undefined ? {} : { after: rootId }),
          }
          : {}),
        ...(original.level ? { level: original.level.value } : {}),
        ...(original.checked ? { checked: original.checked.value } : {}),
        ...(original.language ? { language: original.language.value } : {}),
        ...(original.collapsed ? { collapsed: original.collapsed.value } : {}),
        ...(original.icon ? { icon: original.icon.value } : {}),
        ...(original.cover ? { cover: original.cover.value } : {}),
        // E3 — a copied database keeps its columns and its views, and a copied
        // row keeps its cells. Without these, duplicating a database produced a
        // container with no schema, which renders as a database that failed to
        // load.
        ...(original.props ? { props: Object.fromEntries(
          Object.entries(original.props).map(([key, stamped]) => [key, stamped.value]),
        ) } : {}),
        ...(original.schema ? { schema: original.schema.value } : {}),
        ...(original.views ? { views: original.views.value } : {}),
        ...(at.keepTemplateMark && original.template ? { template: original.template.value } : {}),
      }, nowMs);

      idMap.set(originalId, copy.id);
      if (isRoot) copiedRoot = copy.id;
    }

    // PASS TWO rewrites the internal references, now that every copy exists.
    // Only blocks whose text actually changed are written, so a template of
    // plain prose costs nothing beyond the scan.
    for (const [originalId, copyId] of idMap) {
      const original = byId.get(originalId);
      if (!original) continue;
      const rewritten = remapNoteRefs(original.text.value, idMap);
      if (rewritten === original.text.value) continue;
      // Through the store's own update, so the rewrite is stamped, queued and
      // merged like every other write rather than poked into the file.
      updateBlock(userId, copyId, { text: rewritten }, nowMs);
    }
  });

  return { rootId: copiedRoot, idMap };
}

/* --------------------------------------------------------------- templates */

/** Every page currently marked as a template, in the order they were made. */
export function listTemplates(userId: string | undefined): NoteBlock[] {
  return Object.values(readNotes(userId).blocks)
    .filter(isTemplate)
    .sort((a, b) => a.rank.value.localeCompare(b.rank.value) || a.id.localeCompare(b.id));
}

export interface InstantiateResult {
  ok: boolean;
  /** The new page's id, or null when the template was gone. */
  pageId: string | null;
  /** How many blocks the template brought with it — what the surface reports. */
  blocks: number;
  /** How many internal references were rewritten to point at the copy. */
  rewritten: number;
}

/**
 * Make a page from a template.
 *
 * The copy is NOT itself a template (see `copySubtree`), and its internal
 * references point at its own blocks rather than at the template's — which is
 * the whole reason this is a function and not a call to `duplicateBlock` with a
 * different parent.
 */
export function instantiateTemplate(
  userId: string | undefined,
  templateId: string,
  at: BlockPosition,
  nowMs: number,
): InstantiateResult {
  const state = readNotes(userId);
  const template = state.blocks[templateId];
  if (!template || !isTemplate(template)) return { ok: false, pageId: null, blocks: 0, rewritten: 0 };

  const before = new Map(Object.entries(state.blocks));
  const copied = copySubtree(userId, templateId, { ...at, label: UNDO_LABELS.template }, nowMs);
  if (!copied.rootId) return { ok: false, pageId: null, blocks: 0, rewritten: 0 };

  let rewritten = 0;
  for (const originalId of copied.idMap.keys()) {
    const original = before.get(originalId);
    if (!original) continue;
    if (remapNoteRefs(original.text.value, copied.idMap) !== original.text.value) rewritten += 1;
  }
  return { ok: true, pageId: copied.rootId, blocks: copied.idMap.size, rewritten };
}

/** The sentence a surface shows after instantiating, so the rewrite is not silent. */
export function describeInstantiation(result: InstantiateResult): string {
  if (!result.ok) return 'That template is no longer here.';
  const blocks = `${result.blocks} block${result.blocks === 1 ? '' : 's'}`;
  if (result.rewritten === 0) return `New page from the template — ${blocks}.`;
  const links = `${result.rewritten} link${result.rewritten === 1 ? '' : 's'}`;
  // Said out loud rather than left to be discovered: a person who wrote those
  // links deliberately needs to know they now point at the copy, and one who
  // expected them to keep pointing at the template needs to know they do not.
  return `New page from the template — ${blocks}, and ${links} inside it now point at this copy `
    + 'rather than at the template.';
}
