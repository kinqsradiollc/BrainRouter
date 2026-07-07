/**
 * ADR-016 C3 — server-side connector sync. Runs the CORE connector runtime
 * (unchanged) for a DB-stored connector: it seeds a per-connector server
 * workspace from the sealed DB config, injects the sealed OAuth token as the
 * credential (replacing the desktop's env/keychain resolver), ingests the
 * documents into the OWNER's memory, and persists the advanced checkpoint +
 * status back to the DB. Driven by the `connector_sync` job executor.
 */
import path from "node:path";
import type { IMemoryStore } from "@kinqs/brainrouter-types";
import { memoryEngine } from "../memory/engine.js";
import { enqueueAgentJob } from "../memory/scheduler/jobs.js";
import {
  listConnectors as listFileConnectors,
  createConnector as createFileConnector,
  updateConnector as updateFileConnector,
  runConnectorCheckpointCore,
  exportConnectorDocumentsForMemory,
  githubTokenClient,
} from "@kinqs/brainrouter-core/connectors";

const SERVER_CONNECTORS_ROOT = path.join(
  process.env.BRAINROUTER_HOME ?? path.join(process.env.HOME ?? ".", ".brainrouter"),
  "server-connectors",
);

export interface ConnectorSyncResult { ok: boolean; documents: number; imported: number; error?: string }

/** Sync ONE connector by its DB id. Best-effort: records the error on the row. */
export async function runConnectorSync(connectorId: string): Promise<ConnectorSyncResult> {
  const conn = await memoryEngine.connectors.getResolvedConnector(connectorId);
  if (!conn) return { ok: false, documents: 0, imported: 0, error: "connector not found" };
  if (!conn.enabled) return { ok: true, documents: 0, imported: 0 };
  const accessToken = conn.credential?.accessToken ?? "";
  if (!accessToken) {
    await memoryEngine.connectors.updateConnector(connectorId, { status: "error", lastError: "no credential — reconnect the source" });
    return { ok: false, documents: 0, imported: 0, error: "no credential" };
  }

  const workspaceRoot = path.join(SERVER_CONNECTORS_ROOT, connectorId);
  const config = conn.config as Record<string, unknown>;
  // One isolated file-connector per workspace — reuse it (its checkpoint persists
  // incremental sync) or create it, seeded from the DB config + checkpoint.
  const existing = listFileConnectors(workspaceRoot)[0];
  let fileId: string;
  if (existing) {
    fileId = existing.id;
    updateFileConnector(workspaceRoot, fileId, { config: config as never });
  } else {
    const rec = createFileConnector(workspaceRoot, {
      source: conn.source as never,
      name: conn.name || conn.source,
      config: config as never,
      credential: { mode: "static", ref: "SERVER_OAUTH", hasSecret: true },
      flows: ["load", "checkpoint"] as never,
    });
    fileId = rec.id;
    if (conn.checkpoint && Object.keys(conn.checkpoint).length) {
      updateFileConnector(workspaceRoot, fileId, { checkpoint: conn.checkpoint as never });
    }
  }

  const apiBase = typeof config.baseUrl === "string" ? config.baseUrl : undefined;
  try {
    const runResult = await runConnectorCheckpointCore(workspaceRoot, fileId, {
      // Inject the sealed DB token — never env/keychain (that's desktop-only).
      envToken: () => ({ token: accessToken }),
      githubClient: () => githubTokenClient(accessToken, { apiBase }),
    });

    let imported = 0;
    if (runResult.documents.length > 0) {
      const bundle = exportConnectorDocumentsForMemory(workspaceRoot, { connectorId: fileId, userId: conn.userId });
      if (bundle.recordCount > 0) {
        await memoryEngine.importMemories(conn.userId, bundle.data as never);
        imported = bundle.recordCount;
      }
    }

    const advanced = listFileConnectors(workspaceRoot).find((c) => c.id === fileId);
    await memoryEngine.connectors.updateConnector(connectorId, {
      checkpoint: (advanced?.checkpoint ?? {}) as Record<string, unknown>,
      status: runResult.ok ? "connected" : "error",
      lastRunAt: new Date().toISOString(),
      lastError: runResult.ok ? null : "sync reported failures",
    });
    return { ok: runResult.ok, documents: runResult.documents.length, imported };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await memoryEngine.connectors.updateConnector(connectorId, { status: "error", lastError: msg, lastRunAt: new Date().toISOString() });
    return { ok: false, documents: 0, imported: 0, error: msg };
  }
}

/** Enqueue a `connector_sync` job per enabled connector — called from the
 *  maintenance tick (mirrors the per-user maintenance fan-out). Returns the count. */
export async function enqueueConnectorSyncs(store: IMemoryStore): Promise<number> {
  const connectors = await memoryEngine.connectors.listAllEnabledConnectors();
  let n = 0;
  for (const c of connectors) {
    try { await enqueueAgentJob(store, "connector_sync", { connectorId: c.id, userId: c.userId }); n++; } catch { /* one bad row shouldn't stop the rest */ }
  }
  return n;
}
