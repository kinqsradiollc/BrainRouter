/**
 * The shared agent-host protocol.
 *
 * This stable root entrypoint exposes one dependency-free vocabulary across
 * CLI, Desktop, and utility-process hosts while private sibling modules own
 * events, commands, interactions, callback projection, and envelope stamping.
 */

export * from './events.js';
export * from './commands.js';
export * from './interaction.js';
export * from './callbackBridge.js';
export * from './envelope.js';
