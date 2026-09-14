// ADR-039 S2 — map CodeQL code-scanning SARIF into the review pipeline's
// source→sink evidence (AssuranceSourceToSinkPath).
//
// The taint PATHS live only in the raw SARIF from the analyses endpoint
// (GET /code-scanning/analyses/{id}, Accept: application/sarif+json) — NOT in the
// REST alerts list, which returns only the sink location. On this repository 112
// of 243 results carry codeFlows. This module is pure and host-neutral: the
// GitHub fetch + the impact-packet wiring layer on top of it in follow-up slices,
// so the mapping stays independently testable.

import type {
  AssuranceSourceLocation,
  AssuranceSourceToSinkPath,
} from "@kinqs/brainrouter-types/review";

// Minimal shapes of SARIF 2.1.0 we read. GitHub returns SARIF-spec camelCase from
// the analyses endpoint (the REST alerts API is snake_case — a different surface).
interface SarifRegion {
  startLine?: number;
  endLine?: number;
}
interface SarifPhysicalLocation {
  artifactLocation?: { uri?: string };
  region?: SarifRegion;
}
interface SarifLocationRef {
  physicalLocation?: SarifPhysicalLocation;
}
interface SarifThreadFlowLocation {
  location?: SarifLocationRef;
}
interface SarifThreadFlow {
  locations?: SarifThreadFlowLocation[];
}
interface SarifCodeFlow {
  threadFlows?: SarifThreadFlow[];
}
export interface CodeqlSarifResult {
  ruleId?: string;
  codeFlows?: SarifCodeFlow[];
}
export interface CodeqlSarifRun {
  results?: CodeqlSarifResult[];
}
export interface CodeqlSarif {
  runs?: CodeqlSarifRun[];
}

function toLocation(
  ref: SarifLocationRef | undefined,
): AssuranceSourceLocation | null {
  const uri = ref?.physicalLocation?.artifactLocation?.uri;
  if (!uri) return null;
  const region = ref?.physicalLocation?.region;
  return {
    path: uri,
    ...(typeof region?.startLine === "number" ? { line: region.startLine } : {}),
    ...(typeof region?.endLine === "number" ? { endLine: region.endLine } : {}),
  };
}

/**
 * Extract source→sink paths from CodeQL SARIF. One path per result whose primary
 * codeFlow has at least two thread-flow locations: source = the first location,
 * sink = the last. Results with no codeFlow (a plain point finding, not a taint
 * path) are skipped here — they enter the review pipeline as a location-only
 * finding, not as a source→sink edge.
 *
 * ADR-039 D6 (S4) — the ORDERED intermediate hops are now carried on `hops`
 * (source first, sink last), not discarded. A path is evidence of not just where
 * but HOW, and the D2 verifier needs each hop to name what an attacker traverses.
 */
export function mapCodeqlSarifToSourceToSinkPaths(
  sarif: CodeqlSarif,
): AssuranceSourceToSinkPath[] {
  const paths: AssuranceSourceToSinkPath[] = [];
  let seq = 0;
  for (const run of sarif.runs ?? []) {
    for (const result of run.results ?? []) {
      const locations = result.codeFlows?.[0]?.threadFlows?.[0]?.locations;
      if (!locations || locations.length < 2) continue;
      const hops = locations
        .map((loc) => toLocation(loc?.location))
        .filter((loc): loc is AssuranceSourceLocation => loc !== null);
      if (hops.length < 2) continue;
      const source = hops[0]!;
      const sink = hops[hops.length - 1]!;
      paths.push({
        id: `codeql:${result.ruleId ?? "rule"}:${seq++}`,
        mechanism: "data_flow",
        source,
        sink,
        hops,
        evidenceRefs: [],
      });
    }
  }
  return paths;
}
