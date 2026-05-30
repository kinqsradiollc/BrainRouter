import { describe, it, expect } from "vitest";
import { planGovernance } from "../memory/governance-plan.js";
import type { MemoryListItem } from "@kinqs/brainrouter-types";

const NOW = Date.parse("2026-05-30T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function item(p: Partial<MemoryListItem> & { recordId: string }): MemoryListItem {
  return {
    content: "x", type: "codebase_fact", priority: 0.5, sceneName: "", skillTag: "",
    createdTime: daysAgo(1), citationCount: 0, neverCitedCount: 0, archived: false,
    ...p,
  };
}

const ITEMS: MemoryListItem[] = [
  item({ recordId: "r1", type: "codebase_fact", createdTime: daysAgo(90), citationCount: 0, content: "aaaa" }),
  item({ recordId: "r2", type: "codebase_fact", createdTime: daysAgo(10), citationCount: 5, content: "bb" }),
  item({ recordId: "r3", type: "instruction", createdTime: daysAgo(120), citationCount: 0, content: "c" }),
];

describe("planGovernance (MEM-11)", () => {
  it("no filter → matches everything (dry-run preview of all active records)", () => {
    const r = planGovernance(ITEMS, {}, NOW);
    expect(r.matched).toBe(3);
    expect(r.byType).toEqual({ codebase_fact: 2, instruction: 1 });
    expect(r.estimatedChars).toBe(4 + 2 + 1);
  });

  it("type filter", () => {
    expect(planGovernance(ITEMS, { type: "instruction" }, NOW).matched).toBe(1);
  });

  it("uncitedOnly drops cited records", () => {
    const r = planGovernance(ITEMS, { uncitedOnly: true }, NOW);
    expect(r.sampleRecordIds.sort()).toEqual(["r1", "r3"]); // r2 (5 citations) excluded
  });

  it("olderThanDays keeps only records past the cutoff", () => {
    const r = planGovernance(ITEMS, { olderThanDays: 60 }, NOW);
    expect(r.sampleRecordIds.sort()).toEqual(["r1", "r3"]); // r2 (10d) excluded
  });

  it("filters compose (old AND uncited AND type)", () => {
    const r = planGovernance(ITEMS, { type: "codebase_fact", olderThanDays: 60, uncitedOnly: true }, NOW);
    expect(r.sampleRecordIds).toEqual(["r1"]);
    expect(r.matched).toBe(1);
  });

  it("sample is capped at 20 + echoes the filters", () => {
    const many = Array.from({ length: 30 }, (_, i) => item({ recordId: `m${i}`, createdTime: daysAgo(100) }));
    const r = planGovernance(many, { olderThanDays: 1 }, NOW);
    expect(r.matched).toBe(30);
    expect(r.sampleRecordIds.length).toBe(20);
    expect(r.filters).toEqual({ olderThanDays: 1 });
  });
});
