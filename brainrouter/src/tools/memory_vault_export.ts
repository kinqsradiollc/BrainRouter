import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

/**
 * MEM-7 (0.4.3) — `memory_vault_export`: write a read-only markdown mirror of
 * active records + tree nodes to a vault directory, with a hash ledger so
 * re-running only rewrites what changed. The DB stays authoritative; the vault
 * is for human inspection. Content is redacted before it lands.
 */

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(toolName: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }] };
}

export const memoryVaultExportToolSchema = {
  name: "memory_vault_export",
  description:
    "Export a read-only markdown mirror of active memories + tree nodes to a vault directory. Idempotent via a hash ledger (only changed files are rewritten); the DB stays authoritative; content is redacted. Returns { dir, written, unchanged, total }.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      dir: { type: "string", description: "Vault base directory (defaults to ~/.brainrouter/vault/<userId>)." },
    },
  },
} as const;

const schema = z.object({ userId: z.string().optional(), dir: z.string().optional() });

export async function handleMemoryVaultExport(args: any, options?: { defaultUserId?: string }) {
  try {
    const params = schema.parse(args ?? {});
    const userId = params.userId ?? options?.defaultUserId ?? "default";
    return toolResult(memoryEngine.exportVault(userId, params.dir));
  } catch (err) {
    return toolError("memory_vault_export", err);
  }
}
