/**
 * Provider-config SQL (ADR-010 P2). API keys are SEALED (secretBox) before they
 * hit the DB and decrypted only when a resolver hands them to a runtime service.
 * Record mappers deliberately drop the ciphertext — the key never leaves here.
 */
import { randomUUID } from "node:crypto";
import type { Executor } from "./executor.js";
import type {
  ProviderConfigRecord,
  ProviderConfigInput,
  ProviderKind,
  ResolvedProviderConfig,
} from "../../../../providers/types.js";
import { isProviderKind } from "../../../../providers/types.js";
import { seal, open } from "../../../../security/secretBox.js";

const COLS =
  "id, org_id, kind, provider_id, label, base_url, api_key_ciphertext, model, models_json, wire_format, reasoning_effort, extra_json, enabled, is_default, created_by, created_at, updated_at";

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : new Date(0).toISOString();
}
function parseJson<T>(v: unknown, fallback: T): T {
  try { return typeof v === "string" && v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}

/** Row → public record (NO key; `hasKey` reflects whether a ciphertext is stored). */
function rowToRecord(row: any): ProviderConfigRecord {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    kind: (isProviderKind(row.kind) ? row.kind : "llm") as ProviderKind,
    providerId: String(row.provider_id ?? ""),
    label: String(row.label ?? ""),
    baseUrl: String(row.base_url ?? ""),
    model: String(row.model ?? ""),
    models: parseJson<string[]>(row.models_json, []),
    wireFormat: String(row.wire_format ?? ""),
    reasoningEffort: String(row.reasoning_effort ?? ""),
    extra: parseJson<Record<string, unknown>>(row.extra_json, {}),
    enabled: row.enabled === true,
    isDefault: row.is_default === true,
    hasKey: typeof row.api_key_ciphertext === "string" && row.api_key_ciphertext.length > 0,
    createdBy: row.created_by ? String(row.created_by) : undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function getProviderConfig(exec: Executor, id: string): Promise<ProviderConfigRecord | null> {
  const row = await exec.one(`SELECT ${COLS} FROM provider_configs WHERE id = $1`, [id]);
  return row ? rowToRecord(row) : null;
}

export async function listProviderConfigs(
  exec: Executor,
  orgId: string,
  kind?: ProviderKind,
): Promise<ProviderConfigRecord[]> {
  const rows = kind
    ? await exec.rows(`SELECT ${COLS} FROM provider_configs WHERE org_id = $1 AND kind = $2 ORDER BY created_at ASC`, [orgId, kind])
    : await exec.rows(`SELECT ${COLS} FROM provider_configs WHERE org_id = $1 ORDER BY kind, created_at ASC`, [orgId]);
  return rows.map(rowToRecord);
}

export async function createProviderConfig(
  exec: Executor,
  orgId: string,
  input: ProviderConfigInput,
  createdBy?: string,
  now?: string,
): Promise<ProviderConfigRecord> {
  const id = `pc_${randomUUID()}`;
  const ts = now ?? new Date().toISOString();
  const cipher = input.apiKey ? seal(input.apiKey) : "";
  await exec.tx(async (client) => {
    if (input.isDefault) {
      await client.query(`UPDATE provider_configs SET is_default = false WHERE org_id = $1 AND kind = $2`, [orgId, input.kind]);
    }
    await client.query(
      `INSERT INTO provider_configs (id, org_id, kind, provider_id, label, base_url, api_key_ciphertext, model, models_json, wire_format, reasoning_effort, extra_json, enabled, is_default, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
      [
        id, orgId, input.kind, input.providerId ?? "", input.label ?? "", input.baseUrl ?? "", cipher,
        input.model ?? "", JSON.stringify(input.models ?? []), input.wireFormat ?? "", input.reasoningEffort ?? "",
        JSON.stringify(input.extra ?? {}), input.enabled ?? true, input.isDefault ?? false, createdBy ?? null, ts,
      ],
    );
  });
  return (await getProviderConfig(exec, id))!;
}

export async function updateProviderConfig(
  exec: Executor,
  id: string,
  patch: Partial<ProviderConfigInput>,
  now?: string,
): Promise<ProviderConfigRecord | null> {
  const existing = await exec.one(`SELECT org_id, kind FROM provider_configs WHERE id = $1`, [id]);
  if (!existing) return null;
  const ts = now ?? new Date().toISOString();
  const sets: string[] = [];
  const params: any[] = [];
  let i = 1;
  const set = (col: string, val: any) => { sets.push(`${col} = $${i++}`); params.push(val); };
  if (patch.providerId !== undefined) set("provider_id", patch.providerId);
  if (patch.label !== undefined) set("label", patch.label);
  if (patch.baseUrl !== undefined) set("base_url", patch.baseUrl);
  if (patch.apiKey !== undefined) set("api_key_ciphertext", patch.apiKey ? seal(patch.apiKey) : "");
  if (patch.model !== undefined) set("model", patch.model);
  if (patch.models !== undefined) set("models_json", JSON.stringify(patch.models));
  if (patch.wireFormat !== undefined) set("wire_format", patch.wireFormat);
  if (patch.reasoningEffort !== undefined) set("reasoning_effort", patch.reasoningEffort);
  if (patch.extra !== undefined) set("extra_json", JSON.stringify(patch.extra));
  if (patch.enabled !== undefined) set("enabled", patch.enabled);
  set("updated_at", ts);

  await exec.tx(async (client) => {
    if (patch.isDefault === true) {
      await client.query(`UPDATE provider_configs SET is_default = false WHERE org_id = $1 AND kind = $2`, [existing.org_id, existing.kind]);
      sets.push(`is_default = true`);
    } else if (patch.isDefault === false) {
      sets.push(`is_default = false`);
    }
    await client.query(`UPDATE provider_configs SET ${sets.join(", ")} WHERE id = $${i}`, [...params, id]);
  });
  return getProviderConfig(exec, id);
}

export async function deleteProviderConfig(exec: Executor, id: string): Promise<void> {
  await exec.run(`DELETE FROM provider_configs WHERE id = $1`, [id]);
}

export async function setDefaultProvider(exec: Executor, orgId: string, kind: ProviderKind, id: string): Promise<void> {
  await exec.tx(async (client) => {
    await client.query(`UPDATE provider_configs SET is_default = false WHERE org_id = $1 AND kind = $2`, [orgId, kind]);
    await client.query(`UPDATE provider_configs SET is_default = true, updated_at = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, new Date().toISOString()]);
  });
}

/**
 * The resolved, DECRYPTED default provider for (org, kind): the `is_default`
 * enabled row, else the first enabled row. Returns null when the org has none
 * (the caller then treats that service as unconfigured — no env fallback; the
 * one-time env→DB seed is the only env path). The api key is opened here — the
 * only place a stored key is decrypted.
 */
export async function getDefaultResolvedProvider(
  exec: Executor,
  orgId: string,
  kind: ProviderKind,
): Promise<ResolvedProviderConfig | null> {
  const row =
    (await exec.one(`SELECT ${COLS} FROM provider_configs WHERE org_id = $1 AND kind = $2 AND enabled AND is_default LIMIT 1`, [orgId, kind])) ??
    (await exec.one(`SELECT ${COLS} FROM provider_configs WHERE org_id = $1 AND kind = $2 AND enabled ORDER BY created_at ASC LIMIT 1`, [orgId, kind]));
  if (!row) return null;
  const rec = rowToRecord(row);
  const cipher = String(row.api_key_ciphertext ?? "");
  return {
    kind: rec.kind,
    endpoint: rec.baseUrl,
    apiKey: cipher ? open(cipher) : "",
    model: rec.model,
    models: rec.models,
    wireFormat: rec.wireFormat || undefined,
    reasoningEffort: rec.reasoningEffort || undefined,
    extra: rec.extra,
    source: "db",
  };
}

/** Decrypt one enabled provider config selected by a role assignment. */
export async function getResolvedProvider(exec: Executor, id: string): Promise<ResolvedProviderConfig | null> {
  const row = await exec.one(`SELECT ${COLS} FROM provider_configs WHERE id = $1 AND enabled`, [id]);
  if (!row) return null;
  const rec = rowToRecord(row);
  const cipher = String(row.api_key_ciphertext ?? "");
  return { kind: rec.kind, endpoint: rec.baseUrl, apiKey: cipher ? open(cipher) : "", model: rec.model, models: rec.models, wireFormat: rec.wireFormat || undefined, reasoningEffort: rec.reasoningEffort || undefined, extra: rec.extra, source: "db" };
}
