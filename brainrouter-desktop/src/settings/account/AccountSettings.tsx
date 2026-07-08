// ADR-016 C0 — sign in to your BrainRouter account from the desktop. Signing in
// points the brain at the hosted memory plane and unlocks teams + connectors. The
// backend URL is a build-time constant (see host auth-signin) — not a user field —
// so signing in is just email + password. Connect GitHub (and other sources) from
// Settings → Connectors. The agent, terminal, and local files stay on this machine.
import { useCallback, useEffect, useState } from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

interface Account { url: string; userId: string; displayName: string; email: string }

export function AccountSettings(): React.ReactElement {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await bridgeQuery<{ signedIn: boolean; account: Account | null }>('auth-status');
      setAccount(res.signedIn ? res.account : null);
    } catch { /* leave signed-out */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const signIn = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await bridgeQuery<{ ok: boolean; account?: Account; error?: string }>('action:auth-signin', { email, password });
      if (res.ok && res.account) { setAccount(res.account); setPassword(''); }
      else setError(res.error || 'Sign-in failed.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }, [email, password]);

  const signOut = useCallback(async () => {
    setBusy(true); setError('');
    try { await bridgeQuery('action:auth-signout'); setAccount(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign-out failed.'); }
    finally { setBusy(false); }
  }, []);

  const box: React.CSSProperties = { border: '1px solid var(--border, #2a2a2a)', borderRadius: 10, padding: 16, marginTop: 12, maxWidth: 460 };
  const input: React.CSSProperties = { width: '100%', marginTop: 4, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border, #333)', background: 'var(--input-bg, #16181d)', color: 'inherit' };
  const label: React.CSSProperties = { display: 'block', marginTop: 12, fontSize: 13, opacity: 0.85 };

  return (
    <div className="settings-section">
      <h2>Account</h2>
      <p className="muted" style={{ maxWidth: 520 }}>
        Sign in to BrainRouter to use hosted memory, teams, and connectors (GitHub, …).
        Your agent, terminal, and local files stay on this machine.
      </p>

      {loading ? (
        <div className="muted" style={box}>Loading…</div>
      ) : account ? (
        <div style={box}>
          <div><strong>Signed in as {account.displayName || account.email}</strong></div>
          <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{account.email}</div>
          <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
            Memory is backed by your BrainRouter account. Connect GitHub and other sources in <b>Settings → Connectors</b>.
          </div>
          <button className="btn" disabled={busy} onClick={() => void signOut()} style={{ marginTop: 14 }}>{busy ? 'Signing out…' : 'Sign out'}</button>
        </div>
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
