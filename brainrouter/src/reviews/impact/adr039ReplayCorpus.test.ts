import { describe, it, expect } from "vitest";
import {
  ADR039_MUST_REPORT,
  ADR039_MUST_NOT_REPORT,
  ADR039_CORPUS_EXPECTATIONS,
  type ReplayCorpusDefect,
} from "./adr039ReplayCorpus.js";
import {
  mapCodeqlSarifToSourceToSinkPaths,
  type CodeqlSarif,
} from "./codeqlSarifMapping.js";
import { isSafeRepositoryRelativePath } from "../repositoryContextAssurance.js";

// A minimal SARIF codeFlow whose source is line 1 and sink is the defect's file —
// the shape the analyzer emits and the mapper consumes.
const sarifForDefect = (defect: ReplayCorpusDefect): CodeqlSarif => ({
  runs: [
    {
      results: [
        {
          ruleId: defect.ruleId,
          codeFlows: [
            {
              threadFlows: [
                {
                  locations: [
                    { location: { physicalLocation: { artifactLocation: { uri: defect.sink }, region: { startLine: 1 } } } },
                    { location: { physicalLocation: { artifactLocation: { uri: defect.sink }, region: { startLine: 42 } } } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe("ADR-039 §6 replay corpus", () => {
  it("records the true defects at the counts §6 judges (4 SSRF + 2 ReDoS + 1 credential-storage)", () => {
    const byClass = (klass: string) => ADR039_MUST_REPORT.filter((d) => d.klass === klass);
    expect(byClass("ssrf")).toHaveLength(ADR039_CORPUS_EXPECTATIONS.mustReport.ssrf);
    expect(byClass("redos")).toHaveLength(ADR039_CORPUS_EXPECTATIONS.mustReport.redos);
    expect(byClass("credential-storage")).toHaveLength(
      ADR039_CORPUS_EXPECTATIONS.mustReport["credential-storage"],
    );
  });

  it("records the plausible-but-false findings at the counts §6 judges (5 guarded-unreachable + 2 delimiter-excluded)", () => {
    const ssrfFp = ADR039_MUST_NOT_REPORT.filter(
      (f) => f.klass === "ssrf" && f.reason === "guard-on-every-path-unreachable",
    );
    const redosFp = ADR039_MUST_NOT_REPORT.filter(
      (f) => f.klass === "redos" && f.reason === "char-class-excludes-delimiter",
    );
    expect(ssrfFp).toHaveLength(ADR039_CORPUS_EXPECTATIONS.mustNotReport.guardedUnreachableSsrf);
    expect(redosFp).toHaveLength(ADR039_CORPUS_EXPECTATIONS.mustNotReport.charClassExcludedRedos);
  });

  it("never fabricates a false-positive location — each is pinned from the live analysis", () => {
    // A fabricated sink could suppress a genuinely-unfixed path sharing that sink,
    // so the corpus deliberately carries no location for the false positives.
    for (const fp of ADR039_MUST_NOT_REPORT) {
      expect(fp.identification).toBe("pending-live-analysis");
    }
  });

  it("gives every entry a unique id", () => {
    const ids = [
      ...ADR039_MUST_REPORT.map((d) => d.id),
      ...ADR039_MUST_NOT_REPORT.map((f) => f.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every must-report sink is a safe repository-relative path (passes the review seam's filter)", () => {
    // normalizeDeterministicCandidates drops any path failing this check, so a sink
    // that fails here would silently never become a candidate.
    for (const defect of ADR039_MUST_REPORT) {
      expect(isSafeRepositoryRelativePath(defect.sink), defect.id).toBe(true);
    }
  });

  it("names modelProbe.ts as §6's canonical fixed-stays-fixed sink", () => {
    const canonical = ADR039_MUST_REPORT.filter((d) => d.fixedStaysFixedCanonical);
    expect(canonical).toHaveLength(1);
    expect(canonical[0].sink).toBe("brainrouter/src/providers/modelProbe.ts");
  });

  it("recall oracle: the real mapper turns each taint defect's SARIF into a source→sink path at its sink", () => {
    // Recall half of §6: replayed at the introducing revision, the analyzer's output
    // for each known taint defect must become a source→sink edge in the pipeline.
    // The credential-storage finding is a point sink (no codeFlow) and is excluded.
    const taintDefects = ADR039_MUST_REPORT.filter((d) => d.klass !== "credential-storage");
    expect(taintDefects.length).toBeGreaterThanOrEqual(6);
    for (const defect of taintDefects) {
      const paths = mapCodeqlSarifToSourceToSinkPaths(sarifForDefect(defect));
      expect(paths, defect.id).toHaveLength(1);
      expect(paths[0].sink.path, defect.id).toBe(defect.sink);
      expect(paths[0].mechanism, defect.id).toBe("data_flow");
      expect(paths[0].id, defect.id).toContain(defect.ruleId);
    }
  });
});
