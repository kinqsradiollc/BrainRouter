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
 * both execute `planNoteSubtreeCopy` rather than maintaining two walks.
 */
import { isTemplate, type NoteBlock } from './block.js';
import { executeNoteGesturePlan } from './blockOps.js';
import { planNoteSubtreeCopy } from './gesturePlan.js';
import { mintNoteBlockId, readNotes, type BlockPosition } from './noteStore.js';
import { UNDO_LABELS } from './noteHistory.js';
import { remapNoteRefs } from './noteRefRemap.js';
import { type InstantiateResult } from './templatePolicy.js';

export { describeInstantiation, type InstantiateResult } from './templatePolicy.js';

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
  const plan = planNoteSubtreeCopy(
    Object.values(state.blocks),
    rootId,
    {
      ...(at.parentId !== undefined ? { parentId: at.parentId } : {}),
      ...(at.after ? { after: at.after } : {}),
      ...(at.before ? { before: at.before } : {}),
    },
    {
      mintId: () => mintNoteBlockId(userId, nowMs),
      ...(at.keepTemplateMark ? { keepTemplateMark: true } : {}),
    },
  );
  if (!plan.ok) return { rootId: null, idMap: plan.idMap };

  const written = executeNoteGesturePlan(
    userId,
    plan,
    at.label ?? UNDO_LABELS.duplicate,
    nowMs,
  );
  return {
    rootId: written.ok ? plan.result.createdId ?? null : null,
    idMap: plan.idMap,
  };
}

/* --------------------------------------------------------------- templates */

/** Every page currently marked as a template, in the order they were made. */
export function listTemplates(userId: string | undefined): NoteBlock[] {
  return Object.values(readNotes(userId).blocks)
    .filter(isTemplate)
    .sort((a, b) => a.rank.value.localeCompare(b.rank.value) || a.id.localeCompare(b.id));
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
