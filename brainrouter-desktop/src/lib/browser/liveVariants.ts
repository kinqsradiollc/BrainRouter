/**
 * Live variants (ADR-056 D-B5) — the desktop model.
 *
 * Pure helpers the Browser panel and its drawer share: which wrapper the
 * cycler drives, how cycling wraps, and how a wrapper reads to a person. The
 * agent brief and the descriptor/scan normalisers live in core
 * (`@kinqs/brainrouter-core/design`); this is the renderer-side glue with no
 * React and no I/O, so it can be unit-tested on its own.
 */
import type { LiveVariantScanEntry } from '@kinqs/brainrouter-core/design/live';

export type { LiveVariantTarget, LiveVariantScanEntry } from '@kinqs/brainrouter-core/design/live';

/** The three states the Live Variants drawer moves through. */
export type LiveVariantMode = 'pick' | 'form' | 'cycle';

/** One element in the pick list — the fields the drawer shows and needs to describe it. */
export interface VariantPickRow {
  ref: string;
  label: string;
  tag: string;
  role: string;
}

/** Next child index when cycling `delta` from `active`, wrapping both ways. */
export function stepVariantIndex(active: number, count: number, delta: -1 | 1): number {
  if (count <= 0) return 0;
  const n = ((active + delta) % count + count) % count;
  return n;
}

/**
 * The wrapper the cycler should drive: the one whose id was just created when
 * we know it, otherwise the last (newest) on the page. Null when the page has
 * no live variants.
 */
export function activeWrapper(scan: LiveVariantScanEntry[], preferredId: string | null): LiveVariantScanEntry | null {
  if (!scan.length) return null;
  if (preferredId) {
    const hit = scan.find((w) => w.id === preferredId);
    if (hit) return hit;
  }
  return scan[scan.length - 1];
}

/** "original" for index 0, else "variant k of N" — the original is not one of the N alternatives. */
export function cyclerLabel(entry: LiveVariantScanEntry): string {
  const which = entry.active <= 0 ? 'original' : `variant ${entry.active} of ${Math.max(1, entry.count - 1)}`;
  return entry.action && entry.action !== 'variant' ? `${which} · ${entry.action}` : which;
}

/** The reason the generate form is not ready to submit, or '' when it is. An empty action is allowed (it defaults). */
export function variantFormError(count: number): string {
  if (!Number.isInteger(count) || count < 1 || count > 6) return 'Choose between 1 and 6 variants.';
  return '';
}

/** "3 variants" / "1 variant" — the button's noun. */
export function describeVariantCount(count: number): string {
  return `${count} ${count === 1 ? 'variant' : 'variants'}`;
}
