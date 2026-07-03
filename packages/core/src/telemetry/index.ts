// Public entrypoint for the `telemetry` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/telemetry` instead of deep `dist/telemetry/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './events/contracts.js';
export * from './events/fileTelemetryAdapter.js';
export * from './recorder/telemetry.js';
export * from './events/telemetryPort.js';
export * from './tracing/tracing.js';
