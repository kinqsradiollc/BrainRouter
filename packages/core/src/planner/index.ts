/**
 * ADR-028 Part D — the planner's public surface.
 *
 * A barrel, so the backend and the desktop import one path instead of six deep
 * ones. It also means the merge rules the SERVER applies (D11) are literally
 * the same functions the client applies — one implementation, so the two halves
 * cannot drift into disagreeing about who won a conflict.
 *
 * The clock and the outbox now live under `sync/`, shared with Notes per
 * ADR-029 B3. They are re-exported here unchanged: the backend, the desktop and
 * the CLI all import them from this path, and moving a file is not a reason to
 * make three consumers edit their imports.
 */
export * from '../sync/hybridClock.js';
export * from '../sync/outbox.js';
export * from './itemMerge.js';
export * from './timetable.js';
export * from './sourceAdapter.js';
export * from './connectorIssueAdapter.js';
export * from './agentContext.js';
export * from './plannerStore.js';
export * from './plannerService.js';
export * from './plannerSync.js';
export * from './wireContract.js';
