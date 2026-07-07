/**
 * ADR-016 C0 — Account: sign in to a BrainRouter backend. On success the host
 * points the active brain at that backend over HTTP (per-user apiKey), so memory
 * becomes backend-backed and (later phases) orgs/teams/connectors come online.
 * Self-contained: talks to the host auth handlers directly via bridgeQuery.
 */
import { useCallback, useEffect, useState } from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

interface Account { url: string; userId: string; displayName: string; email: string }
interface StatusResult { signedIn: boolean; account: Account | null }
interface SigninResult { ok: boolean; error?: string; account?: Account }

export function AccountSettings(): JSX.Element {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('http://localhost:3747');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const st = await bridgeQuery<StatusResult>('auth-status');
      setAccount(st.signedIn ? st.account : null);
    } catch { /* host offline — treat as signed out */ setAccount(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function signIn(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await bridgeQuery<SigninResult>('action:auth-signin', { url: url.trim(), email: email.trim(), password });
      if (!res.ok) { setError(res.error ?? 'Sign-in failed.'); return; }
      setPassword('');
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  }

  async function signOut(): Promise<void> {
    setBusy(true); setError('');
    try { await bridgeQuery('action:auth-signout'); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign-out failed.'); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="settings-body"><div className="muted">Loading…</div></div>;

  return (
    <div className="settings-body">
      <div className="settings-section-title">Account</div>
      <p className="muted" style={{ marginTop: 0 }}>
        Sign in to a BrainRouter backend to use hosted memory, teams, and connectors.
        Without an account the app runs fully local (embedded brain, local files).
      </p>

      {account ? (
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div><strong>{account.displayName || account.email || account.userId}</strong></div>
          <div className="muted">{account.email}{account.email && account.url ? ' · ' : ''}{account.url}</div>
          <div><span className="badge badge-ok">Connected — memory is backend-backed</span></div>
          <div><button className="btn danger" disabled={busy} onClick={() => void signOut()}>{busy ? 'Signing out…' : 'Sign out'}</button></div>
          {error && <div className="settings-note danger">{error}</div>}
        </div>
      ) : (
        <form onSubmit={signIn} className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, maxWidth: 420 }}>
          <label className="settings-label">BrainRouter URL
            <input className="settings-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3747" />
          </label>
          <label className="settings-label">Email
            <input className="settings-input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <label className="settings-label">Password
            <input className="settings-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="settings-note danger">{error}</div>}
          <div><button className="btn" type="submit" disabled={busy || !email.trim() || !password}>{busy ? 'Signing in…' : 'Sign in'}</button></div>
        </form>
      )}
    </div>
  );
}
