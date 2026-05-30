import { describe, expect, it } from "vitest";
import { detectTaskIntent, getMemoryTypeConfig, TYPE_CONFIGS } from "../memory/memory-type-config.js";
import {
  capPriority,
  normalizePriority,
  blendBaseAndPriority,
  baseScoreFromRrf,
  effectivePriorityScore,
} from "../memory/reranker/index.js";

/**
 * 0.4.3 recall-ranking fixes (PR 3a — scoring signal):
 *   1. detectTaskIntent classifies security/vulnerability queries correctly.
 *   2. Generic long-lived types carry a recallPriorityCap so never-decaying
 *      boilerplate can't out-rank fresh, on-topic findings.
 */

describe("detectTaskIntent — security vocabulary + ordering", () => {
  it("classifies the exact reported query as security (was misclassified build)", () => {
    expect(detectTaskIntent("find all the vulnerabilities in our api")).toBe("security");
  });

  it("matches plurals + common security synonyms", () => {
    for (const q of [
      "any vulnerability here?",
      "look for sql injection",
      "leaked credentials in the logs",
      "is this endpoint vulnerable to xss",
      "csrf / ssrf / idor checks",
      "the api key was exposed",
      "auth bypass on the admin route",
      "check for cve advisories",
      "exploitable deserialization",
      "privilege escalation path",
    ]) {
      expect(detectTaskIntent(q), q).toBe("security");
    }
  });

  it("a 'security audit' beats the generic audit→review branch", () => {
    expect(detectTaskIntent("read-only security audit of the HTTP API")).toBe("security");
  });

  it("keeps debug first for active error-chasing, even when security-adjacent", () => {
    expect(detectTaskIntent("debug the auth crash with a stack trace")).toBe("debug");
  });

  it("does not regress the other intents", () => {
    expect(detectTaskIntent("write a vitest spec with coverage")).toBe("test");
    expect(detectTaskIntent("plan the next sprint milestone")).toBe("plan");
    expect(detectTaskIntent("refactor and rename this module")).toBe("refactor");
    expect(detectTaskIntent("optimize the latency bottleneck")).toBe("performance");
    expect(detectTaskIntent("ship the release changelog")).toBe("release");
    expect(detectTaskIntent("add a new feature to the dashboard")).toBe("build");
    expect(detectTaskIntent("code review for this pull request")).toBe("review");
  });
});

describe("recallPriorityCap — generic types can't dominate", () => {
  it("caps are set on the observed dominators and absent on task-specific types", () => {
    expect(TYPE_CONFIGS.instruction.recallPriorityCap).toBe(0.5);
    expect(TYPE_CONFIGS.architecture_decision.recallPriorityCap).toBe(0.5);
    expect(TYPE_CONFIGS.task_state.recallPriorityCap).toBe(0.6);
    expect(TYPE_CONFIGS.bug_finding.recallPriorityCap).toBeUndefined();
    expect(TYPE_CONFIGS.security_policy.recallPriorityCap).toBeUndefined();
  });

  it("capPriority clamps to the ceiling and is a no-op when undefined", () => {
    expect(capPriority(0.95, 0.5)).toBe(0.5);
    expect(capPriority(0.3, 0.5)).toBe(0.3);
    expect(capPriority(0.95, undefined)).toBe(0.95);
  });

  it("flips ranking: a capped instruction no longer out-scores a fresh bug_finding at equal RRF", () => {
    // Equal retrieval signal for both records.
    const rrf = 0.03;
    const base = baseScoreFromRrf(rrf);

    // High-priority, never-decaying instruction (the boilerplate).
    const instrPriorityRaw = normalizePriority(
      effectivePriorityScore({ priority: 85, ageDays: 10, halfLifeDays: TYPE_CONFIGS.instruction.halfLifeDays }),
    );
    // Fresh-ish, on-topic bug_finding.
    const bugPriority = normalizePriority(
      effectivePriorityScore({ priority: 70, ageDays: 10, halfLifeDays: TYPE_CONFIGS.bug_finding.halfLifeDays }),
    );

    // BEFORE the cap, the never-decaying instruction out-ranks the bug_finding.
    expect(instrPriorityRaw).toBeGreaterThan(bugPriority);
    const instrBefore = blendBaseAndPriority(base, instrPriorityRaw);
    const bugScore = blendBaseAndPriority(base, bugPriority);
    expect(instrBefore).toBeGreaterThan(bugScore);

    // AFTER the cap, the bug_finding wins the priority contribution.
    const instrCapped = capPriority(instrPriorityRaw, TYPE_CONFIGS.instruction.recallPriorityCap);
    const instrAfter = blendBaseAndPriority(base, instrCapped);
    expect(instrCapped).toBeLessThan(bugPriority);
    expect(instrAfter).toBeLessThan(bugScore);
  });

  it("getMemoryTypeConfig surfaces the cap for the scoring loop", () => {
    expect(getMemoryTypeConfig("instruction").recallPriorityCap).toBe(0.5);
    expect(getMemoryTypeConfig("bug_finding").recallPriorityCap).toBeUndefined();
  });
});
