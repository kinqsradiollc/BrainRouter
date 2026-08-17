// ADR-041 D8 — the builtin-tool handler registry: the strangler seam that lets
// the 66-case `switch (name)` in ../runtime.ts dissolve one tool at a time.
//
// A migrated builtin registers a handler here; `invokeBuiltinToolRuntime`
// consults the registry BEFORE the switch, so every un-migrated tool still falls
// through to the switch unchanged. A migrated handler's body is the switch case
// body verbatim (`args` → `ctx.args`, `this.x` → `ctx.host.x`), so the bytes
// returned to the model are identical — that is the byte-neutrality invariant
// every migration slice preserves. When the switch is finally empty, dispatch is
// a registry lookup and D8's shared guarded pipeline fronts every call.

import type { FilesystemPort } from '../../../agent/fs/filesystemPort.js';

/**
 * The Agent surface a migrated builtin handler may read. Empty at D8 Phase 1 —
 * the planner tools read nothing off the Agent — and it grows MONOTONICALLY: each
 * migration slice adds only the fields its tool actually uses, cited to the line
 * that reads them. When the switch is gone this interface is the exhaustive,
 * honest list of what builtins need from the Agent, replacing today's `this: any`.
 */
export interface BuiltinToolHost {
  /** Workspace root of the agent's primary scope — runtime.ts:301. (D8 Phase 2: research_brief) */
  readonly workspaceRoot: string;
  /** The agent's session key — runtime.ts. (D8 Phase 2: research_brief) */
  readonly sessionKey: string;
}

/** Everything a migrated handler receives — the shared closures the switch built inline. */
export interface BuiltinToolContext {
  readonly args: Record<string, any>;
  readonly invokedName: string;
  readonly host: BuiltinToolHost;
  /** `resolveWorkspacePathInScope(...)` — runtime.ts:307. */
  readonly resolveHere: (relativeOrAbsolute: string, options?: { forWrite?: boolean }) => string;
  /** Rejects a path outside the read-allowed scope — runtime.ts:318. */
  readonly readOnlyGuard: (path: string) => void;
  /** The D3 filesystem capability (default `nodeFilesystemPort`) — runtime.ts:327. */
  readonly fsPort: FilesystemPort;
  /** Present only for nested-MCP tools that authorize a target mid-call. */
  readonly authorizeMcpTarget?: (name: string, args: Record<string, unknown>, descriptor: unknown) => void;
}

export type BuiltinToolHandler = (ctx: BuiltinToolContext) => Promise<string>;

const HANDLERS = new Map<string, BuiltinToolHandler>();

/** Register a migrated builtin's handler. Throws on a duplicate name — a tool has one home. */
export function registerBuiltinHandler(name: string, handler: BuiltinToolHandler): void {
  if (HANDLERS.has(name)) {
    throw new Error(`Duplicate builtin tool handler registration: ${name}`);
  }
  HANDLERS.set(name, handler);
}

/** The handler for `name`, or undefined if the tool still lives in the switch. */
export function builtinToolHandler(name: string): BuiltinToolHandler | undefined {
  return HANDLERS.get(name);
}

/** The set of tool names that have been migrated to a registered handler. */
export function registeredHandlerNames(): ReadonlySet<string> {
  return new Set(HANDLERS.keys());
}
