import { describe, expect, it } from "vitest";
import { orgVisibilityAllows, applyFilters } from "./filters.js";

describe("ADR-010 P5 — orgVisibilityAllows (org isolation + visibility)", () => {
  const rec = (org: string | null, vis: string | null, user: string | null) => ({ org_id: org, visibility: vis, user_id: user });

  it("no caller org → no scoping (always allowed)", () => {
    expect(orgVisibilityAllows(rec("orgB", "private", "bob"), undefined, "alice")).toBe(true);
  });

  it("untagged (legacy) records surface everywhere (NULL-tolerant rollout)", () => {
    expect(orgVisibilityAllows(rec(null, null, "bob"), "orgA", "alice")).toBe(true);
  });

  it("hard cross-org isolation: a different org is always dropped", () => {
    expect(orgVisibilityAllows(rec("orgB", "org", "bob"), "orgA", "alice")).toBe(false);
    expect(orgVisibilityAllows(rec("orgB", "private", "alice"), "orgA", "alice")).toBe(false);
  });

  it("allows a membership-verified personal-team candidate across organizations", () => {
    expect(orgVisibilityAllows({ ...rec("orgB", "team", "bob"), team_access: true }, "orgA", "alice")).toBe(true);
    expect(orgVisibilityAllows({ ...rec("orgB", "team", "bob"), team_access: false }, "orgA", "alice")).toBe(false);
  });

  it("same org, the caller's own record → allowed regardless of visibility", () => {
    expect(orgVisibilityAllows(rec("orgA", "private", "alice"), "orgA", "alice")).toBe(true);
    expect(orgVisibilityAllows(rec("orgA", "org", "alice"), "orgA", "alice")).toBe(true);
  });

  it("same org, another member's PRIVATE record → dropped", () => {
    expect(orgVisibilityAllows(rec("orgA", "private", "bob"), "orgA", "alice")).toBe(false);
    expect(orgVisibilityAllows(rec("orgA", null, "bob"), "orgA", "alice")).toBe(false); // default private
  });

  it("same org, another member's ORG-SHARED record → visible", () => {
    expect(orgVisibilityAllows(rec("orgA", "org", "bob"), "orgA", "alice")).toBe(true);
  });

  it("without callerUserId, same-org records pass (retrieval is user-scoped anyway)", () => {
    expect(orgVisibilityAllows(rec("orgA", "private", "bob"), "orgA", undefined)).toBe(true);
  });
});

describe("ADR-017 D4 — applyFilters per-project restricted ACL (deniedProjectTags)", () => {
  const rec = (id: string, projectTag: string | null) =>
    ({ record_id: id, type: "note", project_tag: projectTag } as any);
  const denied = new Set(["pj_secret"]);

  it("drops a record whose project_tag is in the denied set", () => {
    expect(applyFilters([rec("r1", "pj_secret")], { deniedProjectTags: denied }).map((r) => r.record_id)).toEqual([]);
  });
  it("keeps a record with a different (allowed) project_tag", () => {
    expect(applyFilters([rec("r1", "pj_open")], { deniedProjectTags: denied }).map((r) => r.record_id)).toEqual(["r1"]);
  });
  it("keeps an untagged record (NULL-tolerant — never in a restricted Project)", () => {
    expect(applyFilters([rec("r1", null)], { deniedProjectTags: denied }).map((r) => r.record_id)).toEqual(["r1"]);
  });
  it("an empty/absent denied set applies no ACL filtering", () => {
    expect(applyFilters([rec("r1", "pj_secret")], {}).map((r) => r.record_id)).toEqual(["r1"]);
    expect(applyFilters([rec("r1", "pj_secret")], { deniedProjectTags: new Set() }).map((r) => r.record_id)).toEqual(["r1"]);
  });
  it("resolves the project_tag from the lookup map when the record has none inline", () => {
    const lookup = new Map<string, string | null>([["r1", "pj_secret"]]);
    const noInline = { record_id: "r1", type: "note" } as any;
    expect(applyFilters([noInline], { deniedProjectTags: denied }, undefined, lookup).map((r) => r.record_id)).toEqual([]);
  });
});
