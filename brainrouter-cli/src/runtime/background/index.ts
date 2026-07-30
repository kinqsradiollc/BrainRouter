/**
 * runtime/background — background execution: the run registry (`/bg` / `/ps`),
 * detach/stop helpers, the repeating-prompt `/loop` runner, the in-process
 * `/schedule` ticker, and idle completion notices.
 */
export * from './bgRuns.js';
export * from './bgDetach.js';
export * from './loopRunner.js';
export * from './scheduleTicker.js';
export * from './completionNotices.js';
