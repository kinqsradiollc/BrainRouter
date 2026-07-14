import { Router } from "express";
import { z } from "zod";
import { MODEL_REASONING_EFFORTS } from "@kinqs/brainrouter-types";
import { memoryEngine } from "../../../memory/engine.js";
import { sendError } from "../../../contracts/http.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { probeModels } from "../../../providers/modelProbe.js";
import {
  modelPolicyInvariantError,
  type ProviderModelInput,
  type ProviderModelPatch,
  type ProviderModelRecord,
} from "../../../providers/modelPolicyStore.js";

const effortSchema = z.enum(MODEL_REASONING_EFFORTS);
const capabilitySourceSchema = z.enum(["verified", "discovered", "manual"]);
const httpsUrlSchema = z.string().url().refine((value) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}, { message: "sourceUrl must use HTTPS" });
const modelIdSchema = z.string().trim().min(1).max(160).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
  "must start with an alphanumeric character and contain only model-id characters",
);
const effortTargetsSchema = z.record(z.string().trim().min(1), z.string().trim().min(1));
const effortWireMapSchema = z.record(effortSchema, effortTargetsSchema);
const capabilitiesSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  responses: z.boolean(),
  reasoning: z.boolean(),
  reasoningMode: z.enum(["selectable", "adaptive"]).optional(),
  manualBudgetTokens: z.enum(["supported", "unsupported"]).optional(),
}).strict();

const createModelSchema = z.object({
  providerConfigId: z.string().trim().min(1),
  publicModelId: modelIdSchema,
  upstreamModelId: z.string().trim().min(1).max(300),
  displayName: z.string().trim().min(1).max(160),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().min(0).default(0),
  allowedEfforts: z.array(effortSchema).default([]),
  defaultEffort: effortSchema.nullable().default(null),
  effortWireMap: effortWireMapSchema.default({}),
  capabilities: capabilitiesSchema,
  capabilitySource: capabilitySourceSchema,
  sourceUrl: httpsUrlSchema.optional(),
  verifiedAt: z.string().datetime().optional(),
}).strict();

const patchModelSchema = z.object({
  providerConfigId: z.string().trim().min(1).optional(),
  publicModelId: modelIdSchema.optional(),
  upstreamModelId: z.string().trim().min(1).max(300).optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  allowedEfforts: z.array(effortSchema).optional(),
  defaultEffort: effortSchema.nullable().optional(),
  effortWireMap: effortWireMapSchema.optional(),
  capabilities: capabilitiesSchema.optional(),
  capabilitySource: capabilitySourceSchema.optional(),
  sourceUrl: httpsUrlSchema.nullable().optional(),
  verifiedAt: z.string().datetime().nullable().optional(),
}).strict();

const discoverSchema = z.object({ providerConfigId: z.string().trim().min(1) }).strict();
const reorderSchema = z.object({
  modelIds: z.array(z.string().trim().min(1)).min(1),
}).strict();

export const adminModelsRouter = Router();
adminModelsRouter.use(requireAnyAuth, requirePermission("models:manage"));

function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue?.message ?? "Invalid request"}`;
}

async function ownedProvider(orgId: string, id: string) {
  const provider = await memoryEngine.providers.getProviderConfig(id);
  return provider?.orgId === orgId ? provider : null;
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

function mergedInput(record: ProviderModelRecord, patch: ProviderModelPatch): ProviderModelInput {
  const merged = { ...recordAsInput(record), ...patch };
  if (patch.sourceUrl === null) delete merged.sourceUrl;
  if (patch.verifiedAt === null) delete merged.verifiedAt;
  return merged as ProviderModelInput;
}

function writeError(res: Parameters<typeof sendError>[0], error: unknown): void {
  const message = error instanceof Error ? error.message : "Model policy write failed";
  const duplicate = /unique|duplicate/i.test(message);
  sendError(res, duplicate ? 409 : 400, duplicate ? "publicModelId already exists in this organization" : message);
}

/** GET /api/admin/models — admin-safe routing policy, never provider credentials. */
adminModelsRouter.get("/", async (req: AuthedRequest, res) => {
  const models = await memoryEngine.models.listProviderModels(req.orgId!);
  res.json({ models });
});

/** POST /api/admin/models/discover — probe one org-owned provider without returning its key. */
adminModelsRouter.post("/discover", async (req: AuthedRequest, res) => {
  const parsed = discoverSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, 400, validationMessage(parsed.error)); return; }
  const provider = await ownedProvider(req.orgId!, parsed.data.providerConfigId);
  if (!provider || provider.kind !== "llm") { sendError(res, 404, "LLM provider config not found"); return; }
  const resolved = await memoryEngine.providers.getResolvedProvider(provider.id);
  if (!resolved) { sendError(res, 400, "Provider is disabled or unavailable"); return; }
  try {
    const models = await probeModels(resolved.endpoint, resolved.apiKey, "llm");
    res.json({
      models,
      selection: { mode: "explicit", upstreamModelIds: models },
    });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : "Failed to discover models");
  }
});

/** POST /api/admin/models/order — complete, unambiguous organization order. */
adminModelsRouter.post("/order", async (req: AuthedRequest, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, 400, validationMessage(parsed.error)); return; }
  try {
    await memoryEngine.models.reorderProviderModels(req.orgId!, parsed.data.modelIds);
    res.json({ ok: true });
  } catch (error) {
    writeError(res, error);
  }
});

/** POST /api/admin/models — create one explicit public-to-upstream model policy. */
adminModelsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createModelSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, 400, validationMessage(parsed.error)); return; }
  const provider = await ownedProvider(req.orgId!, parsed.data.providerConfigId);
  if (!provider || provider.kind !== "llm") { sendError(res, 404, "LLM provider config not found"); return; }

  const input: ProviderModelInput = parsed.data;
  const current = await memoryEngine.models.listProviderModels(req.orgId!);
  if (input.enabled && !current.some((model) => model.enabled && model.isDefault)) input.isDefault = true;
  const invariantError = modelPolicyInvariantError(input);
  if (invariantError) { sendError(res, 400, invariantError); return; }
  try {
    const model = await memoryEngine.models.createProviderModel(req.orgId!, input);
    res.status(201).json({ model });
  } catch (error) {
    writeError(res, error);
  }
});

async function ownedModel(orgId: string, id: string): Promise<ProviderModelRecord | null> {
  return memoryEngine.models.getProviderModel(orgId, id);
}

/** PATCH /api/admin/models/:id — validate the complete merged policy before writing. */
adminModelsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const existing = await ownedModel(req.orgId!, String(req.params.id));
  if (!existing) { sendError(res, 404, "Model policy not found"); return; }
  const parsed = patchModelSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, 400, validationMessage(parsed.error)); return; }
  const patch: ProviderModelPatch = parsed.data;

  const nextProvider = patch.providerConfigId
    ? await ownedProvider(req.orgId!, patch.providerConfigId)
    : null;
  if (patch.providerConfigId && (!nextProvider || nextProvider.kind !== "llm")) {
    sendError(res, 404, "LLM provider config not found");
    return;
  }
  if (existing.isDefault && (patch.enabled === false || patch.isDefault === false)) {
    sendError(res, 400, "Set another default model before disabling or demoting this model");
    return;
  }
  const merged = mergedInput(existing, patch);
  const current = await memoryEngine.models.listProviderModels(req.orgId!);
  if (merged.enabled && !current.some((model) => model.enabled && model.isDefault)) {
    patch.isDefault = true;
    merged.isDefault = true;
  }
  const invariantError = modelPolicyInvariantError(merged);
  if (invariantError) { sendError(res, 400, invariantError); return; }
  try {
    const model = await memoryEngine.models.updateProviderModel(req.orgId!, existing.id, patch);
    res.json({ model });
  } catch (error) {
    writeError(res, error);
  }
});

/** DELETE /api/admin/models/:id — defaults must be moved first. */
adminModelsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const existing = await ownedModel(req.orgId!, String(req.params.id));
  if (!existing) { sendError(res, 404, "Model policy not found"); return; }
  if (existing.isDefault) { sendError(res, 400, "Set another default model before deleting this model"); return; }
  const deleted = await memoryEngine.models.deleteProviderModel(req.orgId!, existing.id);
  if (!deleted) { sendError(res, 409, "The model became the default; move the default before deleting it"); return; }
  res.json({ ok: true });
});

/** POST /api/admin/models/:id/default — one enabled default per organization. */
adminModelsRouter.post("/:id/default", async (req: AuthedRequest, res) => {
  const changed = await memoryEngine.models.setDefaultProviderModel(req.orgId!, String(req.params.id));
  if (!changed) { sendError(res, 404, "Enabled model policy not found"); return; }
  res.json({ ok: true });
});
