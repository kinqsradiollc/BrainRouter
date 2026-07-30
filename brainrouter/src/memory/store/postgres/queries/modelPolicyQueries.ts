import { randomUUID } from "node:crypto";
import type {
  ModelEffortWireMap,
  ProviderModelInput,
  ProviderModelPatch,
  ProviderModelRecord,
  StoredCapabilitySource,
  StoredModelCapabilities,
} from "../../../../providers/modelPolicyStore.js";
import {
  isModelReasoningEffort,
  modelPolicyInvariantError,
} from "../../../../providers/modelPolicyStore.js";
import type { Executor } from "./executor.js";

export function modelGatewayServicePrincipalId(orgId: string): string {
  return `brain-worker:${orgId}`;
}

/**
 * Ensure one deterministic principal per organization. The id embeds the org
 * solely for stable lookup; the gateway still re-checks the persisted org and
 * active scopes on every request.
 */
export async function ensureModelGatewayServicePrincipal(
  exec: Executor,
  orgId: string,
): Promise<string> {
  const id = modelGatewayServicePrincipalId(orgId);
  await exec.run(
    `INSERT INTO model_gateway_service_principals
       (id, org_id, label, active, scopes_json, created_at, updated_at)
     VALUES ($1, $2, 'Brain/worker model egress', true, '["models:invoke"]', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [id, orgId],
  );
  const principal = await exec.one<{ org_id: string; active: boolean; scopes_json: string }>(
    `SELECT org_id, active, scopes_json
       FROM model_gateway_service_principals
      WHERE id = $1`,
    [id],
  );
  if (!principal || principal.org_id !== orgId || !principal.active) {
    throw new Error("The organization model-gateway service principal is unavailable");
  }
  let scopes: unknown;
  try { scopes = JSON.parse(principal.scopes_json); } catch { scopes = []; }
  if (!Array.isArray(scopes) || !scopes.includes("models:invoke")) {
    throw new Error("The organization model-gateway service principal lacks models:invoke");
  }
  return id;
}

const COLS = `id, org_id, provider_config_id, public_model_id, upstream_model_id,
  display_name, enabled, is_default, sort_order, allowed_efforts_json,
  default_effort, effort_wire_map_json, capabilities_json, capability_source,
  source_url, verified_at, created_at, updated_at`;

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value ? value : new Date(0).toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" && value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function parseCapabilities(value: unknown): StoredModelCapabilities {
  const raw = parseJson<Record<string, unknown>>(value, {});
  return {
    streaming: raw.streaming === true,
    tools: raw.tools === true,
    responses: raw.responses === true,
    reasoning: raw.reasoning === true,
    ...(raw.reasoningMode === "selectable" || raw.reasoningMode === "adaptive"
      ? { reasoningMode: raw.reasoningMode }
      : {}),
    ...(raw.manualBudgetTokens === "supported" || raw.manualBudgetTokens === "unsupported"
      ? { manualBudgetTokens: raw.manualBudgetTokens }
      : {}),
  };
}

function rowToProviderModel(row: Record<string, unknown>): ProviderModelRecord {
  const allowedEfforts = [...new Set(
    parseJson<unknown[]>(row.allowed_efforts_json, []).filter(isModelReasoningEffort),
  )];
  const rawDefault = String(row.default_effort ?? "");
  const source = String(row.capability_source ?? "manual");
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    providerConfigId: String(row.provider_config_id),
    publicModelId: String(row.public_model_id),
    upstreamModelId: String(row.upstream_model_id),
    displayName: String(row.display_name),
    enabled: row.enabled === true,
    isDefault: row.is_default === true,
    sortOrder: Number(row.sort_order ?? 0),
    allowedEfforts,
    defaultEffort: isModelReasoningEffort(rawDefault) ? rawDefault : null,
    effortWireMap: parseJson<ModelEffortWireMap>(row.effort_wire_map_json, {}),
    capabilities: parseCapabilities(row.capabilities_json),
    capabilitySource: (["verified", "discovered", "manual"] as const).includes(
      source as StoredCapabilitySource,
    ) ? source as StoredCapabilitySource : "manual",
    ...(row.source_url ? { sourceUrl: String(row.source_url) } : {}),
    ...(row.verified_at ? { verifiedAt: toIso(row.verified_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function listProviderModels(
  exec: Executor,
  orgId: string,
  enabledOnly = false,
): Promise<ProviderModelRecord[]> {
  const enabledClause = enabledOnly ? " AND enabled" : "";
  const rows = await exec.rows(
    `SELECT ${COLS} FROM provider_models
     WHERE org_id = $1${enabledClause}
     ORDER BY sort_order ASC, display_name ASC, id ASC`,
    [orgId],
  );
  return rows.map(rowToProviderModel);
}

export async function getProviderModel(
  exec: Executor,
  orgId: string,
  id: string,
): Promise<ProviderModelRecord | null> {
  const row = await exec.one(
    `SELECT ${COLS} FROM provider_models WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
  return row ? rowToProviderModel(row) : null;
}

export async function getProviderModelByPublicId(
  exec: Executor,
  orgId: string,
  publicModelId: string,
  enabledOnly = false,
): Promise<ProviderModelRecord | null> {
  const row = await exec.one(
    `SELECT ${COLS} FROM provider_models
     WHERE org_id = $1 AND public_model_id = $2${enabledOnly ? " AND enabled" : ""}`,
    [orgId, publicModelId],
  );
  return row ? rowToProviderModel(row) : null;
}

function insertParams(orgId: string, id: string, input: ProviderModelInput, now: string): unknown[] {
  return [
    id,
    orgId,
    input.providerConfigId,
    input.publicModelId,
    input.upstreamModelId,
    input.displayName,
    input.enabled,
    input.isDefault,
    input.sortOrder,
    JSON.stringify(input.allowedEfforts),
    input.defaultEffort ?? "",
    JSON.stringify(input.effortWireMap),
    JSON.stringify(input.capabilities),
    input.capabilitySource,
    input.sourceUrl ?? null,
    input.verifiedAt ?? null,
    now,
  ];
}

function recordAsInput(record: ProviderModelRecord): ProviderModelInput {
  return {
    providerConfigId: record.providerConfigId,
    publicModelId: record.publicModelId,
    upstreamModelId: record.upstreamModelId,
    displayName: record.displayName,
    enabled: record.enabled,
    isDefault: record.isDefault,
    sortOrder: record.sortOrder,
    allowedEfforts: record.allowedEfforts,
    defaultEffort: record.defaultEffort,
    effortWireMap: record.effortWireMap,
    capabilities: record.capabilities,
    capabilitySource: record.capabilitySource,
    ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
    ...(record.verifiedAt ? { verifiedAt: record.verifiedAt } : {}),
  };
}

function assertPolicyInvariants(input: ProviderModelInput): void {
  const error = modelPolicyInvariantError(input);
  if (error) throw new Error(error);
}

export async function createProviderModel(
  exec: Executor,
  orgId: string,
  input: ProviderModelInput,
  now = new Date().toISOString(),
): Promise<ProviderModelRecord> {
  assertPolicyInvariants(input);
  const id = `pm_${randomUUID()}`;
  const sql = `INSERT INTO provider_models (
      id, org_id, provider_config_id, public_model_id, upstream_model_id,
      display_name, enabled, is_default, sort_order, allowed_efforts_json,
      default_effort, effort_wire_map_json, capabilities_json, capability_source,
      source_url, verified_at, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17
    )`;
  const params = insertParams(orgId, id, input, now);
  if (input.isDefault) {
    await exec.tx(async (client) => {
      await client.query("UPDATE provider_models SET is_default = false WHERE org_id = $1", [orgId]);
      await client.query(sql, params);
    });
  } else {
    await exec.run(sql, params);
  }
  const created = await getProviderModel(exec, orgId, id);
  if (!created) throw new Error("Created model policy could not be loaded");
  return created;
}

export async function updateProviderModel(
  exec: Executor,
  orgId: string,
  id: string,
  patch: ProviderModelPatch,
  now = new Date().toISOString(),
): Promise<ProviderModelRecord | null> {
  const existing = await getProviderModel(exec, orgId, id);
  if (!existing) return null;
  const merged = { ...recordAsInput(existing), ...patch };
  if (patch.sourceUrl === null) delete merged.sourceUrl;
  if (patch.verifiedAt === null) delete merged.verifiedAt;
  assertPolicyInvariants(merged as ProviderModelInput);
  if (existing.isDefault && (patch.enabled === false || patch.isDefault === false)) {
    throw new Error("Set another default model before disabling or demoting this model");
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.providerConfigId !== undefined) set("provider_config_id", patch.providerConfigId);
  if (patch.publicModelId !== undefined) set("public_model_id", patch.publicModelId);
  if (patch.upstreamModelId !== undefined) set("upstream_model_id", patch.upstreamModelId);
  if (patch.displayName !== undefined) set("display_name", patch.displayName);
  if (patch.enabled !== undefined) set("enabled", patch.enabled);
  if (patch.isDefault === true) sets.push("is_default = true");
  if (patch.isDefault === false) set("is_default", false);
  if (patch.sortOrder !== undefined) set("sort_order", patch.sortOrder);
  if (patch.allowedEfforts !== undefined) set("allowed_efforts_json", JSON.stringify(patch.allowedEfforts));
  if (patch.defaultEffort !== undefined) set("default_effort", patch.defaultEffort ?? "");
  if (patch.effortWireMap !== undefined) set("effort_wire_map_json", JSON.stringify(patch.effortWireMap));
  if (patch.capabilities !== undefined) set("capabilities_json", JSON.stringify(patch.capabilities));
  if (patch.capabilitySource !== undefined) set("capability_source", patch.capabilitySource);
  if (patch.sourceUrl !== undefined) set("source_url", patch.sourceUrl);
  if (patch.verifiedAt !== undefined) set("verified_at", patch.verifiedAt);
  set("updated_at", now);
  params.push(id, orgId);
  const update = `UPDATE provider_models SET ${sets.join(", ")}
    WHERE id = $${params.length - 1} AND org_id = $${params.length}`;

  if (patch.isDefault === true) {
    await exec.tx(async (client) => {
      await client.query("UPDATE provider_models SET is_default = false WHERE org_id = $1", [orgId]);
      const result = await client.query(update, params);
      if (result.rowCount !== 1) throw new Error("Model policy not found");
    });
  } else {
    await exec.run(update, params);
  }
  return getProviderModel(exec, orgId, id);
}

export async function deleteProviderModel(
  exec: Executor,
  orgId: string,
  id: string,
): Promise<boolean> {
  return (await exec.run(
    "DELETE FROM provider_models WHERE id = $1 AND org_id = $2 AND NOT is_default",
    [id, orgId],
  )) > 0;
}

export async function setDefaultProviderModel(
  exec: Executor,
  orgId: string,
  id: string,
  now = new Date().toISOString(),
): Promise<boolean> {
  const target = await exec.one(
    "SELECT id FROM provider_models WHERE id = $1 AND org_id = $2 AND enabled",
    [id, orgId],
  );
  if (!target) return false;
  await exec.tx(async (client) => {
    await client.query("UPDATE provider_models SET is_default = false WHERE org_id = $1", [orgId]);
    const result = await client.query(
      "UPDATE provider_models SET is_default = true, updated_at = $3 WHERE id = $1 AND org_id = $2 AND enabled",
      [id, orgId, now],
    );
    if (result.rowCount !== 1) throw new Error("Enabled model policy not found");
  });
  return true;
}

export async function reorderProviderModels(
  exec: Executor,
  orgId: string,
  ids: readonly string[],
): Promise<void> {
  const current = await exec.rows<{ id: string }>(
    "SELECT id FROM provider_models WHERE org_id = $1 ORDER BY id",
    [orgId],
  );
  const currentIds = current.map((row) => String(row.id)).sort();
  const requested = [...ids].sort();
  if (new Set(ids).size !== ids.length
      || currentIds.length !== requested.length
      || currentIds.some((id, index) => id !== requested[index])) {
    throw new Error("modelIds must contain every organization model exactly once");
  }
  const now = new Date().toISOString();
  await exec.tx(async (client) => {
    for (const [sortOrder, id] of ids.entries()) {
      await client.query(
        "UPDATE provider_models SET sort_order = $1, updated_at = $2 WHERE id = $3 AND org_id = $4",
        [sortOrder, now, id, orgId],
      );
    }
  });
}
