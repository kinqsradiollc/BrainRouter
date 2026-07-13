/**
 * Layer 6 — the results normalizer. Every raw backend reply is validated through
 * `UiCommandResultSchema` so a malformed/partial driver result becomes a typed
 * error (AC5: never surfaced raw). The artifact classifier is the same logic as
 * brainrouter-cli's browserVerify, copied here so this package never depends on
 * the CLI.
 */
import type { Artifacts, UiCommandResult } from '../types.js';
import { UiCommandResultSchema } from '../schema.js';

const SCREENSHOT_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const VIDEO_EXT = new Set(['webm', 'mp4', 'mov']);
const LOG_EXT = new Set(['log', 'txt', 'json', 'har', 'ndjson', 'jsonl']);

function ext(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function emptyArtifacts(): Artifacts {
  return { screenshots: [], videos: [], logs: [], other: [] };
}

/** Bucket a flat list of produced files by artifact kind (copied from browserVerify). */
export function classifyArtifacts(files: string[]): Artifacts {
  const out = emptyArtifacts();
  for (const f of files) {
    const e = ext(f);
    if (SCREENSHOT_EXT.has(e)) out.screenshots.push(f);
    else if (VIDEO_EXT.has(e)) out.videos.push(f);
    else if (LOG_EXT.has(e)) out.logs.push(f);
    else out.other.push(f);
  }
  return out;
}

export interface NormalizeFallback {
  command: string;
  testID?: string;
  screen?: string;
  durationMs?: number;
}

/** Validate a raw backend reply into a `UiCommandResult`, or a typed error. */
export function normalizeResult(raw: unknown, fallback: NormalizeFallback): UiCommandResult {
  const parsed = UiCommandResultSchema.safeParse(raw);
  if (parsed.success) {
    return { ...parsed.data, artifacts: parsed.data.artifacts ?? emptyArtifacts() };
  }
  const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return {
    ok: false,
    status: 'error',
    command: fallback.command,
    testID: fallback.testID,
    screen: fallback.screen,
    durationMs: fallback.durationMs ?? 0,
    error: `malformed driver result — ${detail}`,
    artifacts: emptyArtifacts(),
  };
}

/** A synthetic error result for failures that never reach the backend. */
export function errorResult(command: string, error: string, extra: NormalizeFallback = { command }): UiCommandResult {
  return {
    ok: false,
    status: 'error',
    command,
    testID: extra.testID,
    screen: extra.screen,
    durationMs: 0,
    error,
    artifacts: emptyArtifacts(),
  };
}
