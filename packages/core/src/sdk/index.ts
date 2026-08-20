/**
 * ADR-041 A41-16 (W4) — the out-of-process SDK surface.
 *
 * The runtime already exposes a typed client + server for driving a BrainRouter
 * agent conversation from ANOTHER process over the versioned `/runtime/v1` API
 * (`runtime/runnerClient.ts` + `runtime/server.ts`). This module formalizes them
 * as a focused, documented public surface — `@kinqs/brainrouter-core/sdk` — so an
 * external harness (a headless one-shot driver, a CI runner, another service) can
 * depend on the client contract without importing the whole `runtime` barrel.
 *
 * Typical use (headless one-shot against a runtime in another process):
 * ```ts
 * import { createRuntimeRunnerClient } from '@kinqs/brainrouter-core/sdk';
 * const client = createRuntimeRunnerClient({
 *   workspaceRoot,
 *   remoteUrl: 'https://runtime-host:7171', // drives the /runtime/v1 API
 *   fetch,                              // any WHATWG fetch
 *   executeTurn: async () => '',        // unused in remote mode
 * });
 * const { runtimeId } = await client.start({ sessionKey });
 * const { output } = await client.send({ runtimeId, sessionKey, prompt: 'hi' });
 * ```
 *
 * The transport is HTTP/JSON, gated by a `server_info` compatibility handshake
 * (client and server must share a major.minor); the server stays the system of
 * record. Omitting `remoteUrl` yields an in-process client backed by a local
 * `RuntimeManager`. Re-exports only — the implementation lives in `runtime/`, so
 * there is exactly one runner contract in the product.
 */
export {
  createRuntimeRunnerClient,
  type RuntimeRunnerClient,
  type CreateRuntimeRunnerClientOptions,
  type RuntimeRunnerStartInput,
  type RuntimeRunnerStartResult,
  type RuntimeRunnerSendInput,
  type RuntimeRunnerSendResult,
  type RuntimeRunnerRuntimeInput,
  type RuntimeRunnerStatusResult,
  type RuntimeRunnerEventsResult,
  type RuntimeRunnerFileInput,
  type RuntimeRunnerReadFileResult,
  type RuntimeRunnerWriteFileInput,
  type RuntimeRunnerWriteFileResult,
  type RuntimeRunnerGitStatusResult,
} from '../runtime/runnerClient.js';

export { RUNTIME_API_PREFIX, RUNTIME_SESSION_HEADER } from '../runtime/server.js';
export { assertRuntimeServerCompatible } from '../runtime/client.js';
