// ADR-016 C0 — sign in to your BrainRouter account from the desktop. Signing in
// points the brain at the hosted memory plane and unlocks teams + connectors. The
// backend URL is a build-time constant (see host auth-signin) — not a user field —
// so signing in is just email + password. The signed-in view mirrors a hosted
// account page: organization id, the devices/sessions the account is signed in on,
// and "log out of all other devices" (rotates the API key server-side).
import { useCallback, useEffect, useState } from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

interface Account { url: string; userId: string; displayName: string; email: string }
interface SessionRow { clientKind: string; workspaceRoot?: string; startedAt?: string; lastHeartbeatAt?: string }
interface Overview { signedIn: boolean; orgId?: string; orgName?: string; plan?: string; role?: string; sessions: SessionRow[] }

function relTime(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString();
}
function deviceLabel(kind: string): string {
  const k = (kind || '').toLowerCase();
  if (k.includes('electron') || k.includes('desktop')) return 'Desktop app';
  if (k.includes('cli') || k.includes('terminal')) return 'CLI / terminal';
  if (k.includes('mcp')) return 'MCP client';
  if (k.includes('http')) return 'HTTP client';
  return kind || 'unknown';
}

export function AccountSettings(): React.ReactElement {
  const [account, setAccount] = useState<Account | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadOverview = useCallback(async () => {
    try { const res = await bridgeQuery<Overview>('account-overview'); setOverview(res?.signedIn ? res : null); }
    catch { setOverview(null); }
  }, []);
  const refresh = useCallback(async () => {
    try {
      const res = await bridgeQuery<{ signedIn: boolean; account: Account | null }>('auth-status');
      setAccount(res.signedIn ? res.account : null);
      if (res.signedIn) await loadOverview();
    } catch { /* leave signed-out */ } finally { setLoading(false); }
  }, [loadOverview]);
  useEffect(() => { void refresh(); }, [refresh]);

  const signIn = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await bridgeQuery<{ ok: boolean; account?: Account; error?: string }>('action:auth-signin', { email, password });
      if (res.ok && res.account) { setAccount(res.account); setPassword(''); await loadOverview(); }
      else setError(res.error || 'Sign-in failed.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }, [email, password, loadOverview]);

  const signOut = useCallback(async () => {
    setBusy(true); setError(''); setNotice('');
    try { await bridgeQuery('action:auth-signout'); setAccount(null); setOverview(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign-out failed.'); }
    finally { setBusy(false); }
  }, []);

  const logoutAll = useCallback(async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await bridgeQuery<{ ok: boolean; error?: string }>('action:logout-all-devices');
      if (res.ok) { setNotice('Signed out of all other devices — their API keys were revoked. This device stays signed in.'); await loadOverview(); }
      else setError(res.error || 'Could not log out other devices.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not log out other devices.'); }
    finally { setBusy(false); }
  }, [loadOverview]);

  const box: React.CSSProperties = { border: '1px solid var(--border, #2a2a2a)', borderRadius: 10, padding: 16, marginTop: 12, maxWidth: 560 };
  const input: React.CSSProperties = { width: '100%', marginTop: 4, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border, #333)', background: 'var(--input-bg, #16181d)', color: 'inherit' };
  const label: React.CSSProperties = { display: 'block', marginTop: 12, fontSize: 13, opacity: 0.85 };
  const th: React.CSSProperties = { textAlign: 'left', fontSize: 12, opacity: 0.6, fontWeight: 600, padding: '6px 10px', borderBottom: '1px solid var(--border, #2a2a2a)' };
  const td: React.CSSProperties = { fontSize: 13, padding: '8px 10px', borderBottom: '1px solid var(--border, #1e1e1e)' };

  return (
    <div className="settings-section">
      <h2>Account</h2>
      <p className="muted" style={{ maxWidth: 560 }}>
        Sign in to BrainRouter to use hosted memory, teams, and connectors (GitHub, …).
        Your agent, terminal, and local files stay on this machine.
      </p>

      {loading ? (
        <div className="muted" style={box}>Loading…</div>
      ) : account ? (
        <>
          <div style={box}>
            <div><strong>Signed in as {account.displayName || account.email}</strong></div>
            <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{account.email}</div>
            {overview?.orgName ? (
              <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>Organization: <b>{overview.orgName}</b>{overview.role ? ` · ${overview.role}` : ''}{overview.plan ? ` · ${overview.plan}` : ''}</div>
            ) : null}
            <button className="btn" disabled={busy} onClick={() => void signOut()} style={{ marginTop: 14 }}>{busy ? '…' : 'Sign out'}</button>
          </div>

          {overview?.orgId ? (
            <div style={box}>
              <div style={{ fontSize: 13, opacity: 0.8 }}>Organization ID</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                <code style={{ fontSize: 13, userSelect: 'all', wordBreak: 'break-all' }}>{overview.orgId}</code>
                <button className="btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => { void navigator.clipboard?.writeText(overview.orgId ?? ''); setNotice('Organization ID copied.'); }}>Copy</button>
              </div>
            </div>
          ) : null}

          <div style={box}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
              <div><strong>Devices &amp; active sessions</strong><div className="muted" style={{ fontSize: 12, marginTop: 2 }}>Where your BrainRouter account is signed in (desktop, CLI, …).</div></div>
              <button className="btn" style={{ fontSize: 12 }} onClick={() => void loadOverview()}>Refresh</button>
            </div>
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Device</th><th style={th}>Workspace</th><th style={th}>Started</th><th style={th}>Last active</th></tr></thead>
                <tbody>
                  {(overview?.sessions ?? []).length ? overview!.sessions.map((s, i) => (
                    <tr key={i}>
                      <td style={td}>{deviceLabel(s.clientKind)} <span className="muted" style={{ fontSize: 11 }}>{s.clientKind}</span></td>
                      <td style={td} title={s.workspaceRoot}>{s.workspaceRoot ? (s.workspaceRoot.split('/').pop() || s.workspaceRoot) : '—'}</td>
                      <td style={td}>{relTime(s.startedAt)}</td>
                      <td style={td}>{relTime(s.lastHeartbeatAt)}</td>
                    </tr>
                  )) : <tr><td style={td} colSpan={4}><span className="muted">No active sessions reported.</span></td></tr>}
                </tbody>
              </table>
            </div>
            <button className="btn danger" disabled={busy} onClick={() => void logoutAll()} style={{ marginTop: 12 }}>{busy ? '…' : 'Log out of all other devices'}</button>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Revokes the API key every other device uses (this one stays signed in with a fresh key).</div>
          </div>

          {notice ? <div style={{ marginTop: 10, color: 'var(--accent, #6ea8fe)', fontSize: 13 }}>{notice}</div> : null}
          {error ? <div style={{ marginTop: 10, color: 'var(--danger, #ff6b6b)', fontSize: 13 }}>{error}</div> : null}
        </>
      ) : (
        <form style={box} onSubmit={(e) => void signIn(e)}>
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
