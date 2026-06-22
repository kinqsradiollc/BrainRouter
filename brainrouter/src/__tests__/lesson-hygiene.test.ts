import { describe, expect, it } from "vitest";
import {
  deriveConflictKey,
  lessonsConflict,
  isLessonStale,
  normalizeSupersedes,
  normalizeLessonText,
  DEFAULT_STALENESS,
} from "../memory/lessons/lessonHygiene.js";

describe("LESSON-HYGIENE deriveConflictKey", () => {
  it("strips leading stance words so polarity flips collide on the subject", () => {
    expect(deriveConflictKey("Always use pnpm")).toBe("pnpm");
    expect(deriveConflictKey("Never use pnpm")).toBe("pnpm");
    expect(deriveConflictKey("Prefer pnpm")).toBe("pnpm");
  });

  it("keeps distinct subjects distinct (no semantic guessing)", () => {
    expect(deriveConflictKey("use npm")).toBe("npm");
    expect(deriveConflictKey("use pnpm")).toBe("pnpm");
    expect(deriveConflictKey("use npm")).not.toBe(deriveConflictKey("use pnpm"));
  });

  it("normalizes punctuation, emphasis and whitespace", () => {
    expect(deriveConflictKey("  Always   use **pnpm**. ")).toBe("pnpm");
  });
});

describe("LESSON-HYGIENE lessonsConflict", () => {
  it("flags same-subject opposite-stance lessons", () => {
    expect(lessonsConflict("Always use pnpm", "Never use pnpm")).toBe(true);
  });

  it("does NOT flag identical lessons (that path is reinforcement)", () => {
    expect(lessonsConflict("Always use pnpm", "always use pnpm")).toBe(false);
  });

  it("does NOT flag different subjects", () => {
    expect(lessonsConflict("use npm", "use pnpm")).toBe(false);
    expect(lessonsConflict("run tests before push", "use pnpm")).toBe(false);
  });

  it("ignores empty / whitespace keys", () => {
    expect(lessonsConflict("always", "never")).toBe(false);
  });
});

describe("LESSON-HYGIENE isLessonStale", () => {
  const now = Date.parse("2026-05-31T00:00:00.000Z");
  const old = "2025-01-01T00:00:00.000Z"; // ~515 days before `now`
  const recent = "2026-05-20T00:00:00.000Z";

  it("flags old + low-confidence + uncorroborated lessons", () => {
    expect(isLessonStale({ lastCitedAt: old, confidence: 0.3, citationCount: 1 }, now)).toBe(true);
  });

  it("keeps trusted lessons regardless of age", () => {
    expect(isLessonStale({ lastCitedAt: old, confidence: 0.9, citationCount: 1 }, now)).toBe(false);
  });

  it("keeps corroborated lessons regardless of age", () => {
    expect(isLessonStale({ lastCitedAt: old, confidence: 0.2, citationCount: 5 }, now)).toBe(false);
  });

  it("keeps recently-cited lessons", () => {
    expect(isLessonStale({ lastCitedAt: recent, confidence: 0.2, citationCount: 0 }, now)).toBe(false);
  });

  it("falls back to createdTime when never cited; keeps unknown-age lessons", () => {
    expect(isLessonStale({ lastCitedAt: null, createdTime: old, confidence: 0.2, citationCount: 0 }, now)).toBe(true);
    expect(isLessonStale({ lastCitedAt: null, createdTime: null, confidence: 0.2, citationCount: 0 }, now)).toBe(false);
  });

  it("honors custom thresholds", () => {
    // A 1-day window makes even the "recent" record stale.
    expect(isLessonStale({ lastCitedAt: recent, confidence: 0.2, citationCount: 0 }, now, { ...DEFAULT_STALENESS, staleAfterDays: 1 })).toBe(true);
  });
});

describe("LESSON-HYGIENE normalizeSupersedes", () => {
  it("coerces string | string[] | undefined to a clean unique id list", () => {
    expect(normalizeSupersedes(undefined)).toEqual([]);
    expect(normalizeSupersedes("r1")).toEqual(["r1"]);
    expect(normalizeSupersedes([" r1 ", "r2", "r1", ""])).toEqual(["r1", "r2"]);
  });
});

describe("LESSON-HYGIENE normalizeLessonText", () => {
  it("is stable under case, emphasis, trailing punctuation and spacing", () => {
    expect(normalizeLessonText("  Run  TESTS before push!! ")).toBe("run tests before push");
  });
});
