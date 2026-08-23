// ADR-041 D3 — Capability port for shell execution in the tool runtime.
//
// The `run_command` tool performs its *bare exec* through this port instead of
// calling `runShell` / `startBackgroundShell` inline, so an execution world
// (ADR-041 D10) can run the command elsewhere — a container, a remote box —
// without forking the tool. Same injection idiom as `FilesystemPort` /
// `SubprocessPort`: an optional field on the Agent, defaulted to the local
// implementation (which references `runShell` / `startBackgroundShell` verbatim,
// so behaviour is byte-identical).
//
// Only the EXEC is behind the port. The ~200 lines of approval, policy,
// sandbox-resolution, and destructive-command-guard logic stay inline in the
// `run_command` case (they move to the shared guarded pipeline in D8) — the port
// receives an already-resolved `SandboxConfig` and runs it. Types are imported
// type-only so this module stays free of the exec-layer's runtime edges.

import type { SandboxConfig, SandboxRunResult } from "../../exec/runtime/sandbox.js";
import type { BgShellRun } from "../../exec/runtime/backgroundShell.js";

/**
 * The shell-execution capability the builtin tool runtime depends on. Mirrors the
 * `runShell` / `startBackgroundShell` signatures exactly, so the local default is
 * a direct reference and behaviour is unchanged. The sandbox config is resolved by
 * the caller (approval/policy/guards) and passed in — the port only executes.
 */
export interface ShellPort {
  /** Run a command under an already-resolved sandbox config (foreground). */
  runShell(
    command: string,
    config: SandboxConfig,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SandboxRunResult>;
  /** Start a detached background shell; returns its handle. */
  startBackgroundShell(input: {
    command: string;
    cwd: string;
    workspaceRoot: string;
  }): BgShellRun;
}
