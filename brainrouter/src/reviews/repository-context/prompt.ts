/**
 * Bounded model-facing serialization of exact-revision impact artifacts.
 *
 * Artifacts arrive already redacted by the packet adapter. This module adds a
 * coverage header and enforces one aggregate UTF-8 byte ceiling before source
 * context can enter a model request.
 */

import type {
  AssuranceCoverageLimitation,
  AssuranceImpactPacketAssembly,
  AssuranceSourceLocation,
} from "@kinqs/brainrouter-types/review";
import { ASSURANCE_IMPACT_RELATIONSHIPS } from "@kinqs/brainrouter-types/review";
import { splitUnifiedDiffFiles } from "@kinqs/brainrouter-core/review";
import type {
  RepositoryContextArtifact,
  RepositoryContextPrompt,
} from "./contracts.js";
import { isSafeOpaqueArtifactRef, isSafeRepositoryRelativePath } from "./contracts.js";
import { coverageLimitation } from "./coverage.js";

export interface RepositoryContextPromptResult {
  prompt: RepositoryContextPrompt | null;
  limitation?: AssuranceCoverageLimitation;
}

export type RepositoryContextForPaths = (
  paths: readonly string[],
  diffEvidence?: string,
  /**
   * ADR-033 D2 — the packet budget for THIS unit.
   *
   * Omitted means "the provider's own default", which is the whole-review
   * budget and the right answer for a single-unit review. The caller that
   * splits a review into units is the only one that knows how many there are,
   * so it is the only one that can divide the budget between them.
   */
  maxBytes?: number,
) => string;

function diffVisibleSourceLines(diffEvidence: string): Map<string, Map<number, string>> {
  const visibleByPath = new Map<string, Map<number, string>>();
  for (const file of splitUnifiedDiffFiles(diffEvidence)) {
    if (!isSafeRepositoryRelativePath(file.path)) continue;
    const visible = visibleByPath.get(file.path) ?? new Map<number, string>();
    visibleByPath.set(file.path, visible);
    let newLine = 0;
    let inHunk = false;
    for (const line of file.diff.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith("-")) continue;
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+") || line.startsWith(" ")) {
        visible.set(newLine, line.slice(1));
        newLine += 1;
      }
    }
  }
  return visibleByPath;
}

/**
 * Remove source bytes that are already present verbatim in this bundle's diff.
 * Matching requires the same safe path, new-revision line, and source text;
 * unmatched unchanged evidence remains in the exact-revision packet.
 */
function omitDiffVisibleSourceLines(repositoryContext: string, diffEvidence: string): string {
  if (!repositoryContext || !diffEvidence) return repositoryContext;
  const visibleByPath = diffVisibleSourceLines(diffEvidence);
  if (visibleByPath.size === 0) return repositoryContext;
  let sourcePath: string | null = null;
  let omissionRecorded = false;
  const output: string[] = [];
  for (const line of repositoryContext.split("\n")) {
    if (line.startsWith("--- ")) {
      sourcePath = null;
      omissionRecorded = false;
    } else if (line.startsWith("# ")) {
      const candidate = line.slice(2).trim();
      sourcePath = isSafeRepositoryRelativePath(candidate) ? candidate : null;
    }
    const numbered = /^\s*(\d+)\s+\| (.*)$/.exec(line);
    if (
      sourcePath
      && numbered
      && visibleByPath.get(sourcePath)?.get(Number(numbered[1])) === numbered[2]
    ) {
      if (!omissionRecorded) output.push("[diff-visible source lines omitted]");
      omissionRecorded = true;
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}

/**
 * Resolve one repository-context block per semantic review unit.
 *
 * The full prompt remains the compatibility fallback for callers that cannot
 * project packet evidence. A real projector is memoized by its normalized path
 * set and bundle diff so an evidence-request second round does not rebuild the
 * same packet selection. An empty-path fallback bundle receives the full packet
 * before exact source lines already present in its diff are removed.
 */
export function createBundleRepositoryContextResolver(input: {
  fullText: string;
  contextForPaths?: RepositoryContextForPaths;
  /**
   * ADR-033 D2 — the repository-context budget for the WHOLE review, divided
   * across its units.
   *
   * Without this the cap is per unit, so a review's evidence budget grows with
   * how many units it happens to split into: two units whose impact packets
   * share dependencies materialise that shared context twice, and a split
   * review costs strictly more than the same review unsplit. Measured on our
   * own corpus that single effect was the entire cost regression — two cases
   * that split 1 call into 2 accounted for 33,028 of a 33,537-character excess,
   * while every case that split into genuinely unrelated units got CHEAPER.
   *
   * Dividing a fixed budget keeps per-unit scoping — which is what D2 buys —
   * without letting isolation quietly become an evidence multiplier. Absent,
   * behaviour is exactly as before.
   */
  reviewMaxBytes?: number;
  /** How many units share `reviewMaxBytes`. Defaults to 1. */
  unitCount?: number;
}): RepositoryContextForPaths {
  const cache = new Map<string, string>();
  const units = Math.max(1, Math.trunc(input.unitCount ?? 1));
  // A floor, because a review that splits into many units must not starve each
  // of them into uselessness: below this a packet stops being evidence and
  // becomes a fragment that costs tokens and answers nothing.
  const perUnitMaxBytes = input.reviewMaxBytes !== undefined
    ? Math.max(MIN_UNIT_CONTEXT_BYTES, Math.trunc(input.reviewMaxBytes / units))
    : undefined;
  return (paths, diffEvidence = "", maxBytes) => {
    const selected = [...new Set(paths.map((path) => String(path).trim()).filter(Boolean))].sort();
    const budget = maxBytes ?? perUnitMaxBytes;
    const key = `${selected.join("\0")}\0${budget ?? "default"}\0${diffEvidence}`;
    if (cache.has(key)) return cache.get(key)!;
    const projected = !input.contextForPaths || selected.length === 0
      ? input.fullText
      : String(input.contextForPaths(selected, undefined, budget) ?? "");
    const minimized = omitDiffVisibleSourceLines(projected, diffEvidence);
    cache.set(key, minimized);
    return minimized;
  };
}

/** Smallest packet still worth sending to one unit. */
export const MIN_UNIT_CONTEXT_BYTES = 8 * 1_024;

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  let bounded = bytes.subarray(0, end).toString("utf8");
  while (end > 0 && Buffer.byteLength(bounded) > maxBytes) {
    end -= 1;
    bounded = bytes.subarray(0, end).toString("utf8");
  }
  return { value: bounded, truncated: true };
}

/**
 * Keep repository source readable while preventing it from forging the inner
 * exact-context envelope or the review executor's outer evidence envelope.
 * The system message remains the authority boundary; this only preserves
 * deterministic delimiter integrity.
 */
function escapeReservedContextDelimiters(value: string): string {
  return value.replace(
    /<(?=\s*\/?\s*(?:brainrouter-exact-repository-context|untrusted_repository_context_evidence))/gi,
    "\\u003c",
  );
}

function modelVisibleLimitationCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
    ? value
    : "UNRECOGNIZED_LIMITATION";
}

const NUMBERED_SOURCE_LINE = /^\s*(\d+)\s+\|/;
const IMPACT_ROLES = new Set<string>(ASSURANCE_IMPACT_RELATIONSHIPS);

function locationKey(location: AssuranceSourceLocation): string {
  return [
    location.path,
    location.line ?? 0,
    location.endLine ?? 0,
    location.symbol ?? "",
  ].join("\0");
}

function artifactAnchorsByRef(assembly: AssuranceImpactPacketAssembly): Map<string, Set<string>> {
  const anchorsByRef = new Map<string, Set<string>>();
  for (const packet of assembly.packets) {
    const anchors = packet.changed.map(locationKey);
    for (const ref of packet.artifactRefs) {
      const expected = anchorsByRef.get(ref) ?? new Set<string>();
      for (const anchor of anchors) expected.add(anchor);
      anchorsByRef.set(ref, expected);
    }
  }
  return anchorsByRef;
}

function validateArtifactProvenance(
  artifact: RepositoryContextArtifact,
  revisionSha: string,
  expectedAnchors: ReadonlySet<string>,
): void {
  if (artifact.revisionSha !== revisionSha) {
    throw new Error("Impact artifact revision does not match the exact repository context.");
  }
  const source = artifact.sourceLocation;
  if (
    !isSafeRepositoryRelativePath(source.path)
    || !Number.isInteger(source.line)
    || source.line! < 1
    || !Number.isInteger(source.endLine)
    || source.endLine! < source.line!
  ) {
    throw new Error("Impact artifact contains invalid source provenance.");
  }
  if (
    artifact.anchorLocations.length === 0
    || artifact.anchorLocations.some((location) =>
      !isSafeRepositoryRelativePath(location.path) || !expectedAnchors.has(locationKey(location)))
  ) {
    throw new Error("Impact artifact contains invalid anchor provenance.");
  }
  if (artifact.roles.length === 0 || artifact.roles.some((role) => !IMPACT_ROLES.has(role))) {
    throw new Error("Impact artifact contains invalid relationship provenance.");
  }
}

function rangesByPath(locations: readonly AssuranceSourceLocation[]): Map<string, AssuranceSourceLocation[]> {
  const ranges = new Map<string, AssuranceSourceLocation[]>();
  for (const location of locations) {
    if (!location.line) continue;
    ranges.set(location.path, [...(ranges.get(location.path) ?? []), location]);
  }
  return ranges;
}

function lineIsVisibleInDiff(line: number, ranges: readonly AssuranceSourceLocation[]): boolean {
  return ranges.some((range) => line >= range.line! && line <= (range.endLine ?? range.line!));
}

function projectArtifactContent(input: {
  artifact: RepositoryContextArtifact;
  diffVisibleRanges: readonly AssuranceSourceLocation[];
  seenSourceLines: Set<number>;
}): string | null {
  const lines = input.artifact.content.split("\n");
  const numbered = lines.filter((line) => NUMBERED_SOURCE_LINE.test(line));
  if (numbered.length === 0) return input.artifact.content;

  let omittedDiffLines = 0;
  let retainedSourceLines = 0;
  const projected = lines.filter((line) => {
    const match = NUMBERED_SOURCE_LINE.exec(line);
    if (!match) return true;
    const lineNumber = Number(match[1]);
    if (lineIsVisibleInDiff(lineNumber, input.diffVisibleRanges)) {
      omittedDiffLines += 1;
      return false;
    }
    if (input.seenSourceLines.has(lineNumber)) return false;
    input.seenSourceLines.add(lineNumber);
    retainedSourceLines += 1;
    return true;
  });
  if (retainedSourceLines === 0) return null;
  if (omittedDiffLines > 0) projected.splice(1, 0, "[diff-visible changed lines omitted]");
  return projected.join("\n");
}

export function buildRepositoryContextPrompt(input: {
  assembly: AssuranceImpactPacketAssembly;
  limitations: AssuranceCoverageLimitation[];
  resolveArtifact(ref: string): RepositoryContextArtifact | null;
  maxBytes: number;
  /** Select packets anchored to these changed paths; absent means all packets. */
  changedPaths?: readonly string[];
}): RepositoryContextPromptResult {
  const allArtifactRefs = input.assembly.packets.flatMap((packet) => packet.artifactRefs);
  if (allArtifactRefs.some((ref) => !isSafeOpaqueArtifactRef(ref))) {
    throw new Error("Impact packet assembly contains an invalid opaque artifact reference.");
  }
  const selectedPaths = input.changedPaths === undefined
    ? null
    : new Set(input.changedPaths.map((path) => String(path).trim()).filter(Boolean));
  const packets = selectedPaths === null
    ? input.assembly.packets
    : input.assembly.packets.filter((packet) =>
        packet.changed.some((location) => selectedPaths.has(location.path)),
      );
  const expectedAnchors = artifactAnchorsByRef(input.assembly);
  const allChangedPaths = new Set(input.assembly.packets.flatMap((packet) =>
    packet.changed.map((location) => location.path)));
  const diffVisibleRanges = rangesByPath(
    selectedPaths === null
      ? []
      : input.assembly.packets.flatMap((packet) =>
          packet.changed.filter((location) => selectedPaths.has(location.path))),
  );
  const artifactRefs = [...new Set(packets.flatMap((packet) => packet.artifactRefs))];
  const seenSourceLines = new Map<string, Set<number>>();
  const seenOpaqueContent = new Set<string>();
  const artifacts: Array<{ artifact: RepositoryContextArtifact; content: string }> = [];
  for (const ref of artifactRefs) {
    const artifact = input.resolveArtifact(ref);
    if (!artifact) continue;
    validateArtifactProvenance(artifact, input.assembly.revisionSha, expectedAnchors.get(ref) ?? new Set());
    const sourcePath = artifact.sourceLocation.path;
    if (selectedPaths && allChangedPaths.has(sourcePath) && !selectedPaths.has(sourcePath)) continue;
    const sourceLines = seenSourceLines.get(sourcePath) ?? new Set<number>();
    seenSourceLines.set(sourcePath, sourceLines);
    const content = projectArtifactContent({
      artifact,
      diffVisibleRanges: diffVisibleRanges.get(sourcePath) ?? [],
      seenSourceLines: sourceLines,
    });
    if (!content) continue;
    const opaqueKey = `${artifact.revisionSha}\0${sourcePath}\0${content}`;
    if (seenOpaqueContent.has(opaqueKey)) continue;
    seenOpaqueContent.add(opaqueKey);
    artifacts.push({ artifact, content });
  }
  if (!artifacts.length) return { prompt: null };
  const header = [
    "<brainrouter-exact-repository-context>",
    `Exact revision: ${input.assembly.revisionSha}`,
    `Packets: ${packets.length}`,
    `Coverage limitations: ${input.limitations.length
      ? input.limitations.map((item) => modelVisibleLimitationCode(item.reasonCode)).join(", ")
      : "none"}`,
    "The following source snippets are bounded, selected from deterministic caller/callee/configuration/test relationships, and secret-redacted.",
    "",
  ].join("\n");
  const body = artifacts
    .map(({ artifact, content }) =>
      `--- ${escapeReservedContextDelimiters(artifact.ref)} ---\n${escapeReservedContextDelimiters(content)}`)
    .join("\n\n");
  const bounded = truncateUtf8(
    `${header}${body}\n</brainrouter-exact-repository-context>`,
    input.maxBytes,
  );
  return {
    prompt: {
      text: bounded.value,
      packetRefs: packets.map((packet) => packet.id),
      artifactRefs: artifacts.map(({ artifact }) => artifact.ref),
    },
    ...(bounded.truncated
      ? {
          limitation: coverageLimitation(
            "repository-context-model-byte-limit",
            "model-context",
            "partial",
            "MODEL_CONTEXT_BYTE_LIMIT",
            "The model-facing repository context reached its configured byte limit.",
          ),
        }
      : {}),
  };
}
