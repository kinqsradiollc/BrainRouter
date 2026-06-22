import { randomUUID } from 'node:crypto';
import { getRawCliKnobs } from '../config/config.js';
import type { TelemetryEvent } from './contracts.js';
import type { TelemetrySink } from './telemetryPort.js';
import { createFileTelemetrySink } from './fileTelemetryAdapter.js';

/**
 * Telemetry service — the only surface callsites should touch. Wraps a
 * module-singleton `TelemetrySink` (lazily a local-JSONL file sink) behind a
 * config gate. Every entry point is best-effort: `recordTelemetry` never
 * throws, even if the sink does, and it no-ops entirely when telemetry is
 * disabled in config.
 *
 * Privacy reminder: record metadata/counters/latency only — never message or
 * file content or secrets (see `contracts.ts`).
 */

let sink: TelemetrySink | null = null;

function getSink(): TelemetrySink {
  if (sink === null) {
    sink = createFileTelemetrySink();
  }
  return sink;
}

/**
 * Override the active sink (tests inject an in-memory sink). Passing `null`
 * resets to the default lazily-created file sink on next use.
 */
export function setTelemetrySink(next: TelemetrySink | null): void {
  sink = next;
}

/**
 * Whether telemetry recording is enabled. Reads the CLI knobs via the
 * forgiving `getRawCliKnobs()` (which uses `loadOrInitConfig`, so a missing
 * config file never aborts the process) and treats telemetry as ENABLED by
 * default — only an explicit `cli.telemetry.enabled === false` disables it.
 * Any failure to read config is treated as enabled so we never silently lose
 * events because of an unrelated config problem.
 */
export function isTelemetryEnabled(): boolean {
  try {
    return getRawCliKnobs().telemetry?.enabled !== false;
  } catch {
    return true;
  }
}

/**
 * Record one telemetry event. Stamps a fresh `id` and `at` (unless `at` is
 * provided), then forwards to the active sink. No-ops when telemetry is
 * disabled. Never throws.
 */
export function recordTelemetry(
  input: { name: string } & Partial<Omit<TelemetryEvent, 'id' | 'name' | 'at'>> & { at?: string },
): void {
  if (!isTelemetryEnabled()) return;
  try {
    const event: TelemetryEvent = {
      ...input,
      id: `tel_${randomUUID().slice(0, 8)}`,
      name: input.name,
      at: input.at ?? new Date().toISOString(),
    };
    getSink().record(event);
  } catch {
    // best-effort — telemetry must never break a caller.
  }
}

/** Return the most-recent recorded events (all when `limit` is omitted). */
export function exportTelemetry(limit?: number): TelemetryEvent[] {
  return getSink().list(limit);
}

/** Drop all recorded telemetry. */
export function clearTelemetry(): void {
  getSink().clear();
}
