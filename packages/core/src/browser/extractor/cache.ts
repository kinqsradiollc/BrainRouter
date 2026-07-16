/**
 * Incremental extraction cache — a per-file content hash so unchanged files cost
 * nothing on re-extraction (guiding principle: "incremental everything"). Pure:
 * the host persists the returned state to `.brainrouter/ui-tests/.extract-cache.json`
 * and feeds it back on the next run.
 */
import { createHash } from 'node:crypto';
import type { SourceFile } from './extract.js';

/** path → sha1(content). */
export type CacheState = Record<string, string>;

export interface FileDiff {
  /** Files whose hash changed (or are new) — must be re-walked. */
  changed: SourceFile[];
  /** Paths present in the cache but absent from the current file set. */
  removedPaths: string[];
  /** Paths whose hash is unchanged — skipped. */
  unchangedPaths: string[];
}

export function hashContent(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Partition the current files against a prior cache into changed/unchanged/removed. */
export function diffFiles(prev: CacheState, files: SourceFile[]): FileDiff {
  const changed: SourceFile[] = [];
  const unchangedPaths: string[] = [];
  const present = new Set<string>();
  for (const f of files) {
    present.add(f.path);
    if (prev[f.path] === hashContent(f.text)) unchangedPaths.push(f.path);
    else changed.push(f);
  }
  const removedPaths = Object.keys(prev).filter((p) => !present.has(p));
  return { changed, removedPaths, unchangedPaths };
}

/** Produce the next cache: keep unchanged, update changed, drop removed. */
export function updateCache(prev: CacheState, files: SourceFile[], removedPaths: string[] = []): CacheState {
  const next: CacheState = { ...prev };
  for (const p of removedPaths) delete next[p];
  for (const f of files) next[f.path] = hashContent(f.text);
  return next;
}
