import { describe, expect, it } from "vitest";
import { buildSessionReflectPrompt, parseSessionReflectResponse, REFLECTION_CATEGORIES } from "./session-reflect.js";

describe("ADR-020 D3 — structured session reflection", () => {
  it("builds a prompt naming every category", () => {
    const { system, user } = buildSessionReflectPrompt("did a thing");
    for (const { key } of REFLECTION_CATEGORIES) expect(system).toContain(key);
    expect(user).toContain("did a thing");
  });

  it("parses typed elements from structured JSON (tolerating fences/prose)", () => {
    const raw = 'Here you go:\n```json\n{"mistakes":["Ran migration on prod without a backup"],"lessons":["Always snapshot first"],"preferences":["User prefers squash merges"],"reusableWorkflows":[],"decisions":["Chose SQLite for local-first"]}\n```';
    const out = parseSessionReflectResponse(raw);
    const byCat = Object.fromEntries(out.map((e) => [e.category, e.text]));
    expect(byCat.mistakes).toMatch(/without a backup/);
    expect(byCat.lessons).toMatch(/snapshot first/);
    expect(byCat.preferences).toMatch(/squash/);
    expect(byCat.decisions).toMatch(/SQLite/);
    // mistake carries the right kind/priority
    const mistake = out.find((e) => e.category === "mistakes")!;
    expect(mistake.kind).toBe("mistake");
    expect(mistake.priority).toBeGreaterThan(0);
  });

  it("returns [] for an all-empty (trivial-session) reflection", () => {
    expect(parseSessionReflectResponse('{"mistakes":[],"lessons":[],"antiPatterns":[]}')).toEqual([]);
  });

  it("drops trivially-short entries and dedupes within a category", () => {
    const out = parseSessionReflectResponse('{"lessons":["ok","Test before deploy","Test before deploy","x"]}');
    expect(out.filter((e) => e.category === "lessons").map((e) => e.text)).toEqual(["Test before deploy"]);
  });

  it("survives non-JSON garbage", () => {
    expect(parseSessionReflectResponse("the model refused")).toEqual([]);
  });
});
