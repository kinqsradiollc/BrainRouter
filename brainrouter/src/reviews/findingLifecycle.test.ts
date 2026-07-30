import { describe, expect, it } from "vitest";
import {
  findingFingerprint,
  reconcileFindingLifecycle,
  type LifecycleCurrentFinding,
  type LifecycleFindingInput,
} from "./findingLifecycle.js";

const finding = (overrides: Partial<LifecycleFindingInput> = {}): LifecycleFindingInput => ({
  file: "src/render.ts",
  line: 12,
  severity: "high",
  title: "[CWE-79] Unsanitized user input reaches the HTML response",
  cwe: "CWE-79",
  ...overrides,
});

const current = (overrides: Partial<LifecycleCurrentFinding> = {}): LifecycleCurrentFinding => {
  const source = finding();
  return {
    id: "finding-1",
    fingerprint: findingFingerprint("security", source),
    file: source.file,
    title: source.title,
    cwe: source.cwe,
    status: "open",
    ...overrides,
  };
};

describe("review finding lifecycle", () => {
  it("uses a deterministic fingerprint that ignores volatile line movement", () => {
    expect(findingFingerprint("security", finding({ line: 12 }))).toBe(
      findingFingerprint("security", finding({ line: 98 })),
    );
    expect(findingFingerprint("security", finding())).not.toBe(
      findingFingerprint("code", finding()),
    );
  });

  it("discovers a new durable finding", () => {
    const result = reconcileFindingLifecycle({ lens: "security", previous: [], incoming: [finding()], complete: true });
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toMatchObject({ type: "discovered", findingId: null, finding: { file: "src/render.ts", line: 12 } });
  });

  it("observes the same finding on the next commit without duplicating it", () => {
    const result = reconcileFindingLifecycle({ lens: "security", previous: [current()], incoming: [finding({ line: 48 })], complete: true });
    expect(result.transitions).toEqual([
      expect.objectContaining({ type: "observed", findingId: "finding-1", finding: expect.objectContaining({ line: 48 }) }),
    ]);
  });

  it("matches a conservative same-file and same-CWE paraphrase", () => {
    const result = reconcileFindingLifecycle({
      lens: "security",
      previous: [current()],
      incoming: [finding({ title: "User input reaches the HTML response without sanitization", line: 55 })],
      complete: true,
    });
    expect(result.transitions.map((transition) => transition.type)).toEqual(["observed"]);
    expect(result.transitions[0]?.findingId).toBe("finding-1");
  });

  it("marks an absent open finding fixed after the next complete review", () => {
    const result = reconcileFindingLifecycle({ lens: "security", previous: [current()], incoming: [], complete: true });
    expect(result.transitions).toEqual([
      expect.objectContaining({ type: "fixed", findingId: "finding-1" }),
    ]);
  });

  it("never auto-fixes from a failed, skipped, capped, or otherwise partial review", () => {
    const result = reconcileFindingLifecycle({ lens: "security", previous: [current()], incoming: [], complete: false });
    expect(result.transitions).toEqual([]);
  });

  it("reopens a fixed finding when it is verified again later", () => {
    const result = reconcileFindingLifecycle({
      lens: "security",
      previous: [current({ status: "fixed" })],
      incoming: [finding({ line: 72 })],
      complete: true,
    });
    expect(result.transitions).toEqual([
      expect.objectContaining({ type: "reopened", findingId: "finding-1" }),
    ]);
  });

  it("does not overwrite an explicit ignored triage state", () => {
    const result = reconcileFindingLifecycle({
      lens: "security",
      previous: [current({ status: "ignored" })],
      incoming: [],
      complete: true,
    });
    expect(result.transitions).toEqual([]);
  });

  it("keeps two distinct findings in one file separate", () => {
    const other = current({
      id: "finding-2",
      fingerprint: findingFingerprint("security", finding({ title: "[CWE-89] SQL query interpolates an untrusted id", cwe: "CWE-89" })),
      title: "[CWE-89] SQL query interpolates an untrusted id",
      cwe: "CWE-89",
    });
    const result = reconcileFindingLifecycle({
      lens: "security",
      previous: [current(), other],
      incoming: [finding({ title: "SQL query interpolates an untrusted id", cwe: "CWE-89", line: 80 })],
      complete: true,
    });
    expect(result.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "observed", findingId: "finding-2" }),
      expect.objectContaining({ type: "fixed", findingId: "finding-1" }),
    ]));
  });
});
