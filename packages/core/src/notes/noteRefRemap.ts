/**
 * ADR-029 F3/A3 — rewriting the references that point INSIDE a copied subtree.
 *
 * Its own module rather than a helper inside `templates.ts` because three
 * callers need the identical answer and none of them may reach the store: the
 * template instantiation and the duplicate (which do), the browser dev harness
 * (which has no store at all), and the dashboard later. A second copy of this
 * rule is a copy that keeps rewriting after the first one stops — and the
 * symptom is a page whose links point at the template it came from, which is
 * precisely the quietly-wrong document A3 argues against.
 *
 * **Linear by construction.** This runs over every character of every block in a
 * template, on text somebody else may have written, and this repository has
 * already closed a `js/polynomial-redos` alert. One bounded quantifier over one
 * character class, no nesting, no adjacent unbounded repetition.
 */
import { NOTES_MODE, NOTE_BLOCK_KIND } from './block.js';

/** A1's spelling for a note block, in one place so the rewrite cannot drift. */
export const NOTE_BLOCK_REF_PREFIX = `brainrouter://${NOTES_MODE}/${NOTE_BLOCK_KIND}/`;

/**
 * The id class is deliberately narrower than the URI grammar's.
 *
 * A block id is `blk_<base36>_<device>` and nothing else, so restricting the
 * class stops the match swallowing the `)` of a markdown link — which would make
 * the rewrite eat the closing bracket of every reference it touched.
 */
const NOTE_BLOCK_REF = new RegExp(`${NOTE_BLOCK_REF_PREFIX}([A-Za-z0-9_-]{1,256})`, 'gi');

/**
 * Point the copied text at the copies.
 *
 * A reference whose id is NOT in the map is left exactly as it was: it addresses
 * something real outside the copy, and A3 makes a reference live rather than a
 * snapshot — rewriting or dropping it would be inventing an intention nobody
 * had.
 *
 * Returns the input unchanged when nothing matched, which is the common case: a
 * template of prose has no internal links and pays one scan for it.
 */
export function remapNoteRefs(text: string, idMap: ReadonlyMap<string, string>): string {
  if (idMap.size === 0 || text.length === 0) return text;
  NOTE_BLOCK_REF.lastIndex = 0;
  return text.replace(NOTE_BLOCK_REF, (whole, id: string) => {
    const copy = idMap.get(id);
    return copy ? whole.slice(0, whole.length - id.length) + copy : whole;
  });
}
