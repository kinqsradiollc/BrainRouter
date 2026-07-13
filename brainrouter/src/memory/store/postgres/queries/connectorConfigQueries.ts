/**
 * ADR-016 C2 — connector_configs + oauth_app_configs queries. The per-user OAuth
 * token and the per-org OAuth-app secret are sealed with secretBox before they hit
 * the DB and opened only for the sync runner / broker. Mirrors integrationConfigQueries.
 */
import { randomUUID } from "node:crypto";
import type { Executor } from "./executor.js";
import { seal, open } from "../../../../security/secretBox.js";
import type {
  ConnectorConfigRecord, ConnectorConfigInput, ConnectorConfigPatch,
  ResolvedConnector, ConnectorTokenSecret, ConnectorVisibility,
  OAuthAppConfig, ResolvedOAuthApp,
} from "../../../../connectors/store.js";

const COLS = "id, user_id, org_id, source, name, status, enabled, visibility, config_json, credential_ciphertext, checkpoint_json, last_run_at, last_error, created_at, updated_at";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : s(v));
const parseObj = (v: unknown): Record<string, unknown> => { try { return v ? JSON.parse(String(v)) as Record<string, unknown> : {}; } catch { return {}; } };

function rowToRecord(row: Row): ConnectorConfigRecord {
  return {
    id: s(row.id), userId: s(row.user_id), orgId: row.org_id == null ? null : s(row.org_id),
    source: s(row.source), name: s(row.name), status: s(row.status) || "connected",
    enabled: row.enabled !== false, visibility: (s(row.visibility) === "org" ? "org" : "private") as ConnectorVisibility,
    config: parseObj(row.config_json), hasCredential: !!s(row.credential_ciphertext),
    checkpoint: parseObj(row.checkpoint_json),
    lastRunAt: row.last_run_at == null ? null : iso(row.last_run_at),
    lastError: row.last_error == null ? null : s(row.last_error),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export async function listConnectors(exec: Executor, userId: string): Promise<ConnectorConfigRecord[]> {
  const rows = await exec.rows(`SELECT ${COLS} FROM connector_configs WHERE user_id = $1 ORDER BY source, created_at ASC`, [userId]);
  return rows.map(rowToRecord);
}

export async function listAllEnabledConnectors(exec: Executor): Promise<ConnectorConfigRecord[]> {
  const rows = await exec.rows(`SELECT ${COLS} FROM connector_configs WHERE enabled ORDER BY user_id, source ASC`, []);
  return rows.map(rowToRecord);
}

export async function getConnector(exec: Executor, id: string): Promise<ConnectorConfigRecord | null> {
  const row = await exec.one(`SELECT ${COLS} FROM connector_configs WHERE id = $1`, [id]);
  return row ? rowToRecord(row as Row) : null;
}

export async function getResolvedConnector(exec: Executor, id: string): Promise<ResolvedConnector | null> {
  const row = await exec.one(`SELECT ${COLS} FROM connector_configs WHERE id = $1`, [id]);
  if (!row) return null;
  const rec = rowToRecord(row as Row);
  const cipher = s((row as Row).credential_ciphertext);
  let credential: ConnectorTokenSecret | null = null;
  if (cipher) { try { credential = JSON.parse(open(cipher)) as ConnectorTokenSecret; } catch { credential = null; } }
  const { hasCredential: _omit, ...rest } = rec;
  return { ...rest, credential };
}

export async function createConnector(exec: Executor, userId: string, input: ConnectorConfigInput, now?: string): Promise<ConnectorConfigRecord> {
  const id = `conn_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const ts = now ?? new Date().toISOString();
  const cipher = input.credential ? seal(JSON.stringify(input.credential)) : "";
  await exec.run(
    `INSERT INTO connector_configs (id, user_id, org_id, source, name, status, enabled, visibility, config_json, credential_ciphertext, checkpoint_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'connected',$6,$7,$8,$9,'{}',$10,$10)`,
    [id, userId, input.orgId ?? null, input.source, input.name ?? "", input.enabled !== false, input.visibility ?? "private", JSON.stringify(input.config ?? {}), cipher, ts],
  );
  return (await getConnector(exec, id))!;
}

export async function updateConnector(exec: Executor, id: string, patch: ConnectorConfigPatch, now?: string): Promise<ConnectorConfigRecord | null> {
  const existing = await exec.one(`SELECT id FROM connector_configs WHERE id = $1`, [id]);
  if (!existing) return null;
  const sets: string[] = []; const vals: unknown[] = []; let i = 1;
  const set = (col: string, val: unknown): void => { sets.push(`${col} = $${i++}`); vals.push(val); };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.enabled !== undefined) set("enabled", patch.enabled);
  if (patch.visibility !== undefined) set("visibility", patch.visibility);
  if (patch.orgId !== undefined) set("org_id", patch.orgId);
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.config !== undefined) set("config_json", JSON.stringify(patch.config));
  if (patch.checkpoint !== undefined) set("checkpoint_json", JSON.stringify(patch.checkpoint));
  if (patch.lastRunAt !== undefined) set("last_run_at", patch.lastRunAt);
  if (patch.lastError !== undefined) set("last_error", patch.lastError);
  if (patch.credential !== undefined) set("credential_ciphertext", patch.credential ? seal(JSON.stringify(patch.credential)) : "");
  set("updated_at", now ?? new Date().toISOString());
  await exec.run(`UPDATE connector_configs SET ${sets.join(", ")} WHERE id = $${i}`, [...vals, id]);
  return getConnector(exec, id);
}

export async function deleteConnector(exec: Executor, id: string): Promise<void> {
  await exec.run(`DELETE FROM connector_configs WHERE id = $1`, [id]);
}

// ── oauth_app_configs (per-org client_id/secret) ──

export async function getResolvedOAuthApp(exec: Executor, orgId: string, source: string): Promise<ResolvedOAuthApp | null> {
  const row = await exec.one(`SELECT org_id, source, client_id, client_secret_ciphertext, scopes FROM oauth_app_configs WHERE org_id = $1 AND source = $2`, [orgId, source]) as Row | undefined;
  if (!row) return null;
  const cipher = s(row.client_secret_ciphertext);
  let clientSecret = "";
  if (cipher) { try { clientSecret = open(cipher); } catch { clientSecret = ""; } }
  return { orgId: s(row.org_id), source: s(row.source), clientId: s(row.client_id), clientSecret, scopes: s(row.scopes) };
}

export async function upsertOAuthApp(exec: Executor, orgId: string, source: string, clientId: string, clientSecret: string | undefined, scopes = "", now?: string): Promise<OAuthAppConfig> {
  const ts = now ?? new Date().toISOString();
  const existing = await exec.one(`SELECT id, client_secret_ciphertext FROM oauth_app_configs WHERE org_id = $1 AND source = $2`, [orgId, source]) as Row | undefined;
  const cipher = clientSecret ? seal(clientSecret) : s(existing?.client_secret_ciphertext);
  if (existing) {
    await exec.run(`UPDATE oauth_app_configs SET client_id = $1, client_secret_ciphertext = $2, scopes = $3, updated_at = $4 WHERE id = $5`, [clientId, cipher, scopes, ts, s(existing.id)]);
    return { id: s(existing.id), orgId, source, clientId, scopes, hasSecret: !!cipher, createdAt: ts, updatedAt: ts };
  }
  const id = `oauthapp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await exec.run(`INSERT INTO oauth_app_configs (id, org_id, source, client_id, client_secret_ciphertext, scopes, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [id, orgId, source, clientId, cipher, scopes, ts]);
  return { id, orgId, source, clientId, scopes, hasSecret: !!cipher, createdAt: ts, updatedAt: ts };
}
