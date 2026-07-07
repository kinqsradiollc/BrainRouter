// ADR-016 C0/C2 — sign in to a BrainRouter backend, and connect GitHub through the
// backend's server-mediated OAuth broker. Signing in points the brain at the hosted
// MCP plane (memory becomes backend-backed) and unlocks teams + connectors. The
// agent, terminal, and local files stay on this machine.
import { useCallback, useEffect, useState } from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

interface Account { url: string; userId: string; displayName: string; email: string }
interface GhState { appConfigured: boolean; connected: boolean; login: string | null }

export function AccountSettings(): React.ReactElement {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('http://localhost:3747');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [gh, setGh] = useState<GhState | null>(null);
  const [ghBusy, setGhBusy] = useState(false);
  const [ghMsg, setGhMsg] = useState('');

  const refreshGh = useCallback(async () => {
    try {
      const st = await bridgeQuery<{ signedIn: boolean; appConfigured?: boolean; connected?: boolean; login?: string | null }>('github-connect-status');
      setGh(st.signedIn ? { appConfigured: !!st.appConfigured, connected: !!st.connected, login: st.login ?? null } : null);
    } catch { setGh(null); }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await bridgeQuery<{ signedIn: boolean; account: Account | null }>('auth-status');
      setAccount(res.signedIn ? res.account : null);
      if (res.signedIn) void refreshGh();
    } catch { /* leave signed-out */ } finally { setLoading(false); }
  }, [refreshGh]);
  useEffect(() => { void refresh(); }, [refresh]);

  const signIn = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await bridgeQuery<{ ok: boolean; account?: Account; error?: string }>('action:auth-signin', { url, email, password });
      if (res.ok && res.account) { setAccount(res.account); setPassword(''); void refreshGh(); }
      else setError(res.error || 'Sign-in failed.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }, [url, email, password, refreshGh]);

  const signOut = useCallback(async () => {
    setBusy(true); setError('');
    try { await bridgeQuery('action:auth-signout'); setAccount(null); setGh(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign-out failed.'); }
    finally { setBusy(false); }
  }, []);

  const connectGithub = useCallback(async () => {
    setGhBusy(true); setGhMsg('');
    try {
      const res = await bridgeQuery<{ ok: boolean; url?: string; error?: string }>('github-connect-start');
      if (!res.ok || !res.url) { setGhMsg(res.error || 'Could not start the GitHub connection.'); return; }
      await bridgeQuery('action:open-external', { url: res.url });
      setGhMsg('Authorize BrainRouter in the browser tab that just opened…');
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const st = await bridgeQuery<{ connected?: boolean; login?: string | null }>('github-connect-status');
        if (st.connected) { setGh({ appConfigured: true, connected: true, login: st.login ?? null }); setGhMsg(''); return; }
      }
      setGhMsg('Still waiting — click Refresh once you have authorized on GitHub.');
    } catch (e) { setGhMsg(e instanceof Error ? e.message : 'Failed to connect.'); }
    finally { setGhBusy(false); }
  }, []);

  const disconnectGithub = useCallback(async () => {
    setGhBusy(true); setGhMsg('');
    try { await bridgeQuery('action:github-disconnect'); await refreshGh(); }
    catch { /* ignore */ } finally { setGhBusy(false); }
  }, [refreshGh]);

  const box: React.CSSProperties = { border: '1px solid var(--border, #2a2a2a)', borderRadius: 10, padding: 16, marginTop: 12, maxWidth: 460 };
  const input: React.CSSProperties = { width: '100%', marginTop: 4, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border, #333)', background: 'var(--input-bg, #16181d)', color: 'inherit' };
  const label: React.CSSProperties = { display: 'block', marginTop: 12, fontSize: 13, opacity: 0.85 };

  return (
    <div className="settings-section">
      <h2>Account</h2>
      <p className="muted" style={{ maxWidth: 520 }}>
        Sign in to your BrainRouter backend to use hosted memory, teams/organizations, and
        connectors (GitHub, …). Your agent, terminal, and local files stay on this machine.
      </p>

      {loading ? (
        <div className="muted" style={box}>Loading…</div>
      ) : account ? (
        <>
          <div style={box}>
            <div><strong>Signed in as {account.displayName || account.email}</strong></div>
            <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{account.email} · {account.url}</div>
            <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>Memory is backed by your BrainRouter account. Connectors are managed server-side.</div>
            <button className="btn" disabled={busy} onClick={() => void signOut()} style={{ marginTop: 14 }}>{busy ? 'Signing out…' : 'Sign out'}</button>
          </div>

          <div style={box}>
            <div><strong>GitHub</strong></div>
            {gh?.connected ? (
              <>
                <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>Connected as <b>{gh.login || 'your account'}</b> — BrainRouter can read your repositories.</div>
                <button className="btn" disabled={ghBusy} onClick={() => void disconnectGithub()} style={{ marginTop: 12 }}>{ghBusy ? 'Working…' : 'Disconnect'}</button>
              </>
            ) : gh?.appConfigured ? (
              <>
                <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>Authorize BrainRouter to read your GitHub repositories via the backend (OAuth — no tokens stored on this machine).</div>
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button className="btn primary" disabled={ghBusy} onClick={() => void connectGithub()}>{ghBusy ? 'Waiting…' : 'Connect GitHub'}</button>
                  <button className="btn" disabled={ghBusy} onClick={() => void refreshGh()}>Refresh</button>
                </div>
                {ghMsg && <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>{ghMsg}</div>}
              </>
            ) : (
              <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>GitHub OAuth isn&apos;t set up on this server yet — an admin configures the GitHub OAuth App (client ID + secret) in the dashboard, then you can connect here.</div>
            )}
          </div>
        </>
      ) : (
        <form style={box} onSubmit={(e) => void signIn(e)}>
          <label style={label}>Server URL
            <input style={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3747" />
          </label>
          <label style={label}>Email
            <input style={input} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </label>
          <label style={label}>Password
            <input style={input} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div style={{ marginTop: 10, color: 'var(--danger, #ff6b6b)', fontSize: 13 }}>{error}</div>}
          <button className="btn primary" type="submit" disabled={busy || !email || !password} style={{ marginTop: 14 }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      )}
    </div>
  );
}
