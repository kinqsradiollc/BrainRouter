// ADR-041 D3 — Capability port for subprocess/worker spawning in the tool runtime.
//
// The builtin `spawn_worker_thread` tool creates a child worker through this port
// instead of calling `spawnWorkerThread` inline, so an execution world (ADR-041
// D10) can spawn the worker somewhere else — a container, a remote box — without
// forking the tool. Same injection idiom as `FilesystemPort` / `computerUsePort`:
// an optional field on the Agent, defaulted to the local implementation (which
// wraps `spawnWorkerThread` verbatim, so behaviour is unchanged).
//
// This module holds ONLY the interface, importing the worker types type-only, so
// it stays free of the `workerTools` → `Agent` runtime edge. The default
// implementation lives where `spawnWorkerThread` already is (the tool runtime).

import type { McpClientPool } from "../../mcp/mcpPool.js";
import type { LLMConfig } from "../../config/config.js";
import type { SpawnWorkerInput } from "../../orchestration/agents/workerTools.js";
import type { WorkerMeta } from "../../worker/workerStore.js";

/**
 * The subprocess capability the builtin tool runtime depends on. Mirrors
 * `spawnWorkerThread`'s signature exactly, so the local default is a direct
 * reference and behaviour is byte-identical.
 */
export interface SubprocessPort {
  /** Spawn a child worker for `input.goal`; returns its initial metadata. */
  spawnWorker(
    mcpClient: McpClientPool,
    llmConfig: LLMConfig,
    input: SpawnWorkerInput,
  ): WorkerMeta;
}
