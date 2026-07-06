/**
 * Integration-config SQL (ADR-010 P6). The secret bundle (App private key +
 * webhook secret) is sealed with secretBox before it hits the DB and opened only
 * when the ingress resolver needs it. Public records drop the ciphertext.
 */
import { randomUUID } from "node:crypto";
import type { Executor } from "./executor.js";
import type {
  IntegrationConfigRecord,
  IntegrationConfigInput,
  IntegrationKind,
  ResolvedIntegration,
} from "../../../../integrations/types.js";
import { isIntegrationKind } from "../../../../integrations/types.js";
import { seal, open } from "../../../../security/secretBox.js";

const COLS = "id, org_id, kind, enabled, config_json, secret_ciphertext, created_by, created_at, updated_at";

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : new Date(0).toISOString();
}
function parseObj(v: unknown): Record<string, unknown> {
  try { return typeof v === "string" && v ? (JSON.parse(v) as Record<string, unknown>) : {}; } catch { return {}; }
}

function rowToRecord(row: any): IntegrationConfigRecord {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    kind: (isIntegrationKind(row.kind) ? row.kind : "github_app") as IntegrationKind,
    enabled: row.enabled === true,
    config: parseObj(row.config_json),
    hasSecret: typeof row.secret_ciphertext === "string" && row.secret_ciphertext.length > 0,
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function getIntegrationConfig(exec: Executor, id: string): Promise<IntegrationConfigRecord | null> {
  const row = await exec.one(`SELECT ${COLS} FROM integration_configs WHERE id = $1`, [id]);
  return row ? rowToRecord(row) : null;
}

export async function listIntegrationConfigs(exec: Executor, orgId: string, kind?: IntegrationKind): Promise<IntegrationConfigRecord[]> {
  const rows = kind
    ? await exec.rows(`SELECT ${COLS} FROM integration_configs WHERE org_id = $1 AND kind = $2 ORDER BY created_at ASC`, [orgId, kind])
    : await exec.rows(`SELECT ${COLS} FROM integration_configs WHERE org_id = $1 ORDER BY kind, created_at ASC`, [orgId]);
  return rows.map(rowToRecord);
}

export async function createIntegrationConfig(exec: Executor, orgId: string, input: IntegrationConfigInput, createdBy?: string, now?: string): Promise<IntegrationConfigRecord> {
  const id = `int_${randomUUID()}`;
  const ts = now ?? new Date().toISOString();
  const cipher = input.secret && Object.keys(input.secret).length > 0 ? seal(JSON.stringify(input.secret)) : "";
  await exec.run(
    `INSERT INTO integration_configs (id, org_id, kind, enabled, config_json, secret_ciphertext, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
    [id, orgId, input.kind, input.enabled ?? true, JSON.stringify(input.config ?? {}), cipher, createdBy ?? null, ts],
  );
  return (await getIntegrationConfig(exec, id))!;
}

export async function updateIntegrationConfig(exec: Executor, id: string, patch: Partial<IntegrationConfigInput>, now?: string): Promise<IntegrationConfigRecord | null> {
  const existing = await exec.one(`SELECT id FROM integration_configs WHERE id = $1`, [id]);
  if (!existing) return null;
  const ts = now ?? new Date().toISOString();
  const sets: string[] = [];
  const params: any[] = [];
  let i = 1;
  const set = (col: string, val: any) => { sets.push(`${col} = $${i++}`); params.push(val); };
  if (patch.enabled !== undefined) set("enabled", patch.enabled);
  if (patch.config !== undefined) set("config_json", JSON.stringify(patch.config));
  if (patch.secret !== undefined) set("secret_ciphertext", Object.keys(patch.secret).length > 0 ? seal(JSON.stringify(patch.secret)) : "");
  set("updated_at", ts);
  await exec.run(`UPDATE integration_configs SET ${sets.join(", ")} WHERE id = $${i}`, [...params, id]);
  return getIntegrationConfig(exec, id);
}

export async function deleteIntegrationConfig(exec: Executor, id: string): Promise<void> {
  await exec.run(`DELETE FROM integration_configs WHERE id = $1`, [id]);
}

/**
 * The DECRYPTED default integration for (org, kind): the first enabled row, with
 * its secret opened. Null when none. The only place a stored integration secret
 * is decrypted (the trigger ingress resolver calls this).
 */
function resolveRow(row: any): ResolvedIntegration {
  const rec = rowToRecord(row);
  const cipher = String(row.secret_ciphertext ?? "");
  let secret: Record<string, string> = {};
  if (cipher) { try { secret = JSON.parse(open(cipher)) as Record<string, string>; } catch { secret = {}; } }
  return { kind: rec.kind, config: rec.config, secret };
}

export async function getResolvedIntegration(exec: Executor, orgId: string, kind: IntegrationKind): Promise<ResolvedIntegration | null> {
  const row = await exec.one(`SELECT ${COLS} FROM integration_configs WHERE org_id = $1 AND kind = $2 AND enabled ORDER BY created_at ASC LIMIT 1`, [orgId, kind]);
  return row ? resolveRow(row) : null;
}

/**
 * ADR-010 P6b — resolve the tenant + decrypted integration from a GitHub App
 * installation id (the webhook's routing key). Cross-org lookup by the
 * installationId stored in config_json — the ONLY id-based cross-org query, used
 * by the stateless webhook ingress before it trusts anything.
 */
export async function findIntegrationByInstallation(
  exec: Executor,
  kind: IntegrationKind,
  installationId: string,
): Promise<(ResolvedIntegration & { orgId: string }) | null> {
  const row = await exec.one(
    `SELECT ${COLS} FROM integration_configs
      WHERE kind = $1 AND enabled AND (config_json::jsonb ->> 'installationId') = $2
      ORDER BY created_at ASC LIMIT 1`,
    [kind, installationId],
  );
  if (!row) return null;
  return { orgId: String(row.org_id), ...resolveRow(row) };
}
