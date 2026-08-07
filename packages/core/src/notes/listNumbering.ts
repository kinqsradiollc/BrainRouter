/**
 * ADR-029 E4 — a numbered item's number, computed from where it sits.
 *
 * **Nothing here is stored, and that is the decision.** A stored ordinal goes
 * wrong the moment a sibling is deleted on another device: the block that was
 * `3` is still `3`, the list reads 1, 2, 3, 3, and no amount of merging fixes
 * it because both devices are reporting exactly what they were told. Repairing
 * it would need a merge rule for a value nobody typed — renumbering on every
 * insert, which under B3's per-block outbox is one queued operation per sibling
 * (the same reason `rank.ts` is a string and not an index).
 *
 * So the number is a function of the tree, derived wherever it is rendered.
 * Deleting a sibling on another device changes the answer on both devices with
 * no write at all.
 *
 * A run of numbered items is broken by any sibling that is not numbered — which
 * is what makes two lists separated by a paragraph two lists, rather than one
 * list that counts through the paragraph.
 */
import type { NoteTreeNode } from './noteTree.js';

/** Per depth, cycling: 1. / a. / i. — the same three most readers expect. */
export type OrderedMarkerStyle = 'decimal' | 'lower-alpha' | 'lower-roman';

const MARKER_CYCLE: readonly OrderedMarkerStyle[] = ['decimal', 'lower-alpha', 'lower-roman'];

/**
 * Every numbered block's ordinal, keyed by block id.
 *
 * A map rather than a decorated tree, so a caller that already holds a flat
 * render list can look each one up without rebuilding anything.
 */
export function numberedOrdinals(roots: readonly NoteTreeNode[]): Map<string, number> {
  const out = new Map<string, number>();

  const walk = (siblings: readonly NoteTreeNode[]): void => {
    let run = 0;
    for (const node of siblings) {
      if (node.block.kind.value === 'numbered') {
        run += 1;
        out.set(node.block.id, run);
      } else {
        // Any other kind ends the run. Two lists with a paragraph between them
        // are two lists; continuing the count through it is the bug people
        // notice immediately and cannot explain.
        run = 0;
      }
      walk(node.children);
    }
  };

  walk(roots);
  return out;
}

export function markerStyleForDepth(depth: number): OrderedMarkerStyle {
  const index = Math.max(0, Math.trunc(depth)) % MARKER_CYCLE.length;
  return MARKER_CYCLE[index]!;
}

/**
 * The label in front of a numbered item, e.g. `2.`, `b.`, `iii.`.
 *
 * Depth-dependent so a nested list is visibly nested even when the indentation
 * has saturated — the visual depth caps, the marker does not.
 */
export function orderedMarker(ordinal: number, depth: number): string {
  const n = Math.max(1, Math.trunc(ordinal));
  switch (markerStyleForDepth(depth)) {
    case 'lower-alpha': return `${toAlpha(n)}.`;
    case 'lower-roman': return `${toRoman(n)}.`;
    default: return `${n}.`;
  }
}

/** 1 → a, 26 → z, 27 → aa. Spreadsheet-column counting, which has no zero. */
function toAlpha(n: number): string {
  let value = n;
  let out = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(97 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

const ROMAN: readonly [number, string][] = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

/**
 * Roman numerals, capped.
 *
 * Past a few thousand the numeral is longer than the line it labels, and a list
 * that deep is a data-import accident rather than a document. The cap keeps the
 * label bounded instead of letting one pasted list widen every row.
 */
function toRoman(n: number): string {
  let value = Math.min(n, 3999);
  let out = '';
  for (const [amount, numeral] of ROMAN) {
    while (value >= amount) {
      out += numeral;
      value -= amount;
    }
  }
  return out || 'i';
}
