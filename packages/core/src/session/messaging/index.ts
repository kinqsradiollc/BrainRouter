/**
 * Public ADR-034 local session-messaging surface.
 *
 * CLI and Desktop consume these contracts and lifecycle functions through
 * `@kinqs/brainrouter-core/session`; registry bearer tokens and filesystem
 * record mechanics remain internal to this folder.
 */

export * from './contracts.js';
export * from './identity.js';
export * from './listener.js';
export {
  discoverLocalSessionRoutes,
  sendLocalSessionMessage,
  type LocalSessionDiscoveryOptions,
  type LocalSessionSendOptions,
} from './client.js';
export * from './routes.js';
export * from './senderProof.js';
export { requireSessionKey, sanitizePeerTextForTerminal } from './validation.js';
