/**
 * ADR-033 D4 — a finding's position is COMPUTED, never taken from the model.
 *
 * A correct finding on the wrong line is a false positive to the person
 * reading it: they look, see nothing there, and trust the next one less. So the
 * line a finding is published on is derived from evidence — the verbatim
 * excerpt the reviewer quoted, matched uniquely against exact new-revision file
 * content when available and otherwise against the diff's visible new-side
 * lines. The model's remembered line number never participates in the decision:
 * an excerpt with more than one valid location is deliberately summary-only.
 *
 * When nothing can be established, the position degrades to FILE ONLY: the line
 * is removed so the finding renders in the summary instead of anchoring an
 * inline comment somewhere it does not belong. Precision is the target (D6);
 * an unplaceable finding is not worth a wrong anchor.
 *
 * Pure. Diff-only remains the safe fallback for a surface with no checkout;
 * exact/local source is injected by front doors that have a bounded reader.
 */
import type { ParsedReviewFinding } from './reviewFindings.js';
import { normalizeReviewPath, splitUnifiedDiffFiles } from './reviewBundles.js';

/** One new-revision line the diff shows, with the text it holds. */
export interface DiffLine {
  line: number;
  text: string;
  added: boolean;
}

export type FindingPositionKind =
  /** The quoted excerpt was found at exactly one place — the strongest signal. */
  | 'excerpt_match'
  /** @deprecated Retained for API compatibility; evidence-only positioning never emits it. */
  | 'model_line_confirmed'
  /** The excerpt matched somewhere OTHER than the line the model claimed. */
  | 'excerpt_relocated'
  /** The file is known; no line could be established, so none is published. */
  | 'file_only'
  /** The path itself does not appear in the diff. */
  | 'path_unknown';

export interface ComputedFindingPosition {
  path: string | null;
  line?: number;
  endLine?: number;
  kind: FindingPositionKind;
}

/**
 * New-revision line numbering for every line the diff shows, per path —
 * added lines and context lines both, because a finding often quotes the
 * unchanged line its argument turns on.
 */
export function buildDiffLineIndex(diff: string): Map<string, DiffLine[]> {
  const index = new Map<string, DiffLine[]>();
  for (const file of splitUnifiedDiffFiles(diff)) {
    if (!file.path) continue;
    const lines: DiffLine[] = [];
    let newLine = 0;
    let inHunk = false;
    for (const raw of file.diff.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        newLine = Number(hunk[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      // Nothing else is skipped here, and the `+++`/`---` file headers are the
      // reason to say so: they only ever precede the first `@@`, so `!inHunk`
      // has already dropped them. INSIDE a hunk, `+++ x` is an added line whose
      // content is `++ x`, and skipping it would leave every following line
      // number one short — the exact drift this module exists to prevent.
      if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
      if (raw.startsWith('+')) {
        lines.push({ line: newLine, text: raw.slice(1), added: true });
        newLine += 1;
      } else if (raw.startsWith('-')) {
        // old side only — the new-file counter does not advance
      } else {
        lines.push({ line: newLine, text: raw.startsWith(' ') ? raw.slice(1) : raw, added: false });
        newLine += 1;
      }
    }
    const existing = index.get(file.path);
    index.set(file.path, existing ? [...existing, ...lines] : lines);
  }
  return index;
}

/**
 * Drop a unified-diff marker from a quoted line, then trim what is left.
 *
 * The trim after the marker is the load-bearing part. Consuming the marker and
 * ONE space (`/^[+-]\s?/`) leaves the code's own indentation attached, and every
 * comparison downstream is against `entry.text.trim()` — so a `+`-prefixed
 * excerpt of anything indented two spaces or more never matched, the finding
 * degraded to `file_only`, and it lost the line. `diffHunk` is documented as
 * carrying `-`/`+` lines, so marker-plus-indented-code is its ordinary shape:
 * the miss was the common case, not the corner.
 */
function stripDiffMarker(line: string): string {
  return line.replace(/^[+-]/, '').trim();
}

/** The first line of a quoted excerpt with real content, trimmed. */
function excerptLines(value: string | undefined): string[] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== '```');
}

/**
 * Resolve the path a finding names against the paths the diff actually
 * contains. Exact match first; then a unique suffix match, which is what
 * catches a model that answered with `packages/core/src/x.ts` when the diff
 * says `src/x.ts` (or the reverse). Ambiguity resolves to nothing — guessing a
 * file is worse than reporting the finding without an anchor.
 */
export function resolveFindingPath(
  candidate: string,
  index: ReadonlyMap<string, DiffLine[]>,
): string | null {
  const normalized = normalizeReviewPath(candidate);
  if (!normalized) return null;
  if (index.has(normalized)) return normalized;
  const suffixMatches = [...index.keys()].filter(
    (path) => path.endsWith(`/${normalized}`) || normalized.endsWith(`/${path}`),
  );
  return suffixMatches.length === 1 ? suffixMatches[0] : null;
}

/**
 * Compute where one finding belongs. A line comes only from a unique excerpt
 * match in exact new-revision source, or from the visible diff fallback; the
 * model's claimed line is never accepted unchecked.
 */
export function computeFindingPosition(
  finding: ParsedReviewFinding,
  index: ReadonlyMap<string, DiffLine[]>,
  exactSource?: string,
): ComputedFindingPosition {
  const path = resolveFindingPath(finding.file, index);
  if (!path) return { path: null, kind: 'path_unknown' };
  const lines = index.get(path) ?? [];
  const claimed = typeof finding.line === 'number' && Number.isFinite(finding.line)
    ? Math.trunc(finding.line)
    : undefined;

  const quoted = excerptLines(finding.codeExcerpt ?? finding.diffHunk);
  if (quoted.length > 0) {
    const evidenceLines = exactSource === undefined
      ? lines
      : exactSource.split('\n').map((text, offset) => ({
          line: offset + 1,
          text,
          added: false,
        }));
    const candidates = excerptMatches(evidenceLines, quoted);
    if (candidates.length === 1) {
      const chosen = candidates[0];
      return {
        path,
        line: chosen.line,
        ...(quoted.length > 1 ? { endLine: chosen.line + quoted.length - 1 } : {}),
        kind: claimed === chosen.line || claimed === undefined ? 'excerpt_match' : 'excerpt_relocated',
      };
    }
  }

  return { path, kind: 'file_only' };
}

/** Every location where the complete quoted run occurs in the new revision. */
function excerptMatches(lines: readonly DiffLine[], quoted: readonly string[]): DiffLine[] {
  const byLine = new Map(lines.map((entry) => [entry.line, entry.text.trim()]));
  const first = stripDiffMarker(quoted[0]);
  return lines.filter((entry) => {
    if (entry.text.trim() !== first) return false;
    return quoted.every(
      (value, offset) => byLine.get(entry.line + offset) === stripDiffMarker(value),
    );
  });
}

export interface PositionedReviewFinding {
  finding: ParsedReviewFinding;
  position: ComputedFindingPosition;
}

/**
 * Apply computed positions to a set of findings.
 *
 * `file_only` and `path_unknown` findings keep their text and lose their line,
 * which is what makes them summary-only downstream (`resolveInlineAnchor`
 * returns null without a line). Nothing is dropped here — deletion is the
 * reflection pass's decision (D5), not the positioner's.
 */
export function positionReviewFindings(
  findings: readonly ParsedReviewFinding[],
  diff: string,
  exactSources: ReadonlyMap<string, string> = new Map(),
): PositionedReviewFinding[] {
  const index = buildDiffLineIndex(diff);
  return findings.map((finding) => {
    const resolvedPath = resolveFindingPath(finding.file, index);
    const position = computeFindingPosition(
      finding,
      index,
      resolvedPath ? exactSources.get(resolvedPath) : undefined,
    );
    const positioned: ParsedReviewFinding = {
      ...finding,
      ...(position.path ? { file: position.path } : {}),
    };
    if (position.line === undefined) {
      delete positioned.line;
      delete positioned.endLine;
    } else {
      positioned.line = position.line;
      if (position.endLine === undefined) delete positioned.endLine;
      else positioned.endLine = position.endLine;
    }
    // A replacement is only applicable to the exact range it was written for.
    // Once the range moved, applying it in one click would corrupt the file.
    if (position.kind === 'excerpt_relocated' && positioned.replacement && finding.line !== position.line) {
      delete positioned.replacement;
    }
    return { finding: positioned, position };
  });
}
