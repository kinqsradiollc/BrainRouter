// Public entrypoint for the session-native reminders subsystem (ADR-041 A41-16 W4).
// Consumers import `@kinqs/brainrouter-core/session/reminders` / the relative barrel
// instead of the file directly, matching the session/transcript + session/feedback
// convention. Re-export only — the store, the pure catch-up projection, and the
// renderer all live in reminderStore.ts.
export * from './reminderStore.js';
