// ADR-039 §6 — the replay corpus: committed ground truth for judging the flow
// engine's *precision*, not just its recall.
//
// §6 ("How this will be judged") sets a concrete acceptance bar: replay the
// revisions that introduced each defect and confirm the engine reports the true
// vulnerabilities the model reviewer missed, and — critically — does NOT report
// the plausible-but-false findings that were investigated and proved safe. Those
// false positives exist in the ADR only as *counts and reasons* ("the five
// path-guard bypasses that proved unreachable", "the two ReDoS patterns whose
// character classes already excluded the delimiter"); they cannot be rebuilt from
// git later. This module captures that ground truth in a typed, testable form so
// it survives edits to the prose.
//
// Two supporting §6 criteria this corpus encodes directly:
//   1. The engine must report the true defects at the revision that introduced
//      them (recall).
//   2. "Fixed code stays fixed." Run against HEAD after each fix; the sink must
//      NOT re-report. §6 names `modelProbe.ts` as the canonical probe — if it
//      still reports there, the barrier model is missing or wrong.
//
// Every `mustReport` entry below is a real defect with a merged fix; the sink
// path and remediating PR are recorded so a replay run has an exact oracle. The
// `mustNotReport` entries are the plausible-but-false findings; their specific
// sink identity is pinned from the analyzer run (see `identification`), never
// invented here — a fabricated false-positive location would be worse than none,
// because it could suppress a real path.

/** The classes of defect the flow engine is judged on in this release. */
export type ReplayVulnClass = "ssrf" | "redos" | "credential-storage";

/**
 * A true defect the engine MUST report at the revision that introduced it, and
 * MUST NOT report at HEAD once the fix landed.
 */
export interface ReplayCorpusDefect {
  /** Stable slug, unique across the corpus. */
  id: string;
  klass: ReplayVulnClass;
  /** CWE identifier for the weakness class. */
  cwe: string;
  /**
   * The code-scanning rule that identifies this class in the analyzer's output
   * (the rule id carried on each SARIF result — see `mapCodeqlSarifToSourceToSinkPaths`).
   */
  ruleId: string;
  /**
   * The sink file, repository-relative. File granularity is deliberate: "fixed
   * code stays fixed" (§6) is asserted at the file that must not re-report, and
   * line numbers rot across the many commits between the introducing revision
   * and HEAD.
   */
  sink: string;
  /** Short description of the taint source — what untrusted value reaches the sink. */
  source: string;
  /**
   * The pull request after which the sink is guarded. The engine must report the
   * defect at its introducing revision and must NOT report it at HEAD (post-fix).
   */
  fixedBy: string;
  /**
   * §6 names `modelProbe.ts` as the canonical "fixed code stays fixed" probe:
   * "If it still reports `modelProbe.ts`, D4's barrier model is missing or wrong."
   */
  fixedStaysFixedCanonical?: boolean;
  note: string;
}

/** Why a plausible-looking finding is actually false (from ADR §6). */
export type ReplayFalsePositiveReason =
  /** A path-guard "bypass" the engine flags, but the bypass path proved unreachable. */
  | "guard-on-every-path-unreachable"
  /** A polynomial-ReDoS pattern whose character class already excludes the delimiter. */
  | "char-class-excludes-delimiter";

/**
 * A plausible-but-false finding the engine MUST NOT report. ADR §6 records these
 * only as counts and the reason they are false; the specific sink identity is
 * pinned from the analyzer run, so it is marked `pending-live-analysis` rather
 * than fabricated here.
 */
export interface ReplayCorpusFalsePositive {
  id: string;
  klass: Extract<ReplayVulnClass, "ssrf" | "redos">;
  ruleId: string;
  reason: ReplayFalsePositiveReason;
  /**
   * `pending-live-analysis` — the location comes from the scanner run against the
   * introducing revision, not from this file. Fabricating one would risk
   * suppressing a genuinely-unfixed path that happens to share a sink.
   */
  identification: "pending-live-analysis";
  note: string;
}

/**
 * The true defects the flow engine must catch — the findings the model reviewer
 * missed (ADR §1.1, §6). Four SSRFs and two ReDoS were confirmed and fixed under
 * the ADR-039 remediation; the credential-storage finding §6 also names was fixed
 * under ADR-037 (cross-referenced here so the replay bar is complete).
 */
export const ADR039_MUST_REPORT: readonly ReplayCorpusDefect[] = [
  {
    id: "ssrf-embeddings",
    klass: "ssrf",
    cwe: "CWE-918",
    ruleId: "js/request-forgery",
    sink: "brainrouter/src/memory/store/embedding.ts",
    source: "provider base URL from an org/admin request body reaching the embeddings fetch",
    fixedBy: "#1416",
    note: "Guarded by policyBoundFetch (validate-then-fetch through upstreamProbePolicy).",
  },
  {
    id: "ssrf-reranker",
    klass: "ssrf",
    cwe: "CWE-918",
    ruleId: "js/request-forgery",
    sink: "brainrouter/src/memory/store/reranker.ts",
    source: "provider base URL from an org/admin request body reaching the rerank fetch",
    fixedBy: "#1416",
    note: "Guarded by policyBoundFetch.",
  },
  {
    id: "ssrf-memory-gateway",
    klass: "ssrf",
    cwe: "CWE-918",
    ruleId: "js/request-forgery",
    sink: "brainrouter/src/services/modelGateway/modelGateway.ts",
    source: "memory-pipeline provider egress base URL reaching the gateway chat fetch",
    fixedBy: "#1416",
    note: "Guarded by policyBoundFetch on the gateway chat call.",
  },
  {
    id: "ssrf-modelprobe",
    klass: "ssrf",
    cwe: "CWE-918",
    ruleId: "js/request-forgery",
    sink: "brainrouter/src/providers/modelProbe.ts",
    source: "raw admin-supplied baseUrl reaching the LM Studio /models full read (guard on three paths of four)",
    fixedBy: "#1414",
    fixedStaysFixedCanonical: true,
    note: "Routed through fetchUpstreamWithPolicy (DNS-pinned upstream policy). §6's canonical fixed-stays-fixed sink. The D4 barrier model must recognize the guard on the SPECIFIC tainted path — the fix guarded three of four paths, and a barrier modeled at file granularity would suppress the fourth-path bug the engine must still catch. A barrier that does not dominate THIS flow is not a barrier for it (ADR-039 D4); see adr039BarrierPack.ts.",
  },
  {
    id: "redos-file-path-hint",
    klass: "redos",
    cwe: "CWE-1333",
    ruleId: "js/polynomial-redos",
    sink: "packages/core/src/memory/briefingTriggers.ts",
    source: "PR comment / briefing text driving the file-path-hint regex (~23s per PR comment)",
    fixedBy: "#1413",
    note: "Bounded alongside packages/core/src/memory/config/memory-type-config.ts.",
  },
  {
    id: "redos-review-prompt",
    klass: "redos",
    cwe: "CWE-1333",
    ruleId: "js/polynomial-redos",
    sink: "brainrouter-cli/src/cli/commands/reviewPrompt/index.ts",
    source: "diff/review text driving the polynomial regex the analyzer flagged on #1302",
    fixedBy: "#1308",
    note: "Polynomial-ReDoS class removed from the review-prompt builder.",
  },
  {
    id: "cred-localstorage",
    klass: "credential-storage",
    cwe: "CWE-522",
    ruleId: "js/clear-text-storage-of-sensitive-data",
    sink: "brainrouter-dashboard/lib/client-auth.ts",
    source: "session API key persisted to localStorage (a known sink with a known sensitivity class)",
    fixedBy: "#1406",
    note: "ADR-037 D-3: API key out of localStorage; auth gate off the cookie session. Enters review as a location-only finding (point sink, not a taint path).",
  },
];

/**
 * The plausible-but-false findings the flow engine must NOT report (ADR §6): five
 * path-guard "bypasses" that proved unreachable, and two ReDoS patterns whose
 * character classes already excluded the delimiter. The ADR records these only as
 * counts and reasons; the specific sinks are pinned from the analyzer run.
 */
export const ADR039_MUST_NOT_REPORT: readonly ReplayCorpusFalsePositive[] = [
  {
    id: "ssrf-fp-01",
    klass: "ssrf",
    ruleId: "js/request-forgery",
    reason: "guard-on-every-path-unreachable",
    identification: "pending-live-analysis",
    note: "Path-guard bypass the engine flags; the bypass path is unreachable in practice.",
  },
  {
    id: "ssrf-fp-02",
    klass: "ssrf",
    ruleId: "js/request-forgery",
    reason: "guard-on-every-path-unreachable",
    identification: "pending-live-analysis",
    note: "Path-guard bypass; unreachable.",
  },
  {
    id: "ssrf-fp-03",
    klass: "ssrf",
    ruleId: "js/request-forgery",
    reason: "guard-on-every-path-unreachable",
    identification: "pending-live-analysis",
    note: "Path-guard bypass; unreachable.",
  },
  {
    id: "ssrf-fp-04",
    klass: "ssrf",
    ruleId: "js/request-forgery",
    reason: "guard-on-every-path-unreachable",
    identification: "pending-live-analysis",
    note: "Path-guard bypass; unreachable.",
  },
  {
    id: "ssrf-fp-05",
    klass: "ssrf",
    ruleId: "js/request-forgery",
    reason: "guard-on-every-path-unreachable",
    identification: "pending-live-analysis",
    note: "Path-guard bypass; unreachable.",
  },
  {
    id: "redos-fp-01",
    klass: "redos",
    ruleId: "js/polynomial-redos",
    reason: "char-class-excludes-delimiter",
    identification: "pending-live-analysis",
    note: "Polynomial pattern whose character class already excludes the delimiter — no catastrophic backtracking.",
  },
  {
    id: "redos-fp-02",
    klass: "redos",
    ruleId: "js/polynomial-redos",
    reason: "char-class-excludes-delimiter",
    identification: "pending-live-analysis",
    note: "Polynomial pattern; character class excludes the delimiter.",
  },
];

/** Counts §6 asserts, exported so the acceptance test and callers share one source of truth. */
export const ADR039_CORPUS_EXPECTATIONS = {
  mustReport: { ssrf: 4, redos: 2, "credential-storage": 1 },
  mustNotReport: { guardedUnreachableSsrf: 5, charClassExcludedRedos: 2 },
} as const;
