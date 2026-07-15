"use client";

/**
 * Advanced → per-organization recall-quality tuning. A small, safe subset of the
 * recall pipeline's `BRAINROUTER_RECALL_*` env knobs, editable per org. Unset
 * fields fall back to the server default (shown as the placeholder). Backed by
 * GET/PUT /api/admin/recall-settings (system_settings KV, RBAC providers:manage).
 * Self-contained: uses `authFetch` directly, no shared adminApi surface.
 */
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../lib/adminApi";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";

interface RecallField {
  key: string;
  label: string;
  kind: "int" | "float" | "bool";
  min?: number;
  max?: number;
  envDefault: number | boolean;
  help: string;
}
type RecallSettings = Record<string, number | boolean>;

export function AdvancedRecallPanel() {
  const [fields, setFields] = useState<RecallField[]>([]);
  const [settings, setSettings] = useState<RecallSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authFetch<{ fields: RecallField[]; settings: RecallSettings }>("/api/admin/recall-settings");
      setFields(res.fields ?? []);
      setSettings(res.settings ?? {});
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load recall settings");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function setField(key: string, value: number | boolean | undefined) {
    setMsg("");
    setSettings((s) => {
      const next = { ...s };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  async function persist(next: RecallSettings, note: string) {
    try {
      setSaving(true); setMsg(""); setError("");
      const res = await authFetch<{ settings: RecallSettings }>("/api/admin/recall-settings", { method: "PUT", body: { settings: next } });
      setSettings(res.settings ?? {});
      setMsg(note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
      <div className="settings-cardhead">
        <div>
          <h3>Recall tuning</h3>
          <div className="settings-hint">
            Per-organization overrides for the memory recall pipeline. Leave a field blank to use
            the server default (shown as the placeholder). Changes take effect on new recalls within ~1 minute.
          </div>
        </div>
      </div>

      {error && <div className="settings-empty-inline">{error}</div>}
      {loading ? (
        <div className="settings-empty-inline">Loading…</div>
      ) : (
        <>
          {fields.map((f) => {
            const cur = settings[f.key];
            return (
              <div key={f.key} className="org-member">
                <div className="org-member__id" style={{ whiteSpace: "normal" }}>
                  <strong>{f.label}</strong>
                  <div className="settings-hint">{f.help}</div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  {f.kind === "bool" ? (
                    <select
                      className="settings-select org-rolepick"
                      style={{ minWidth: "10rem" }}
                      value={cur === undefined ? "" : String(cur)}
                      onChange={(e) => setField(f.key, e.target.value === "" ? undefined : e.target.value === "true")}
                      aria-label={f.label}
                    >
                      <option value="">Default ({f.envDefault ? "on" : "off"})</option>
                      <option value="true">On</option>
                      <option value="false">Off</option>
                    </select>
                  ) : (
                    <input
                      className="settings-input org-rolepick"
                      style={{ width: "10rem" }}
                      type="number"
                      min={f.min}
                      max={f.max}
                      step={f.kind === "float" ? 0.05 : 1}
                      placeholder={`Default ${f.envDefault}`}
                      value={cur === undefined ? "" : String(cur)}
                      onChange={(e) => {
                        const v = e.target.value;
                        setField(f.key, v === "" ? undefined : (f.kind === "float" ? parseFloat(v) : parseInt(v, 10)));
                      }}
                      aria-label={f.label}
                    />
                  )}
                </div>
              </div>
            );
          })}

          <div style={{ marginTop: "var(--spacing-16)", display: "flex", alignItems: "center", gap: "var(--spacing-12)" }}>
            <PremiumButton variant="primary" disabled={saving} onClick={() => void persist(settings, "Saved — new recalls use these within a minute.")}>
              {saving ? "Saving…" : "Save recall settings"}
            </PremiumButton>
            <PremiumButton variant="ghost" disabled={saving} onClick={() => void persist({}, "Reset to server defaults.")}>
              Reset to defaults
            </PremiumButton>
            {msg && <span className="settings-hint">{msg}</span>}
          </div>
        </>
      )}
    </PremiumCard>
  );
}
