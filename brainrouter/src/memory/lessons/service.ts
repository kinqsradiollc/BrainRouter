/**
 * Lessons service (ADR-008, Wave 2) — an engine-bound port over the lessons
 * store (record / conflict-find / stale-sweep). Binds the MemoryEngine at
 * construction. Additive and behaviour-preserving: every method delegates to the
 * existing lessonOps functions; no logic moved or removed.
 */
import type { CognitiveRecord } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { recordLesson, findLessonConflicts, sweepStaleLessons } from "./lessonOps.js";

/** Options accepted by {@link ILessonsService.record} — the module's exact shape. */
export type RecordLessonOptions = Parameters<typeof recordLesson>[3];
/** Result of {@link ILessonsService.record}. */
export type RecordLessonResult = ReturnType<typeof recordLesson>;
/** Options accepted by {@link ILessonsService.sweepStale}. */
export type SweepStaleOptions = Parameters<typeof sweepStaleLessons>[2];
/** Result of {@link ILessonsService.sweepStale}. */
export type SweepStaleResult = ReturnType<typeof sweepStaleLessons>;

/** The lessons store contract, bound to one engine. */
export interface ILessonsService {
  record(userId: string, text: string, opts?: RecordLessonOptions): RecordLessonResult;
  findConflicts(userId: string, text: string): Promise<CognitiveRecord[]>;
  sweepStale(userId: string, opts?: SweepStaleOptions): SweepStaleResult;
}

/** {@link ILessonsService} backed by the in-process lesson ops — delegates only. */
export class LessonsService implements ILessonsService {
  constructor(private readonly engine: MemoryEngine) {}
  record(userId: string, text: string, opts?: RecordLessonOptions): RecordLessonResult {
    return recordLesson(this.engine, userId, text, opts);
  }
  findConflicts(userId: string, text: string): Promise<CognitiveRecord[]> {
    return findLessonConflicts(this.engine, userId, text);
  }
  sweepStale(userId: string, opts?: SweepStaleOptions): SweepStaleResult {
    return sweepStaleLessons(this.engine, userId, opts);
  }
}

/** Construct a lessons service bound to an engine. */
export function createLessonsService(engine: MemoryEngine): ILessonsService {
  return new LessonsService(engine);
}
