"use client";

/**
 * ADR-052 P2b — Advanced → per-organization contracted pricing. A global discount
 * multiplier applied to every list price, plus explicit per-model rates (USD per
 * 1M tokens) that override list price for the models named. Backed by
 * GET/PUT /api/admin/pricing-settings (system_settings KV, RBAC providers:manage).
 * Self-contained: uses `authFetch` directly, mirrors AdvancedRecallPanel.
 */
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../lib/adminApi";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { InlineLoading } from "../../components/LoadingSpinner";

interface PricingField {
  key: string;
  label: string;
  kind: "float";
  min: number;
  max: number;
  envDefault: number;
  help: string;
}
interface ModelRate { inputPerMTok?: number; outputPerMTok?: number }
interface PricingSettings {
  discountMultiplier?: number;
  rates?: Record<string, ModelRate>;
}

export function PricingSettingsPanel() {
  const [fields, setFields] = useState<PricingField[]>([]);
  const [settings, setSettings] = useState<PricingSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [newModel, setNewModel] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authFetch<{ fields: PricingField[]; settings: PricingSettings }>("/api/admin/pricing-settings");
      setFields(res.fields ?? []);
      setSettings(res.settings ?? {});
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load pricing settings");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function setDiscount(value: number | undefined) {
    setMsg("");
    setSettings((s) => {
      const next = { ...s };
      if (value === undefined) delete next.discountMultiplier;
      else next.discountMultiplier = value;
      return next;
    });
  }

  function setRate(model: string, side: "inputPerMTok" | "outputPerMTok", value: number | undefined) {
    setMsg("");
    setSettings((s) => {
      const rates = { ...(s.rates ?? {}) };
      const cur: ModelRate = { ...(rates[model] ?? {}) };
      if (value === undefined) delete cur[side];
      else cur[side] = value;
      if (cur.inputPerMTok === undefined && cur.outputPerMTok === undefined) delete rates[model];
      else rates[model] = cur;
      const next = { ...s };
      if (Object.keys(rates).length) next.rates = rates; else delete next.rates;
      return next;
    });
  }

  function addModel() {
    const id = newModel.trim();
    if (!id) return;
    setNewModel("");
    setRate(id, "inputPerMTok", 0);
  }

  async function persist(next: PricingSettings, note: string) {
    try {
      setSaving(true); setMsg(""); setError("");
      const res = await authFetch<{ settings: PricingSettings }>("/api/admin/pricing-settings", { method: "PUT", body: { settings: next } });
      setSettings(res.settings ?? {});
      setMsg(note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const rateEntries = Object.entries(settings.rates ?? {});

  return (
    <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
      <div className="settings-cardhead">
        <div>
          <h3>Contracted pricing</h3>
          <div className="settings-hint">
            Per-organization pricing for cost surfaces. A global discount multiplier scales every list
            price; an explicit per-model rate (USD per 1M tokens) overrides list price for that model.
            Leave the discount blank to use list price.
          </div>
        </div>
      </div>

      {error && <div className="settings-empty-inline">{error}</div>}
      {loading ? (
        <InlineLoading label="Loading…" />
      ) : (
        <>
          {fields.map((f) => {
            const cur = settings.discountMultiplier;
            return (
              <div key={f.key} className="org-member">
                <div className="org-member__id" style={{ whiteSpace: "normal" }}>
                  <strong>{f.label}</strong>
                  <div className="settings-hint">{f.help}</div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <input
                    className="settings-input org-rolepick"
                    style={{ width: "10rem" }}
                    type="number"
                    min={f.min}
                    max={f.max}
                    step={0.05}
                    placeholder={`Default ${f.envDefault}`}
                    value={cur === undefined ? "" : String(cur)}
                    onChange={(e) => { const v = e.target.value; setDiscount(v === "" ? undefined : parseFloat(v)); }}
                    aria-label={f.label}
                  />
                </div>
              </div>
            );
          })}

          <div className="settings-cardhead" style={{ marginTop: "var(--spacing-16)" }}>
            <div><strong>Per-model rates</strong><div className="settings-hint">USD per 1M tokens. Overrides list price for the model.</div></div>
          </div>
          {rateEntries.length === 0 && <div className="settings-hint">No per-model rates — every model uses the discounted list price.</div>}
          {rateEntries.map(([model, rate]) => (
            <div key={model} className="org-member">
              <div className="org-member__id"><strong>{model}</strong></div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-8)" }}>
                <input className="settings-input" style={{ width: "6rem" }} type="number" min={0} step={0.1}
                  placeholder="input" value={rate.inputPerMTok === undefined ? "" : String(rate.inputPerMTok)}
                  onChange={(e) => { const v = e.target.value; setRate(model, "inputPerMTok", v === "" ? undefined : parseFloat(v)); }}
                  aria-label={`${model} input rate`} />
                <input className="settings-input" style={{ width: "6rem" }} type="number" min={0} step={0.1}
                  placeholder="output" value={rate.outputPerMTok === undefined ? "" : String(rate.outputPerMTok)}
                  onChange={(e) => { const v = e.target.value; setRate(model, "outputPerMTok", v === "" ? undefined : parseFloat(v)); }}
                  aria-label={`${model} output rate`} />
                <PremiumButton variant="ghost" disabled={saving} onClick={() => { setRate(model, "inputPerMTok", undefined); setRate(model, "outputPerMTok", undefined); }}>
                  Remove
                </PremiumButton>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", gap: "var(--spacing-8)", marginTop: "var(--spacing-8)" }}>
            <input className="settings-input" style={{ width: "14rem" }} placeholder="model id (e.g. opus-5)"
              value={newModel} onChange={(e) => setNewModel(e.target.value)} aria-label="new model id" />
            <PremiumButton variant="ghost" disabled={saving || !newModel.trim()} onClick={addModel}>Add model</PremiumButton>
          </div>

          <div style={{ marginTop: "var(--spacing-16)", display: "flex", alignItems: "center", gap: "var(--spacing-12)" }}>
            <PremiumButton variant="primary" disabled={saving} onClick={() => void persist(settings, "Saved — cost surfaces use these rates.")}>
              {saving ? "Saving…" : "Save pricing"}
            </PremiumButton>
            <PremiumButton variant="ghost" disabled={saving} onClick={() => void persist({}, "Reset to list price.")}>
              Reset to list price
            </PremiumButton>
            {msg && <span className="settings-hint">{msg}</span>}
          </div>
        </>
      )}
    </PremiumCard>
  );
}
