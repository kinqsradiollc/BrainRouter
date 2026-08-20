// ADR-041 A41-7 — the MCP tool-handler registry: the strangler seam that lets
// the 98-case `switch (request.params.name)` in ../mcpServer.ts dissolve one tool
// at a time (the same pattern D8 applied to the CLI builtin-tool switch in
// core/extension/builtin/handlers/registry.ts).
//
// A migrated MCP tool registers a handler here; the CallTool dispatcher consults
// the registry BEFORE the switch, so every un-migrated tool still falls through to
// the switch unchanged. A migrated handler's body is the switch case body verbatim
// (`request.params.arguments` → `ctx.args`, the closure deps → `ctx.host.*`), so
// the bytes returned to the model are identical — that is the byte-neutrality
// invariant every migration slice preserves. When the switch is finally empty,
// dispatch is a registry lookup wrapped in the SAME IDOR-guard + metrics envelope.

import type { Registry } from '../../registry.js';

/**
 * The per-connection surface a migrated MCP tool handler may read — the closure
 * deps `buildMcpServer(registry, options)` builds once per MCP connection. Empty
 * of session/hub machinery at A41-7 Phase 1 (the skill/persona/reference/template
 * tools read only the registry + admin flag) and it grows MONOTONICALLY: each
 * migration slice adds only the fields its tools actually use, cited to the line
 * in mcpServer.ts that builds them. When the switch is gone this interface is the
 * exhaustive, honest list of what the MCP tools need from the server closure.
 */
export interface McpToolHost {
  /** The skills/persona/reference/template registry — mcpServer.ts:195 (buildMcpServer param). */
  readonly registry: Registry;
  /** Whether this connection is an admin — gates create_skill/update_skill; mcpServer.ts:200. */
  readonly isAdmin: boolean;
}

/** Everything a migrated MCP tool handler receives — the shared closure the switch dispatched inline. */
export interface McpToolContext {
  /** The raw `request.params.arguments` (the handler parses it with its own zod schema). */
  readonly args: unknown;
  /** The tool name as invoked — mirrors `request.params.name`. */
  readonly invokedName: string;
  /** The per-connection server surface (registry, admin flag, …). */
  readonly host: McpToolHost;
}

// The dispatcher assigns each case's result into an `any` IIFE, so the loosest
// return keeps migrated handlers byte-identical to the switch cases they replace.
export type McpToolHandler = (ctx: McpToolContext) => Promise<unknown>;

const HANDLERS = new Map<string, McpToolHandler>();

/** Register a migrated MCP tool's handler. Throws on a duplicate name — a tool has one home. */
export function registerMcpTool(name: string, handler: McpToolHandler): void {
  if (HANDLERS.has(name)) {
    throw new Error(`Duplicate MCP tool handler registration: ${name}`);
  }
  HANDLERS.set(name, handler);
}

/** The handler for `name`, or undefined if the tool still lives in the switch. */
export function mcpToolHandler(name: string): McpToolHandler | undefined {
  return HANDLERS.get(name);
}

/** The set of tool names that have been migrated to a registered handler. */
export function registeredMcpToolNames(): ReadonlySet<string> {
  return new Set(HANDLERS.keys());
}
