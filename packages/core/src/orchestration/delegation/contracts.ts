/**
 * Dependency-light delegation contract entrypoint.
 *
 * Hosts and persistence adapters use this instead of initializing the broader
 * orchestration runtime merely to build, normalize, or render a task packet.
 */

export * from './taskPacket.js';
export * from './crossHostPacket.js';
export * from './taskPacketNormalization.js';
