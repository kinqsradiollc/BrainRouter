"use client";

/**
 * ADR-014 Phase B2 — admin SMTP settings (system-global, stored in the DB, never
 * .env). Configure the mailer that sends verification + invitation + reset email.
 */
import { useCallback, useEffect, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi, type EmailSettingsInput } from "../../lib/adminApi";

const EMPTY: EmailSettingsInput = { enabled: false, host: "", port: 587, secure: false, user: "", from: "", appUrl: "", pass: "" };

function EmailSettingsInner() {
  const [cfg, setCfg] = useState<EmailSettingsInput>(EMPTY);
  const [hasPassword, setHasPassword] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.getEmailSettings();
      if (res.config) {
        setCfg({ ...EMPTY, ...res.config, pass: "" });
        setHasPassword(!!res.config.hasPassword);
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load email settings (admin only)");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setNote("");
    try {
      const res = await adminApi.putEmailSettings(cfg);
      setHasPassword(!!res.config.hasPassword);
      setCfg((c) => ({ ...c, pass: "" }));
      setNote("Saved.");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally { setSaving(false); }
  }

  async function test() {
    setTesting(true); setNote("");
    try {
      const r = await adminApi.testEmail();
      setNote(r.delivered ? "Test email sent." : `Not delivered via ${r.transport}: ${r.detail ?? "unknown"}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test failed");
    } finally { setTesting(false); }
  }

  const set = (k: keyof EmailSettingsInput) => (v: string | boolean | number) => setCfg((c) => ({ ...c, [k]: v }));

  return (
    <div className="settings-page">
      <PageHeader title="Email (SMTP)" description="System-wide mailer for verification, invitations, and password resets. Stored in the database, never in .env." />
      {error && <div className="settings-note settings-note--error">{error}</div>}
      {note && <div className="settings-note settings-note--warn">{note}</div>}

      <PremiumCard level={2} style={{ marginTop: "var(--spacing-24)" }}>
        <form onSubmit={save} className="settings-grid">
          <label className="settings-check settings-col-2">
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => set("enabled")(e.target.checked)} />
            Enable outbound email (SMTP)
          </label>
          <label className="settings-label">SMTP host
            <input className="settings-input" placeholder="smtp.example.com" value={cfg.host} onChange={(e) => set("host")(e.target.value)} />
          </label>
          <label className="settings-label">Port
            <input className="settings-input" type="number" value={cfg.port} onChange={(e) => set("port")(Number(e.target.value))} />
          </label>
          <label className="settings-label">Username
            <input className="settings-input" placeholder="apikey / user" value={cfg.user ?? ""} onChange={(e) => set("user")(e.target.value)} />
          </label>
          <label className="settings-label">Password {hasPassword && <span className="settings-hint">(set — leave blank to keep)</span>}
            <input className="settings-input" type="password" placeholder={hasPassword ? "••••••••" : "SMTP password"} value={cfg.pass ?? ""} onChange={(e) => set("pass")(e.target.value)} />
          </label>
          <label className="settings-label">From address
            <input className="settings-input" placeholder="BrainRouter <no-reply@example.com>" value={cfg.from} onChange={(e) => set("from")(e.target.value)} />
          </label>
          <label className="settings-label">Dashboard URL (for links)
            <input className="settings-input" placeholder="https://app.brainrouter.dev" value={cfg.appUrl ?? ""} onChange={(e) => set("appUrl")(e.target.value)} />
          </label>
          <label className="settings-check settings-col-2">
            <input type="checkbox" checked={!!cfg.secure} onChange={(e) => set("secure")(e.target.checked)} />
            Use TLS (secure) — usually on for port 465
          </label>
          <div className="settings-actions settings-col-2">
            <PremiumButton variant="ghost" disabled={testing} onClick={test}>{testing ? "Sending…" : "Send test email"}</PremiumButton>
            <PremiumButton type="submit" variant="primary" disabled={saving}>{saving ? "Saving…" : "Save settings"}</PremiumButton>
          </div>
        </form>
      </PremiumCard>
    </div>
  );
}

export default function EmailSettingsPage() {
  return <AuthGuard><EmailSettingsInner /></AuthGuard>;
}
