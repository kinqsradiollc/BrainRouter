/**
 * Shared agent-domain data contracts.
 *
 * Runtime policy stays in Core; this leaf entrypoint owns only serializable,
 * host-neutral records that cross package or process boundaries.
 */

export * from "./delegation.js";
