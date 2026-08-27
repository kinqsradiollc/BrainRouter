/**
 * ADR-050 — external-agent sessions. The seam (`types`), the one-shot fallback
 * transport, and the transport factory. Structured transports (P2) add modules
 * here and cases to the factory.
 */
export * from './types.js';
export * from './oneShotSpawn.js';
export * from './oneShotSession.js';
export * from './factory.js';
