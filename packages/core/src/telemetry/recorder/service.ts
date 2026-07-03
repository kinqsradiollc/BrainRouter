/**
 * Telemetry service (ADR-008, Wave 2) — a stateless port over the telemetry
 * recorder. The pluggable {@link TelemetrySink} (telemetryPort.ts) is already the
 * output boundary; this groups the record/export/enable surface behind one
 * contract. Additive and behaviour-preserving: every method delegates to the
 * existing telemetry functions. No logic moved or removed.
 */
import {
  setTelemetrySink, isTelemetryEnabled, recordTelemetry, exportTelemetry,
} from "./telemetry.js";
import type { TelemetrySink } from "../events/telemetryPort.js";
import type { TelemetryEvent } from "../events/contracts.js";

/** Input accepted by {@link ITelemetryService.record} — the recorder's exact shape. */
export type TelemetryInput = Parameters<typeof recordTelemetry>[0];

/** The telemetry recorder contract. */
export interface ITelemetryService {
  setSink(next: TelemetrySink | null): void;
  isEnabled(): boolean;
  record(input: TelemetryInput): void;
  export(limit?: number): TelemetryEvent[];
}

/** {@link ITelemetryService} backed by the in-process telemetry recorder — delegates only. */
export class TelemetryService implements ITelemetryService {
  setSink(next: TelemetrySink | null): void {
    return setTelemetrySink(next);
  }
  isEnabled(): boolean {
    return isTelemetryEnabled();
  }
  record(input: TelemetryInput): void {
    return recordTelemetry(input);
  }
  export(limit?: number): TelemetryEvent[] {
    return exportTelemetry(limit);
  }
}

/** Construct a telemetry service. */
export function createTelemetryService(): ITelemetryService {
  return new TelemetryService();
}
