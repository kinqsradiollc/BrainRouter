import { describe, it, expect } from "vitest";
import {
  extractJsonValue,
  extractJsonValueOrThrow,
  stripCodeFences,
  parseJsonWithEscapeRepair,
} from "../memory/util/llm-json.js";

describe("extractJsonValue — clean output", () => {
  it("returns a top-level array as-is", () => {
    expect(extractJsonValue('[{"a":1}]', { kind: "array" })).toEqual([{ a: 1 }]);
  });
  it("returns a top-level object as-is", () => {
    expect(extractJsonValue('{"entities":[]}', { kind: "object" })).toEqual({ entities: [] });
  });
  it("returns an empty array (genuine 'nothing notable')", () => {
    expect(extractJsonValue("[]", { kind: "array" })).toEqual([]);
  });
  it("kind:array extracts the inner array from a tool-call wrapper object", () => {
    // Forced tool-calls must wrap the array (function params must be an object),
    // e.g. {"scenes":[…]}. The balanced-span scan already returns the inner
    // array, so tool-wrapped output parses with no special handling.
    expect(extractJsonValue('{"scenes":[{"scene_name":"X","memories":[]}]}', { kind: "array" }))
      .toEqual([{ scene_name: "X", memories: [] }]);
    expect(extractJsonValue('{"records":[1,2,3]}', { kind: "array" })).toEqual([1, 2, 3]);
  });
  it("strips ```json code fences", () => {
    const raw = "```json\n[{\"scene_name\":\"X\",\"memories\":[]}]\n```";
    expect(extractJsonValue(raw, { kind: "array" })).toEqual([{ scene_name: "X", memories: [] }]);
  });
  it("strips a bare ``` fence with no language tag", () => {
    expect(extractJsonValue("```\n{\"shift\":true}\n```", { kind: "object" })).toEqual({ shift: true });
  });
});

describe("extractJsonValue — the reported bug: leaked role tokens", () => {
  it("ignores a leading [user role] and returns the real array", () => {
    const raw = '[user role] here is the result:\n[{"scene_name":"Auth","memories":[{"content":"x"}]}]';
    expect(extractJsonValue(raw, { kind: "array" })).toEqual([
      { scene_name: "Auth", memories: [{ content: "x" }] },
    ]);
  });
  it("ignores interleaved [assistant role] noise around the JSON", () => {
    const raw = '[assistant role]\nSure! [{"a":1},{"b":2}] [end]';
    expect(extractJsonValue(raw, { kind: "array" })).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it("a bare greedy-regex would have failed on this exact input", () => {
    // Reproduces "Unexpected token 'u', \"[user role]\"...": the greedy
    // /\[[\s\S]*\]/ matches from `[user role]` to the last `]`.
    const raw = '[user role] [{"ok":true}]';
    const greedy = raw.match(/\[[\s\S]*\]/)![0];
    expect(() => JSON.parse(greedy)).toThrow(); // old behavior: throws
    expect(extractJsonValue(raw, { kind: "array" })).toEqual([{ ok: true }]); // new: recovers
  });
});

describe("extractJsonValue — prose, reasoning, and largest-span selection", () => {
  it("extracts JSON embedded in surrounding prose", () => {
    const raw = 'Here is the JSON you asked for: {"isContradiction":true,"confidence":0.9}. Hope it helps!';
    expect(extractJsonValue(raw, { kind: "object" })).toEqual({ isContradiction: true, confidence: 0.9 });
  });
  it("prefers the real payload over a small reasoning array", () => {
    const raw = 'Let me think: the indices are [1,2,3]. Final answer:\n[{"scene_name":"S","memories":[]}]';
    expect(extractJsonValue(raw, { kind: "array" })).toEqual([{ scene_name: "S", memories: [] }]);
  });
  it("returns the outer object (largest span) for kind object", () => {
    const raw = '{"verdicts":[{"index":0,"relevant":true}]}';
    expect(extractJsonValue(raw, { kind: "object" })).toEqual({ verdicts: [{ index: 0, relevant: true }] });
  });
});

describe("extractJsonValue — malformation repair", () => {
  it("tolerates trailing commas", () => {
    expect(extractJsonValue('[{"a":1,},{"b":2},]', { kind: "array" })).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it("tolerates unescaped backslashes in Windows paths", () => {
    const raw = '[{"content":"see C:\\Users\\me\\file.ts"}]';
    const out = extractJsonValue(raw, { kind: "array" }) as any[];
    expect(out[0].content).toContain("Users");
  });
});

describe("extractJsonValue — kind filtering & misses", () => {
  it("kind 'array' ignores a top-level object", () => {
    expect(extractJsonValue('{"a":1}', { kind: "array" })).toBeNull();
  });
  it("kind 'object' ignores a top-level array", () => {
    expect(extractJsonValue("[1,2,3]", { kind: "object" })).toBeNull();
  });
  it("kind 'any' returns whichever parses", () => {
    expect(extractJsonValue("[1,2]", { kind: "any" })).toEqual([1, 2]);
    expect(extractJsonValue('{"a":1}', { kind: "any" })).toEqual({ a: 1 });
  });
  it("returns null on pure prose / empty / whitespace", () => {
    expect(extractJsonValue("I could not find anything relevant.", { kind: "array" })).toBeNull();
    expect(extractJsonValue("", { kind: "any" })).toBeNull();
    expect(extractJsonValue("   \n  ", { kind: "any" })).toBeNull();
    expect(extractJsonValue(null as any, { kind: "any" })).toBeNull();
  });
  it("does not mistake an unterminated bracket for JSON", () => {
    expect(extractJsonValue("[user role] just text, no json here", { kind: "array" })).toBeNull();
  });
});

describe("extractJsonValueOrThrow", () => {
  it("returns the value when present", () => {
    expect(extractJsonValueOrThrow('[{"a":1}]', { kind: "array" })).toEqual([{ a: 1 }]);
  });
  it("throws with a labeled, truncated preview when absent", () => {
    expect(() => extractJsonValueOrThrow("nope, no json", { kind: "object", label: "Judge" }))
      .toThrow(/Judge contained no parseable JSON object: nope/);
  });
});

describe("stripCodeFences", () => {
  it("removes a fenced block and trims", () => {
    expect(stripCodeFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });
  it("is a no-op when there is no fence", () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe("parseJsonWithEscapeRepair (still exported for reuse)", () => {
  it("parses clean JSON", () => {
    expect(parseJsonWithEscapeRepair('{"a":1}')).toEqual({ a: 1 });
  });
  it("repairs trailing commas + bad escapes", () => {
    expect(parseJsonWithEscapeRepair('{"p":"a\\b\\c","x":1,}')).toEqual({ p: "a\\b\\c", x: 1 });
  });
});
