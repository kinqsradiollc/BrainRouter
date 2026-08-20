// Internal implementation port for required core capability extensions.
// Public/user/workspace extensions never receive this runtime object.
// ADR-041 D8 — the builtin-tool handler registry. Importing the barrel runs each
// migrated tool's registration side effect; `builtinToolHandler` is consulted at
// the top of the switch so a migrated tool dispatches by lookup, not a case.
import { builtinToolHandler } from './handlers/index.js';
import path from 'node:path';

import { resolveWorkspacePathInScope, singleRootScope } from '../../agent/fs/workspaceFs.js';
import { nodeFilesystemPort, type FilesystemPort } from '../../agent/fs/filesystemPort.js';




/** Reviewer reads never follow aliases: policy is evaluated on lexical and canonical paths. */

export async function invokeBuiltinToolRuntime(
  this: any,
  name: string,
  args: Record<string, any>,
  authorizeMcpTarget?: (
    name: string,
    args: Record<string, unknown>,
    descriptor: unknown,
  ) => void,
  // ADR-041 A41-15 — Code Mode sub-dispatch, threaded like authorizeMcpTarget: it
  // only reaches here via the trusted `builtinRuntime.invoke` path (agent.ts), so a
  // user-extension tool can never obtain it (CWE-266). Only `run_code` reads it.
  codeModeDispatch?: (tool: string, args: Record<string, unknown>) => Promise<string>,
): Promise<string> {
    // Bind path resolution to this agent's workspace, never to process.cwd().
    // The Agent might have been constructed with a workspace different from
    // the launching shell's cwd (e.g. /resume from another dir), and cwd can
    // drift in unexpected ways. Explicit beats implicit here.
    const resolveHere = (p: string, opts: { forWrite?: boolean } = {}) =>
      resolveWorkspacePathInScope(
        // `this` is the Agent; its scope carries any entered worktrees (ADR-042
        // D1). Falls back to a single-root scope for any non-Agent caller.
        this.workspaceScope ?? singleRootScope(this.workspaceRoot),
        p,
        opts,
      );
    // ADR-042 D6 — a write into a worktree owned by a live foreign session is
    // refused with the owner named, BEFORE resolveHere (edit/notebook resolve
    // for read, so the escape guard alone would not catch them).
    const readOnlyGuard = (p: string) => {
      const owner = typeof this.readOnlyWorktreeOwner === 'function' ? this.readOnlyWorktreeOwner(p) : null;
      if (owner) {
        throw new Error(`Cannot write ${p}: it is in a worktree owned by session ${owner} (attached read-only). Coordinate with them, or re-enter it with override once they are done.`);
      }
    };
    // ADR-041 D3 — filesystem side effects go through the injected capability
    // port (default `nodeFilesystemPort` = the previous inline `node:fs`), so an
    // execution world (D10) can back them with container/remote I/O.
    const fsPort: FilesystemPort = this.filesystemPort ?? nodeFilesystemPort;
    // ADR-041 D8 COMPLETE — dispatch is now a pure registry lookup: every builtin
    // tool resolves to a registered handler and returns here. The former 66-case
    // `switch (name)` is fully dissolved; an unregistered name is an unknown tool.
    const migratedHandler = builtinToolHandler(name);
    if (migratedHandler) {
      return migratedHandler({
        args,
        invokedName: name,
        host: this,
        resolveHere,
        readOnlyGuard,
        fsPort,
        authorizeMcpTarget,
        codeModeDispatch,
      });
    }
    throw new Error(`Unknown local tool: ${name}`);
  }
