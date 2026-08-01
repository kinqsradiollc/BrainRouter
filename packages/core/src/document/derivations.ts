/**
 * ADR-027 D4 (P8-2) — per-profile derivations over one shared substrate.
 *
 * D4: "A document is parsed, structured, and indexed ONCE; each profile derives
 * its own view on top… We do not re-extract per profile."
 *
 * The structural rule that makes that true, and which this module exists to
 * enforce: a derivation REFERENCES substrate chunks, it never carries its own
 * copy of the text. The moment a derivation embeds text, there are N copies of
 * a document that drift independently — and the drift is silent, because each
 * copy looks internally consistent. A research claim quoting a paragraph the
 * source no longer contains is not detectably wrong from inside the claim.
 *
 * So every derived item is (kind, chunk reference, derived content), and the
 * text is fetched from the substrate at read time. That also means fixing an
 * extraction bug fixes every profile at once, rather than fixing one and
 * leaving four stale.
 */

import type { DocumentChunk } from './chunking.js';

/** Workspace profiles that derive views. Mirrors the workspace manifest. */
export type DerivationProfile =
  | 'research' | 'study' | 'engineering' | 'data-science' | 'writing';

/** What a profile extracts. D4 names these per profile. */
export type DerivationKind =
  | 'claim'            // research: an assertion with evidence
  | 'citation'         // research: a reference to a source
  | 'concept'          // study: a node in a concept map
  | 'question'         // study: a practice question
  | 'spec'             // engineering: a stated requirement
  | 'api-contract'     // engineering: a signature or interface
  | 'table'            // data-science: structured tabular data
  | 'quotable';        // writing: a passage worth quoting

/** Which kinds each profile derives. The only place this mapping lives. */
export const PROFILE_DERIVATIONS: Record<DerivationProfile, readonly DerivationKind[]> = {
  research: ['claim', 'citation'],
  study: ['concept', 'question'],
  engineering: ['spec', 'api-contract'],
  'data-science': ['table'],
  writing: ['quotable'],
};

/**
 * One derived item.
 *
 * Note what is ABSENT: any copy of the source text. `chunkIndex` points into
 * the substrate, and `resolveText` fetches it. That absence is the design.
 */
export interface DerivedItem {
  kind: DerivationKind;
  /** Index of the substrate chunk this came from. */
  chunkIndex: number;
  /** The derived content — a claim, a question, a signature. NOT the source. */
  content: string;
  /** Optional confidence from the extractor. */
  confidence?: number;
}

export class DerivationError extends Error {
  constructor(message: string) { super(message); this.name = 'DerivationError'; }
}

/** Whether a profile is allowed to derive a kind. */
export function profileDerives(profile: DerivationProfile, kind: DerivationKind): boolean {
  return PROFILE_DERIVATIONS[profile].includes(kind);
}

/**
 * Validate derived items against the substrate and the profile.
 *
 * Two failures matter. An item pointing at a chunk that does not exist is a
 * citation into nothing — worse than no citation, because it renders as
 * verifiable. And an item of a kind the profile does not derive means the
 * mapping and the extractor disagree, which will surface later as a view that
 * is mysteriously empty or mysteriously full.
 */
export function derivationProblems(
  items: readonly DerivedItem[],
  chunks: readonly DocumentChunk[],
  profile: DerivationProfile,
): readonly string[] {
  const problems: string[] = [];
  const valid = new Set(chunks.map((chunk) => chunk.index));

  for (const [position, item] of items.entries()) {
    if (!valid.has(item.chunkIndex)) {
      problems.push(`Item ${position} (${item.kind}) references chunk ${item.chunkIndex}, which does not exist`);
    }
    if (!profileDerives(profile, item.kind)) {
      problems.push(`Item ${position} has kind "${item.kind}", which the ${profile} profile does not derive`);
    }
    if (!item.content.trim()) {
      problems.push(`Item ${position} (${item.kind}) has no content`);
    }
  }
  return problems;
}

export interface ResolvedItem extends DerivedItem {
  /** Source text, fetched from the substrate at read time — never stored. */
  sourceText: string;
  /** Breadcrumb of the originating chunk, for display. */
  breadcrumb: readonly string[];
}

/**
 * Resolve derived items against the substrate.
 *
 * Throws on a dangling reference rather than dropping it. A view that quietly
 * omits items is indistinguishable from one where the extractor found less —
 * and the two call for completely different responses.
 */
export function resolveDerivations(
  items: readonly DerivedItem[],
  chunks: readonly DocumentChunk[],
): readonly ResolvedItem[] {
  const byIndex = new Map(chunks.map((chunk) => [chunk.index, chunk]));
  return items.map((item) => {
    const chunk = byIndex.get(item.chunkIndex);
    if (!chunk) {
      throw new DerivationError(
        `Derived ${item.kind} references chunk ${item.chunkIndex}, which is not in this substrate`,
      );
    }
    return { ...item, sourceText: chunk.text, breadcrumb: chunk.breadcrumb };
  });
}

/**
 * Group one substrate's derivations into per-profile views.
 *
 * Items are filtered, never re-extracted: the same underlying parse serves
 * every profile, which is the whole claim in D4. Requesting a profile that
 * derived nothing yields an empty view rather than an error — a document with
 * no API contracts in it is a normal document.
 */
export function viewForProfile(
  items: readonly DerivedItem[],
  profile: DerivationProfile,
): readonly DerivedItem[] {
  const kinds = new Set(PROFILE_DERIVATIONS[profile]);
  return items.filter((item) => kinds.has(item.kind));
}

/**
 * Every profile whose view would be non-empty.
 *
 * Lets a UI offer only the views that exist, rather than presenting five tabs
 * where four are blank — which reads as broken rather than as inapplicable.
 */
export function availableProfiles(items: readonly DerivedItem[]): readonly DerivationProfile[] {
  const present = new Set(items.map((item) => item.kind));
  return (Object.keys(PROFILE_DERIVATIONS) as DerivationProfile[])
    .filter((profile) => PROFILE_DERIVATIONS[profile].some((kind) => present.has(kind)));
}
