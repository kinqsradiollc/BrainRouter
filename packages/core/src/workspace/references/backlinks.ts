/**
 * ADR-029 A2 — links are stored once, at the source, and backlinks are derived.
 *
 * The classic notes-app failure is storing a link on both ends: a note claims
 * it references a task, the task claims nothing, and one migration later the
 * surviving half is a lie. So the reference lives in the referring content and
 * "what links here" is a query.
 *
 * A2 then names the cost and the rule that keeps it honest: computing backlinks
 * needs an index, that index is a CACHE, and it must be rebuildable from
 * content alone — *if rebuilding it changes the answer, the index was the
 * source of truth and this decision was not implemented.*
 *
 * That rule is only testable if there is an incremental path that could
 * diverge, so this module provides both and the test drives them against each
 * other. An index with no incremental updates would satisfy A2 vacuously and
 * catch nothing the day someone adds one.
 *
 * **Scope.** Extraction and indexing operate on content the caller already
 * holds and is already entitled to. Backlinks computed over a corpus wider than
 * the viewer can see would answer "what links here" with the existence of notes
 * they cannot open — an A4 leak by aggregation. Filtering the corpus is the
 * caller's job because only the caller knows whose corpus it is.
 */
import { formatWorkspaceRef, parseWorkspaceRef, workspaceRefKey, type WorkspaceRef } from './ref.js';

/**
 * Candidate URIs in prose. Stops at whitespace and at the delimiters that
 * surround a link far more often than they appear inside one.
 */
const CANDIDATE = /brainrouter:\/\/[^\s<>"'`]+/gi;

/**
 * Trailing punctuation belongs to the sentence, not the URI.
 *
 * `…see brainrouter://planner/item/itm_4f2a.` and the markdown form
 * `[the task](brainrouter://planner/item/itm_4f2a)` both end in a character an
 * id may technically contain. Trimming is a deliberate trade: a reference whose
 * id genuinely ends in `)` loses that character, which is recoverable by
 * percent-encoding it, whereas not trimming makes every link written in prose
 * unresolvable, which is not recoverable at all.
 */
const TRAILING = new Set([...'.,;:!?)]}>\'"']);

/**
 * Scanned backwards rather than matched with `/[…]+$/`.
 *
 * That regex has no start anchor, so on a candidate ending in a long run of
 * punctuation the engine retries from every start position — quadratic in the
 * length of a string that arrives as note content, which is to say attacker
 * length. The scan is linear and says the same thing.
 */
function trimTrailingPunctuation(candidate: string): string {
  let end = candidate.length;
  while (end > 0 && TRAILING.has(candidate[end - 1]!)) end -= 1;
  return candidate.slice(0, end);
}

/** A piece of content that may contain references — a note block, a chat turn. */
export interface WorkspaceReferenceSource {
  /** The URI of the container itself. This is the `from` end of every edge it produces. */
  readonly from: WorkspaceRef;
  /** Its CURRENT content. The only input; A2 forbids a second stored edge. */
  readonly text: string;
}

export interface WorkspaceBacklink {
  /** What contains the reference. */
  readonly from: WorkspaceRef;
  /** How many times this source cites this target. */
  readonly count: number;
  /**
   * The positions cited, sorted. Kept on the edge rather than in the key,
   * so a target's backlinks are not split by line number while the specific
   * line a note pointed at is still recoverable.
   */
  readonly fragments: readonly string[];
}

/** One row of `snapshot()` — a stable, comparable projection of the whole index. */
export interface WorkspaceBacklinkRow {
  readonly target: string;
  readonly from: string;
  readonly count: number;
  readonly fragments: readonly string[];
}

/**
 * Every well-formed reference in a piece of text, in the order it appears.
 *
 * Malformed candidates are DROPPED rather than repaired. A half-parsed URI in
 * the index becomes a backlink to a target that does not exist, which is the
 * dangling-reference-with-no-tombstone case A3 rules out — and here it would be
 * a phantom the reader has no way to trace back to the typo that caused it.
 */
export function extractWorkspaceRefs(text: string): WorkspaceRef[] {
  const found: WorkspaceRef[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const parsed = parseWorkspaceRef(trimTrailingPunctuation(match[0]));
    if (parsed.ok) found.push(parsed.ref);
  }
  return found;
}

/**
 * The derived "what links here" cache.
 *
 * Mutable and incremental because the alternative — rebuilding the whole index
 * on every keystroke — is what makes people cache the answer somewhere else,
 * and the somewhere else is the second source of truth A2 forbids.
 */
export class WorkspaceBacklinkIndex {
  /** target key -> source key -> edge */
  readonly #edges = new Map<string, Map<string, WorkspaceBacklink>>();
  /** source key -> the targets it currently cites, so a re-edit can retract them. */
  readonly #bySource = new Map<string, Set<string>>();

  /** Build from content alone. This is the definition the incremental path must match. */
  static rebuild(sources: Iterable<WorkspaceReferenceSource>): WorkspaceBacklinkIndex {
    const index = new WorkspaceBacklinkIndex();
    for (const source of sources) index.apply(source);
    return index;
  }

  /**
   * Re-derive one source's edges from its current text.
   *
   * Retract-then-add, never add-only: a reference REMOVED from a block has to
   * disappear from the target's backlinks, and an index that only ever grows is
   * how "what links here" starts listing notes that stopped mentioning you.
   */
  apply(source: WorkspaceReferenceSource): void {
    const fromKey = formatWorkspaceRef(source.from);
    this.remove(source.from);

    const perTarget = new Map<string, { count: number; fragments: Set<string> }>();
    for (const ref of extractWorkspaceRefs(source.text)) {
      const targetKey = workspaceRefKey(ref);
      const entry = perTarget.get(targetKey) ?? { count: 0, fragments: new Set<string>() };
      entry.count += 1;
      if (ref.fragment) entry.fragments.add(ref.fragment);
      perTarget.set(targetKey, entry);
    }
    if (perTarget.size === 0) return;

    const targets = new Set<string>();
    for (const [targetKey, entry] of perTarget) {
      const edges = this.#edges.get(targetKey) ?? new Map<string, WorkspaceBacklink>();
      edges.set(fromKey, {
        from: source.from,
        count: entry.count,
        fragments: [...entry.fragments].sort(),
      });
      this.#edges.set(targetKey, edges);
      targets.add(targetKey);
    }
    this.#bySource.set(fromKey, targets);
  }

  /** Forget everything a source cited — the block was deleted, or emptied. */
  remove(from: WorkspaceRef): void {
    const fromKey = formatWorkspaceRef(from);
    const targets = this.#bySource.get(fromKey);
    if (!targets) return;
    for (const targetKey of targets) {
      const edges = this.#edges.get(targetKey);
      if (!edges) continue;
      edges.delete(fromKey);
      // An empty map left behind would make `targets()` report a target that
      // nothing links to, which reads as a bug in whatever renders it.
      if (edges.size === 0) this.#edges.delete(targetKey);
    }
    this.#bySource.delete(fromKey);
  }

  /**
   * What links here. Fragment-insensitive: a note citing `parser.ts#L59` is a
   * backlink of `parser.ts`, and the line it cited is on the edge.
   */
  backlinksTo(target: WorkspaceRef): readonly WorkspaceBacklink[] {
    const edges = this.#edges.get(workspaceRefKey(target));
    if (!edges) return [];
    return [...edges.values()].sort((a, b) => formatWorkspaceRef(a.from).localeCompare(formatWorkspaceRef(b.from)));
  }

  /** Every target anything currently links to. */
  targets(): string[] {
    return [...this.#edges.keys()].sort();
  }

  /**
   * A deterministic projection of the whole index.
   *
   * Ordering is imposed here rather than left to Map insertion order, because
   * the rebuild comparison would otherwise fail on the order edits happened to
   * arrive in — a difference that says nothing about whether the answer is the
   * same.
   */
  snapshot(): WorkspaceBacklinkRow[] {
    const rows: WorkspaceBacklinkRow[] = [];
    for (const [target, edges] of this.#edges) {
      for (const [from, edge] of edges) {
        rows.push({ target, from, count: edge.count, fragments: edge.fragments });
      }
    }
    return rows.sort((a, b) => a.target.localeCompare(b.target) || a.from.localeCompare(b.from));
  }
}
