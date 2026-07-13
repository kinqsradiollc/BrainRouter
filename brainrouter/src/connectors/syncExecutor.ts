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
import { validateGithubApiBase } from "@kinqs/brainrouter-core/track";
import { refreshToken } from "./oauthBroker.js";
import type { ConnectorStore } from "./store.js";
import {
  connectorRecordIdsByDocument,
  ingestConnectorSources,
  type ConnectorSourceStore,
} from "./knowledgeImport.js";

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
  let credential = conn.credential;
  if (credential && needsRefresh(credential.expiresAt) && credential.refreshToken) {
    const app = conn.orgId
      ? await memoryEngine.connectors.getResolvedOAuthApp(conn.orgId, conn.source)
      : null;
    if (!app?.clientId) {
      await memoryEngine.connectors.updateConnector(connectorId, { status: "error", lastError: "OAuth app is unavailable — reconnect the source" });
      return { ok: false, documents: 0, imported: 0, error: "OAuth app unavailable" };
    }
    try {
      const refreshed = await refreshToken(conn.source, {
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        refreshToken: credential.refreshToken,
        redirectUri: credential.redirectUri,
      }, { fetchImpl: fetch });
      credential = { ...credential, ...refreshed, refreshToken: refreshed.refreshToken ?? credential.refreshToken };
      await memoryEngine.connectors.updateConnector(connectorId, { credential, status: "connected", lastError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await memoryEngine.connectors.updateConnector(connectorId, { status: "error", lastError: `token refresh failed: ${message}` });
      return { ok: false, documents: 0, imported: 0, error: message };
    }
  }
  const accessToken = credential?.accessToken ?? "";
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

  // config.baseUrl is user-controlled (set via the connector CRUD API); validate it so a
  // spoofed base can't make the server fetch an internal/metadata host with the sealed
  // token (SSRF, CWE-918). Invalid ⇒ undefined ⇒ the client's default api.github.com.
  const apiBase = validateGithubApiBase(typeof config.baseUrl === "string" ? config.baseUrl : "") ?? undefined;
  try {
    const runResult = await runConnectorCheckpointCore(workspaceRoot, fileId, {
      // Inject the sealed DB token — never env/keychain (that's desktop-only).
      oauthToken: () => ({ token: accessToken }),
      githubClient: () => githubTokenClient(accessToken, { apiBase }),
    });

    let imported = 0;
    if (runResult.documents.length > 0) {
      // A server connector workspace is an implementation detail, not a user
      // workspace. Import at the connector's explicit tenant scope and keep the
      // knowledge org-wide (workspace/project NULL) unless a future connector
      // contract supplies a real product scope.
      const bundle = exportConnectorDocumentsForMemory(workspaceRoot, {
        connectorId: fileId,
        userId: conn.userId,
        orgId: conn.orgId,
        visibility: conn.visibility,
        workspaceTag: null,
        projectTag: null,
      });
      if (bundle.recordCount > 0) {
        const recordIdsByDocument = connectorRecordIdsByDocument(bundle.data.memories);
        await memoryEngine.importMemories(conn.userId, bundle.data as never);
        await ingestConnectorSources(
          memoryEngine.store as unknown as ConnectorSourceStore,
          runResult.documents,
          {
            connectorId: conn.id,
            userId: conn.userId,
            orgId: conn.orgId,
            visibility: conn.visibility,
            projectId: null,
            workspaceTag: null,
          },
          recordIdsByDocument,
        );
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
    // The core run may have ADVANCED the file connector's checkpoint before the import
    // step threw. Roll it back to the DB's last-good checkpoint so the next sync
    // re-fetches the un-imported documents instead of skipping them (no data loss).
    try { updateFileConnector(workspaceRoot, fileId, { checkpoint: (conn.checkpoint ?? {}) as never }); } catch { /* best-effort rollback */ }
    await memoryEngine.connectors.updateConnector(connectorId, { status: "error", lastError: msg, lastRunAt: new Date().toISOString() });
    return { ok: false, documents: 0, imported: 0, error: msg };
  }
}

/** Refresh a little before expiry so a long checkpoint never starts with a token
 * that will expire mid-request.  OAuth providers may omit expiry for durable
 * tokens, in which case we leave the token alone. */
function needsRefresh(expiresAt: string | undefined, skewMs = 120_000): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= Date.now() + skewMs;
}

/** Enqueue a `connector_sync` job per enabled connector — called from the
 *  maintenance tick (mirrors the per-user maintenance fan-out). Returns the count. */
export async function enqueueConnectorSyncs(store: IMemoryStore, connectorStore: Pick<ConnectorStore, "listAllEnabledConnectors"> = memoryEngine.connectors): Promise<number> {
  const connectors = await connectorStore.listAllEnabledConnectors();
  const inflight = await store.listMemoryJobs({ kind: "connector_sync", status: ["pending", "running"], limit: 10_000 }).catch(() => []);
  const activeIds = new Set(inflight.map((job) => String((job.input as { connectorId?: unknown } | null)?.connectorId ?? "")).filter(Boolean));
  let n = 0;
  for (const c of connectors) {
    if (activeIds.has(c.id)) continue;
    try { await enqueueAgentJob(store, "connector_sync", { connectorId: c.id, userId: c.userId }); n++; } catch { /* one bad row shouldn't stop the rest */ }
  }
  return n;
}
