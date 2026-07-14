"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelPolicy, ModelReasoningEffort } from "@kinqs/brainrouter-types";

import { PremiumButton } from "../../components/PremiumButton";
import { PremiumCard } from "../../components/PremiumCard";
import {
  adminApi,
  type ManagedModelInput,
  type ManagedModelRecord,
  type ProviderConfig,
} from "../../lib/adminApi";
import {
  MANAGED_MODEL_EFFORTS,
  effortWireMap,
  managedModelDraftError,
  type EffortWirePreset,
} from "./managedModelForm";

function newDraft(providerConfigId = ""): ManagedModelInput {
  return {
    providerConfigId,
    publicModelId: "",
    upstreamModelId: "",
    displayName: "",
    enabled: true,
    isDefault: false,
    sortOrder: 0,
    allowedEfforts: [],
    defaultEffort: null,
    effortWireMap: {},
    capabilities: {
      streaming: true,
      tools: true,
      responses: true,
      reasoning: false,
      reasoningMode: "selectable",
    },
    capabilitySource: "manual",
  };
}

function recordDraft(record: ManagedModelRecord): ManagedModelInput {
  const { id: _id, orgId: _orgId, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = record;
  return input;
}

function detectPreset(record: ManagedModelRecord): EffortWirePreset {
  const paths = Object.values(record.effortWireMap).flatMap((targets) => Object.keys(targets ?? {}));
  if (paths.some((path) => path.startsWith("output_config."))) return "anthropic-messages";
  if (paths.some((path) => path.startsWith("reasoning."))) return "openai-responses";
  return "openai-chat";
}

function provenanceLabel(model: ModelPolicy): string {
  const date = model.provenance.verifiedAt?.slice(0, 10);
  return `${model.provenance.source === "verified" ? "Verified" : model.provenance.source === "discovered" ? "Discovered" : "Manual"}${date ? ` ${date}` : ""}`;
}

function policyForAdminRecord(record: ManagedModelRecord): ModelPolicy {
  return {
    id: record.publicModelId,
    label: record.displayName,
    provider: "brainrouter",
    enabled: record.enabled,
    capabilities: {
      streaming: record.capabilities.streaming,
      tools: record.capabilities.tools,
      responses: record.capabilities.responses,
      reasoning: record.capabilities.reasoning,
    },
    reasoning: record.capabilities.reasoning && record.allowedEfforts.length > 0 ? {
      default: record.defaultEffort,
      allowed: record.allowedEfforts.map((id) => ({ id, label: id === "xhigh" ? "Extra high" : `${id.slice(0, 1).toUpperCase()}${id.slice(1)}` })),
      source: record.capabilitySource,
      mode: record.capabilities.reasoningMode ?? "selectable",
      ...(record.capabilities.manualBudgetTokens
        ? { manualBudgetTokens: record.capabilities.manualBudgetTokens }
        : {}),
    } : null,
    provenance: {
      source: record.capabilitySource,
      ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
      ...(record.verifiedAt ? { verifiedAt: record.verifiedAt } : {}),
    },
    revision: `admin:${record.id}:${record.updatedAt}`,
  };
}

export function ManagedModelsPanel({ providers }: { providers: ProviderConfig[] }) {
  const llmProviders = useMemo(() => providers.filter((provider) => provider.kind === "llm"), [providers]);
  const [catalog, setCatalog] = useState<ModelPolicy[]>([]);
  const [adminModels, setAdminModels] = useState<ManagedModelRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedModelRecord | null>(null);
  const [draft, setDraft] = useState<ManagedModelInput>(() => newDraft());
  const [preset, setPreset] = useState<EffortWirePreset>("openai-chat");
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [formError, setFormError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const safe = await adminApi.modelCatalog();
      setCatalog([...safe.models]);
      try {
        const managed = await adminApi.listManagedModels();
        setAdminModels(managed.models ?? []);
      } catch {
        // models:read is intentionally broader than models:manage. A member sees
        // the safe catalog and no upstream custody/configuration controls.
        setAdminModels(null);
      }
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load the model catalog.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function showCreate() {
    setEditing(null);
    setDraft(newDraft(llmProviders[0]?.id));
    setPreset("openai-chat");
    setDiscovered([]);
    setFormError("");
    setOpen(true);
  }

  function showEdit(record: ManagedModelRecord) {
    setEditing(record);
    setDraft(recordDraft(record));
    setPreset(detectPreset(record));
    setDiscovered([]);
    setFormError("");
    setOpen(true);
  }

  function setEffort(effort: ModelReasoningEffort, checked: boolean) {
    setDraft((current) => {
      const allowedEfforts = checked
        ? [...new Set([...current.allowedEfforts, effort])]
        : current.allowedEfforts.filter((value) => value !== effort);
      return {
        ...current,
        allowedEfforts,
        defaultEffort: current.defaultEffort && allowedEfforts.includes(current.defaultEffort)
          ? current.defaultEffort
          : null,
        effortWireMap: effortWireMap(allowedEfforts, preset),
      };
    });
  }

  function changePreset(next: EffortWirePreset) {
    setPreset(next);
    setDraft((current) => ({
      ...current,
      effortWireMap: effortWireMap(current.allowedEfforts, next),
    }));
  }

  async function discover() {
    if (!draft.providerConfigId) return;
    setBusy("discover");
    setFormError("");
    try {
      const result = await adminApi.discoverManagedModels(draft.providerConfigId);
      setDiscovered(result.selection.upstreamModelIds);
      const first = result.selection.upstreamModelIds[0];
      if (first && !draft.upstreamModelId) {
        setDraft((current) => ({
          ...current,
          upstreamModelId: first,
          publicModelId: first,
          displayName: first,
          capabilitySource: "discovered",
        }));
      }
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Unable to discover models.");
    } finally {
      setBusy("");
    }
  }

  function chooseDiscovered(id: string) {
    setDraft((current) => ({
      ...current,
      upstreamModelId: id,
      publicModelId: current.publicModelId || id,
      displayName: current.displayName || id,
      capabilitySource: current.capabilitySource === "verified" ? "verified" : "discovered",
    }));
  }

  async function save() {
    const validation = managedModelDraftError(draft);
    if (validation) { setFormError(validation); return; }
    setBusy("save");
    setFormError("");
    try {
      if (editing) await adminApi.updateManagedModel(editing.id, draft);
      else await adminApi.createManagedModel(draft);
      setOpen(false);
      await load();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Unable to save model policy.");
    } finally {
      setBusy("");
    }
  }

  async function makeDefault(id: string) {
    setBusy(`default:${id}`);
    try { await adminApi.setDefaultManagedModel(id); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to change the default model."); }
    finally { setBusy(""); }
  }

  async function remove(record: ManagedModelRecord) {
    if (record.isDefault) return;
    setBusy(`delete:${record.id}`);
    try { await adminApi.deleteManagedModel(record.id); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to remove the model."); }
    finally { setBusy(""); }
  }

  const adminByPublicId = new Map((adminModels ?? []).map((record) => [record.publicModelId, record]));
  const displayedCatalog = adminModels === null
    ? catalog
    : adminModels.map((record) => catalog.find((model) => model.id === record.publicModelId) ?? policyForAdminRecord(record));

  return (
    <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
      <div className="settings-cardhead">
        <div>
          <h3>Managed models</h3>
          <div className="settings-hint">BrainRouter hosts these models for the active organization. Exact effort policy comes from the server.</div>
        </div>
        {adminModels !== null && <PremiumButton size="small" variant="primary" onClick={showCreate}>Add model</PremiumButton>}
      </div>

      {adminModels === null && !loading && (
        <div className="settings-note">Read only. An organization administrator controls upstream routing and allowed efforts.</div>
      )}
      {error && <div className="settings-note settings-note--error">{error}</div>}
      {loading ? <div className="settings-empty-inline">Loading managed models…</div>
        : displayedCatalog.length === 0 ? <div className="settings-empty-inline">No managed model is configured for this organization.</div>
          : displayedCatalog.map((model) => {
            const admin = adminByPublicId.get(model.id);
            return (
              <div key={model.id} className="org-member managed-model-row">
                <div className="org-member__id" style={{ whiteSpace: "normal" }}>
                  <strong>{model.label}</strong>
                  <div className="settings-hint">
                    {model.id} · {admin?.isDefault ? "Default · " : ""}{model.enabled ? "Enabled" : "Disabled"} · {provenanceLabel(model)}
                  </div>
                  <div className="managed-model-efforts">
                    {model.reasoning?.allowed.length
                      ? model.reasoning.allowed.map((effort) => <span key={effort.id} className="settings-badge settings-badge--muted">{effort.label}{model.reasoning?.default === effort.id ? " (default)" : ""}</span>)
                      : <span className="settings-hint">No reasoning-effort selector</span>}
                  </div>
                </div>
                {admin && (
                  <div className="settings-actions">
                    {!admin.isDefault && <PremiumButton size="small" variant="ghost" disabled={busy === `default:${admin.id}`} onClick={() => void makeDefault(admin.id)}>Make default</PremiumButton>}
                    <PremiumButton size="small" variant="text" onClick={() => showEdit(admin)}>Configure</PremiumButton>
                    <button type="button" className="org-iconbtn" disabled={admin.isDefault || busy === `delete:${admin.id}`} title={admin.isDefault ? "Move the default before removing" : "Remove model"} aria-label={`Remove ${model.label}`} onClick={() => void remove(admin)}>✕</button>
                  </div>
                )}
              </div>
            );
          })}

      {open && typeof document !== "undefined" && createPortal((
        <div className="prov-overlay" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <div className="prov-dialog" role="dialog" aria-modal="true" aria-labelledby="managed-model-dialog-title">
            <div className="prov-dialog__head">
              <div>
                <h3 id="managed-model-dialog-title" style={{ margin: 0 }}>{editing ? `Configure ${editing.displayName}` : "Add managed model"}</h3>
                <div className="settings-hint">Public metadata is separated from upstream custody.</div>
              </div>
              <button type="button" className="org-iconbtn" onClick={() => setOpen(false)} aria-label="Close" style={{ marginLeft: "auto" }}>✕</button>
            </div>
            <div className="prov-dialog__body">
              <label className="settings-label">Upstream provider
                <div className="managed-model-provider-line">
                  <select className="settings-select" value={draft.providerConfigId} onChange={(event) => setDraft({ ...draft, providerConfigId: event.target.value })}>
                    <option value="">Choose provider</option>
                    {llmProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label || provider.providerId}</option>)}
                  </select>
                  <PremiumButton size="small" variant="ghost" disabled={!draft.providerConfigId || busy === "discover"} onClick={() => void discover()}>{busy === "discover" ? "Discovering…" : "Discover"}</PremiumButton>
                </div>
              </label>
              {discovered.length > 0 && <label className="settings-label">Discovered upstream model
                <select className="settings-select" value={draft.upstreamModelId} onChange={(event) => chooseDiscovered(event.target.value)}>
                  <option value="">Choose model</option>
                  {discovered.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>}
              <div className="settings-grid">
                <label className="settings-label">Public model ID
                  <input className="settings-input" value={draft.publicModelId} onChange={(event) => setDraft({ ...draft, publicModelId: event.target.value })} placeholder="gpt-5.6-sol" />
                </label>
                <label className="settings-label">Upstream model ID
                  <input className="settings-input" value={draft.upstreamModelId} onChange={(event) => setDraft({ ...draft, upstreamModelId: event.target.value })} placeholder="provider model id" />
                </label>
              </div>
              <label className="settings-label">Display name
                <input className="settings-input" value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder="GPT-5.6 Sol" />
              </label>

              <div className="settings-checks managed-model-capabilities">
                {(["streaming", "tools", "responses", "reasoning"] as const).map((capability) => (
                  <label key={capability} className="settings-check">
                    <input type="checkbox" checked={draft.capabilities[capability]} onChange={(event) => setDraft((current) => ({
                      ...current,
                      capabilities: { ...current.capabilities, [capability]: event.target.checked },
                      ...(capability === "reasoning" && !event.target.checked
                        ? { allowedEfforts: [], defaultEffort: null, effortWireMap: {} }
                        : {}),
                    }))} /> {capability}
                  </label>
                ))}
              </div>

              {draft.capabilities.reasoning && <>
                <label className="settings-label">Upstream effort mapping
                  <select className="settings-select" value={preset} onChange={(event) => changePreset(event.target.value as EffortWirePreset)}>
                    <option value="openai-chat">OpenAI Chat · reasoning_effort</option>
                    <option value="openai-responses">OpenAI Responses · reasoning.effort</option>
                    <option value="anthropic-messages">Anthropic Messages · output_config.effort</option>
                  </select>
                </label>
                <div className="settings-label">Allowed efforts
                  <div className="managed-model-effort-grid">
                    {MANAGED_MODEL_EFFORTS.map((effort) => <label key={effort} className="settings-check"><input type="checkbox" checked={draft.allowedEfforts.includes(effort)} onChange={(event) => setEffort(effort, event.target.checked)} /> {effort}</label>)}
                  </div>
                </div>
                <label className="settings-label">Default effort
                  <select className="settings-select" value={draft.defaultEffort ?? ""} onChange={(event) => setDraft({ ...draft, defaultEffort: (event.target.value || null) as ModelReasoningEffort | null })}>
                    <option value="">Provider default</option>
                    {draft.allowedEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                  </select>
                </label>
              </>}

              <div className="settings-grid">
                <label className="settings-label">Capability source
                  <select className="settings-select" value={draft.capabilitySource} onChange={(event) => setDraft({ ...draft, capabilitySource: event.target.value as ManagedModelInput["capabilitySource"] })}>
                    <option value="manual">Manual</option>
                    <option value="discovered">Discovered</option>
                    <option value="verified">Verified</option>
                  </select>
                </label>
                <label className="settings-label">Verification time
                  <input className="settings-input" value={draft.verifiedAt ?? ""} onChange={(event) => setDraft({ ...draft, verifiedAt: event.target.value || undefined })} placeholder="2026-07-14T00:00:00Z" />
                </label>
              </div>
              <label className="settings-label">Source URL
                <input className="settings-input" value={draft.sourceUrl ?? ""} onChange={(event) => setDraft({ ...draft, sourceUrl: event.target.value || undefined })} placeholder="https://provider.example/model-docs" />
              </label>
              <div className="settings-checks">
                <label className="settings-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enabled</label>
                <label className="settings-check"><input type="checkbox" checked={draft.isDefault} disabled={editing?.isDefault} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} /> Organization default</label>
              </div>
              {formError && <div className="settings-note settings-note--error">{formError}</div>}
            </div>
            <div className="prov-dialog__foot">
              <PremiumButton variant="text" onClick={() => setOpen(false)}>Cancel</PremiumButton>
              <PremiumButton variant="primary" disabled={busy === "save"} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save model"}</PremiumButton>
            </div>
          </div>
        </div>
      ), document.body)}
    </PremiumCard>
  );
}
