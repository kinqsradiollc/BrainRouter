"use client";

/**
 * ADR-016 — the deployment's single GitHub OAuth App (client_id + sealed client_secret).
 * This is what lets any signed-in user "Connect GitHub" from the desktop/dashboard via
 * the server-mediated OAuth broker. Global-admin only. The secret is write-only.
 */
import { useCallback, useEffect, useState } from "react";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { adminApi } from "../../lib/adminApi";

interface State { configured: boolean; clientId: string; hasSecret: boolean; redirectBase: string; secretStorageReady: boolean }

export function GithubOAuthAppCard({ embedded = false }: { embedded?: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectBase, setRedirectBase] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await adminApi.getGithubOAuthApp();
      setState(s); setClientId(s.clientId); setRedirectBase(s.redirectBase);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true); setError(""); setSaved(false);
    try {
      const result = await adminApi.setGithubOAuthApp({ clientId: clientId.trim(), clientSecret: clientSecret.trim() || undefined, redirectBase: redirectBase.trim() || undefined });
      if (!result.hasSecret) throw new Error("The client secret was not stored. Re-enter it before users connect.");
      setClientSecret(""); setSaved(true); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to save"); }
    finally { setSaving(false); }
  }, [clientId, clientSecret, redirectBase, load]);

  const callback = `${(state?.redirectBase || redirectBase || "http://localhost:3747").replace(/\/+$/, "")}/api/connectors/github/oauth/callback`;

  const content = (
    <div className={embedded ? "oauth-app-embedded" : undefined}>
      <div className="settings-cardhead">
        <div>
          <h3>GitHub OAuth App <span className="settings-hint">— lets any signed-in user “Connect GitHub”</span></h3>
          <div className="settings-hint">One shared OAuth App for this deployment. Register it on GitHub → Settings → Developer settings → <b>OAuth Apps</b>, with the Authorization callback URL <code>{callback}</code> (GitHub allows <code>localhost</code> callbacks).</div>
        </div>
        {state && <span className={state.configured && state.hasSecret ? "settings-flag-ok" : "settings-flag-muted"}>{state.configured ? (state.hasSecret ? "ready" : "no secret") : "not set"}</span>}
      </div>
      {state && !state.secretStorageReady && (
        <div className="settings-note settings-note--warn"><code>BRAINROUTER_SECRET_KEY</code> is not set — the client secret can’t be stored until it is.</div>
      )}
      {state?.clientId && !state.hasSecret && state.secretStorageReady && (
        <div className="settings-note settings-note--warn">The Client ID is saved, but no client secret is stored. Enter the OAuth App’s client secret and save again before users connect.</div>
      )}
      <form onSubmit={save}>
        <div className="settings-grid">
          <label className="settings-label">Client ID
            <input className="settings-input" placeholder="Ov23li… / Iv1.…" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </label>
          <label className="settings-label">Client secret {state?.hasSecret && <span className="settings-hint">(stored — blank keeps it)</span>}
            <input className="settings-input" type="password" autoComplete="off" placeholder={state?.hasSecret ? "•••••••• (kept)" : "the OAuth App’s client secret"} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
          </label>
          <label className="settings-label settings-col-2">Callback base URL <span className="settings-hint">(this server’s base URL)</span>
            <input className="settings-input" placeholder="http://localhost:3747" value={redirectBase} onChange={(e) => setRedirectBase(e.target.value)} />
          </label>
        </div>
        {error && <div className="settings-note settings-note--error" style={{ marginTop: 8 }}>{error}</div>}
        {saved && <div className="settings-note" style={{ marginTop: 8 }}>Saved — signed-in users can now Connect GitHub.</div>}
        <div style={{ marginTop: "var(--spacing-16)" }}>
          <PremiumButton type="submit" variant="primary" disabled={saving || !clientId.trim() || (!state?.hasSecret && !clientSecret.trim())}>{saving ? "Saving…" : "Save OAuth App"}</PremiumButton>
        </div>
      </form>
    </div>
  );
  return embedded ? content : <PremiumCard level={2} style={{ marginTop: "var(--spacing-16)" }}>{content}</PremiumCard>;
}
