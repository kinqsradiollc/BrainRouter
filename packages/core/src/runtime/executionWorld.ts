// ADR-041 D10 — Execution worlds: filesystem, shell, and subprocess swap as one unit.
//
// D3 introduced three capability ports (FilesystemPort, ShellPort, SubprocessPort),
// but they are not independently swappable in practice: a shell that runs remotely
// while the filesystem port reads locally is incoherent — the command's output
// files are not where `read_file` looks. An `ExecutionWorld` is the coherent set:
// a named binding of all three ports, selected as one. The `local` world wraps
// today's node implementations; the runtime backends (worktree, container) become
// alternative worlds instead of bespoke code paths. Point the world at a container
// or a remote box and every tool follows — the actual plug-and-play property.
//
// This is the foundation slice (A41-10): the type + the resolution helper the
// Agent uses to derive its port fields from an injected world. The sandbox
// resolver named in D10 joins the world when D8 lifts sandbox resolution out of
// the inline `run_command` case; until then the world binds the three execution
// ports and sandbox resolution stays where it is. Port interfaces are imported
// type-only so this module carries no runtime edge into the exec layer — the
// concrete `local` world is constructed where the node implementations live.

import type { FilesystemPort } from "../agent/fs/filesystemPort.js";
import type { ShellPort } from "../agent/shell/shellPort.js";
import type { SubprocessPort } from "../agent/subprocess/subprocessPort.js";

/** The name of the default world that wraps the local node implementations. */
export const LOCAL_EXECUTION_WORLD = "local";

/**
 * A coherent binding of the three capability ports, selected as one unit. Swapping
 * the world moves everything that executes — `run_command`, background shells,
 * workers — in a single gesture, with no per-tool forks.
 */
export interface ExecutionWorld {
  /** Stable identifier for introspection (D11 composition dump). e.g. `local`. */
  readonly name: string;
  readonly filesystem: FilesystemPort;
  readonly shell: ShellPort;
  readonly subprocess: SubprocessPort;
}

/** The three capability ports, any of which may be unset (⇒ the local call-site default). */
export interface ResolvedExecutionPorts {
  filesystemPort?: FilesystemPort;
  shellPort?: ShellPort;
  subprocessPort?: SubprocessPort;
}

/**
 * Resolve the three capability ports for an agent, honouring precedence:
 * an explicit per-port override wins over the execution world, which wins over
 * "unset" (the tool runtime then uses its local `node*Port` default at the call
 * site). With no world and no explicit port, every field is `undefined` — exactly
 * the state before D10, so behaviour is byte-identical.
 */
export function resolveExecutionPorts(input: {
  filesystemPort?: FilesystemPort;
  shellPort?: ShellPort;
  subprocessPort?: SubprocessPort;
  executionWorld?: ExecutionWorld;
}): ResolvedExecutionPorts {
  return {
    filesystemPort: input.filesystemPort ?? input.executionWorld?.filesystem,
    shellPort: input.shellPort ?? input.executionWorld?.shell,
    subprocessPort: input.subprocessPort ?? input.executionWorld?.subprocess,
  };
}
