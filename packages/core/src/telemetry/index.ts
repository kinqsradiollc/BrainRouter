// Public entrypoint for the `telemetry` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/telemetry` instead of deep `dist/telemetry/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './contracts.js';
export * from './fileTelemetryAdapter.js';
export * from './telemetry.js';
export * from './telemetryPort.js';
export * from './tracing.js';
