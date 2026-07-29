/**
 * Shared SDK request controls.
 *
 * Feature clients consume this transport-neutral shape so cancellation stays
 * consistent without coupling unrelated domains to one another.
 */
export interface BrainRouterRequestOptions {
  signal?: AbortSignal;
}
