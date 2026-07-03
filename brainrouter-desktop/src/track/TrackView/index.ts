// Public entrypoint for the Track view subsystem. Consumers (TrackView.tsx,
// TrackDetail.tsx) import from this barrel instead of reaching into the flat
// files, so the folder's per-concern layout (shared/ + views/) stays an
// internal detail. Behavior-preserving re-export of what those heads consume.
export * from './shared/index.js';
export * from './views/index.js';
