import type { TelemetryEvent } from './contracts.js';

/**
 * Port for a telemetry sink. The default implementation
 * (`createFileTelemetrySink`) writes local JSONL; tests swap in an
 * array-backed sink via `setTelemetrySink`. Implementations MUST NOT throw
 * from any method — telemetry is strictly best-effort.
 */
export interface TelemetrySink {
  /** Persist one event. Best-effort; never throws. */
  record(event: TelemetryEvent): void;
  /** Return the most-recent events (all when `limit` is omitted). */
  list(limit?: number): TelemetryEvent[];
  /** Drop all persisted events. */
  clear(): void;
}
