import { describe, expect, it, vi } from "vitest";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { recordLesson, sweepStaleLessons } from "./lessonOps.js";

function lesson(id: string, metadata: Record<string, unknown> = {}): CognitiveRecord {
  return {
    id,
    userId: "user-a",
    sessionKey: "session-a",
    content: `lesson ${id}`,
    type: "lesson",
    confidence: 0.2,
    citationCount: 0,
    lastCitedAt: null,
    createdTime: "2020-01-01T00:00:00.000Z",
    metadata,
  } as CognitiveRecord;
}

function recordLessonHarness(prior: CognitiveRecord) {
  const created = { ...lesson("rec-new"), confidence: 0.65 };
  const store = {
    findLessonByFingerprint: vi.fn(async () => null),
    getMemoryById: vi.fn(async () => prior),
    invalidateCognitiveRecord: vi.fn(async () => undefined),
  };
  const engine = {
    store,
    upsertEngineeringMemory: vi.fn(async () => created),
  } as unknown as MemoryEngine;
  return { engine, store };
}

describe("lesson supersede learned authority", () => {
  it("does not let memory_record_lesson supersede a learned projection", async () => {
    const { engine, store } = recordLessonHarness(lesson("rec-learned", { learned: null }));

    const result = await recordLesson(engine, "user-a", "Use the new deployment flow", {
      supersedes: "rec-learned",
    });

    expect(result.supersededIds).toEqual([]);
    expect(store.invalidateCognitiveRecord).not.toHaveBeenCalled();
  });

  it("retains ordinary lesson supersede behavior", async () => {
    const prior = lesson("rec-old");
    const { engine, store } = recordLessonHarness(prior);

    const result = await recordLesson(engine, "user-a", "Use the new deployment flow", {
      supersedes: prior.id,
    });

    expect(store.invalidateCognitiveRecord).toHaveBeenCalledWith("user-a", "rec-old", "rec-new");
    expect(result.supersededIds).toEqual(["rec-old"]);
  });
});

describe("stale lesson hygiene learned authority", () => {
  it("filters learned projections while still archiving ordinary stale lessons", async () => {
    const ordinary = lesson("rec-normal");
    const learned = lesson("rec-learned", { learned: { schemaVersion: 1 } });
    const store = {
      listLessonsForHygiene: vi.fn(async () => [learned, ordinary]),
      updateCognitiveConfidence: vi.fn(async () => undefined),
    };
    const engine = { store } as unknown as MemoryEngine;

    const result = await sweepStaleLessons(engine, "user-a", {
      apply: true,
      nowMs: Date.parse("2030-01-01T00:00:00.000Z"),
    });

    expect(result.candidates.map((entry) => entry.recordId)).toEqual(["rec-normal"]);
    expect(result.archived).toBe(1);
    expect(store.updateCognitiveConfidence).toHaveBeenCalledWith("user-a", "rec-normal", 0.2, "archived");
    expect(store.updateCognitiveConfidence).not.toHaveBeenCalledWith("user-a", "rec-learned", expect.anything(), expect.anything());
  });
});
