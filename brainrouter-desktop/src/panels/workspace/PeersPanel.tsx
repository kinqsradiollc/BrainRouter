/**
 * ADR-034 live participant, composer, hold, and receipt surface. It keeps
 * exact keys visible because titles never route, and it presents durable host
 * decisions without letting transport or UI persistence imply application.
 */
import React from 'react';
import { sanitizePeerTextForTerminal } from '@kinqs/brainrouter-types/peer-presentation';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import '../../styles/surfaces/peers.css';

interface PeerRoute {
  sessionKey: string;
  deviceId: string;
  clientKind: 'cli' | 'desktop';
  state: 'idle' | 'working' | 'waiting';
  transport: 'local' | 'remote';
  title?: string;
  workspaceRoot?: string;
  ambiguous?: boolean;
  instanceCount?: number;
}

interface PeersSnapshot {
  ownSessionKey: string;
  brainOnline: boolean;
  routes: PeerRoute[];
  error?: string;
}

interface HeldMessage {
  id: string;
  senderSessionKey: string;
  senderDeviceId: string;
  text: string;
  status: 'held' | 'approved' | 'rejected' | 'expired';
  holdReason: string;
  createdAt: number;
  expiresAt: number;
  appliedAt?: number;
  clientKind?: 'cli' | 'desktop';
  workspaceRoot?: string;
  title?: string;
  transport?: 'local' | 'remote';
}

interface Receipt {
  ok: boolean;
  receiptId?: string;
  messageId?: string;
  targetSessionKey?: string;
  transport?: 'local' | 'remote';
  status: string;
  wording: string;
  reason?: string;
  wake?: 'pushed' | 'poll-fallback';
  updatedAt: string;
}

export function peerRouteLabel(route: PeerRoute): string {
  const name = safePeer(route.title?.trim() || route.sessionKey);
  const duplicate = route.ambiguous || (route.instanceCount ?? 1) > 1 ? ' · duplicate key' : '';
  return `${name} · ${safePeer(route.clientKind)} · ${safePeer(route.transport)}${duplicate}`;
}

export function heldDecisionNotice(approved: boolean, transport?: 'local' | 'remote'): string {
  if (approved) return 'Approved and queued for the Agent’s next safe boundary.';
  return transport === 'remote'
    ? 'Declined; the remote sender receipt was updated.'
    : 'Declined locally; this message will not be applied.';
}

export function PeersPanel(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<PeersSnapshot>({ ownSessionKey: '', brainOnline: false, routes: [] });
  const [held, setHeld] = React.useState<HeldMessage[]>([]);
  const [receipts, setReceipts] = React.useState<Receipt[]>([]);
  const [target, setTarget] = React.useState('');
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = React.useCallback(async (): Promise<void> => {
    const results = await Promise.allSettled([
      bridgeQuery<PeersSnapshot>('peers-list', {}, 10_000),
      bridgeQuery<{ messages: HeldMessage[] }>('peers-held', {}, 10_000),
      bridgeQuery<{ receipts: Receipt[] }>('peers-receipts', {}, 10_000),
    ]);
    if (!mounted.current) return;
    if (results[0].status === 'fulfilled') setSnapshot(results[0].value);
    if (results[1].status === 'fulfilled') setHeld(Array.isArray(results[1].value.messages) ? results[1].value.messages : []);
    if (results[2].status === 'fulfilled') setReceipts(Array.isArray(results[2].value.receipts) ? results[2].value.receipts : []);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      setNotice(safePeer(failed.reason instanceof Error ? failed.reason.message : 'Peer refresh failed.'));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const send = async (): Promise<void> => {
    if (!target.trim() || !text.trim()) return;
    setBusy(true);
    setNotice('');
    try {
      const receipt = await bridgeQuery<Receipt>('peers-send', { to: target, text }, 15_000);
      if (!mounted.current) return;
      setNotice(safePeer(receipt.wording));
      if (receipt.ok) setText('');
      await refresh();
    } catch (error) {
      if (mounted.current) setNotice(safePeer(error instanceof Error ? error.message : 'Message was not queued.'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const decide = async (id: string, approved: boolean): Promise<void> => {
    setBusy(true);
    setNotice('');
    try {
      const decision = await bridgeQuery<HeldMessage>('peers-held-decide', { id, approved }, 15_000);
      if (mounted.current) setNotice(heldDecisionNotice(approved, decision.transport));
      await refresh();
    } catch (error) {
      if (mounted.current) setNotice(safePeer(error instanceof Error ? error.message : 'The held decision failed.'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const acknowledgeTerminal = async (): Promise<void> => {
    const ids = receipts
      .filter((receipt) => !['pending', 'held'].includes(receipt.status))
      .map((receipt) => receipt.receiptId)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await bridgeQuery('peers-receipts-ack', { ids }, 15_000);
      if (mounted.current) setNotice(`Acknowledged ${ids.length} terminal receipt${ids.length === 1 ? '' : 's'}.`);
      await refresh();
    } catch (error) {
      if (mounted.current) setNotice(safePeer(error instanceof Error ? error.message : 'Receipt acknowledgement failed.'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const selected = snapshot.routes.find((route) => route.sessionKey === target);
  return (
    <div className="scroll peers-panel">
      <div className="tasks-section peers-head">
        <span>Live participants</span>
        <button className="tasks-clear" type="button" onClick={() => void refresh()}>Refresh</button>
      </div>
      <div className="peers-presence">
        <span className={`peer-state ${snapshot.brainOnline ? 'online' : 'offline'}`}>
          {snapshot.brainOnline ? 'Brain connected · durable inbox with wake/poll delivery' : 'Brain offline · local discovery remains active'}
        </span>
        <code title={safePeer(snapshot.ownSessionKey)}>{safePeer(snapshot.ownSessionKey) || 'Starting local listener…'}</code>
      </div>
      {snapshot.error ? <div className="empty error">{safePeer(snapshot.error)}</div> : null}
      {snapshot.routes.length === 0 ? <div className="empty">No other live CLI or Desktop participants.</div> : (
        <div className="peers-routes" aria-label="Live session participants">
          {snapshot.routes.map((route) => {
            const unavailable = route.ambiguous || (route.instanceCount ?? 1) > 1;
            return (
              <button
                type="button"
                key={`${route.transport}:${route.sessionKey}`}
                className={`peer-route${target === route.sessionKey ? ' selected' : ''}${unavailable ? ' ambiguous' : ''}`}
                disabled={unavailable}
                onClick={() => setTarget(route.sessionKey)}
                title={safePeer(route.workspaceRoot || route.sessionKey)}
              >
                <span className={`peer-dot ${route.state}`} aria-hidden="true" />
                <span className="peer-route-copy">
                  <strong>{safePeer(route.title || route.sessionKey)}</strong>
                  <small>{safePeer(route.sessionKey)}</small>
                </span>
                <span className="peer-route-meta">{safePeer(route.state)} · {safePeer(route.clientKind)} · {safePeer(route.transport)}{unavailable ? ' · duplicate' : ''}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="tasks-section"><span>Send a message</span></div>
      <div className="peers-compose">
        <label>
          <span>Exact session key or unique prefix</span>
          <input
            className="br-type"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="Select a participant or paste a key"
          />
        </label>
        <label>
          <span>Untrusted peer content</span>
          <textarea
            className="br-type"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Share evidence, context, or a handoff…"
            rows={4}
          />
        </label>
        <div className="peers-compose-actions">
          <span>{selected ? peerRouteLabel(selected) : 'Titles are display-only; delivery resolves the key.'}</span>
          <button className="btn" type="button" disabled={busy || !target.trim() || !text.trim()} onClick={() => void send()}>
            {busy ? 'Working…' : 'Send'}
          </button>
        </div>
      </div>
      {notice ? <div className="peers-notice" role="status">{notice}</div> : null}

      <div className="tasks-section"><span>Held for your approval · {held.filter((row) => row.status === 'held').length}</span></div>
      {held.filter((row) => row.status === 'held').length === 0 ? <div className="empty">No messages are awaiting approval.</div> : null}
      {held.filter((row) => row.status === 'held').map((row) => (
        <article className="peer-held" key={row.id}>
          <header>
            <strong>From {safePeer(row.title || row.senderSessionKey)}</strong>
            <span>expires {new Date(row.expiresAt).toLocaleString()}</span>
          </header>
          <p>{safePeer(row.text)}</p>
          <small>
            {safePeer(row.senderSessionKey)} · {safePeer(row.clientKind || 'peer')} · {safePeer(row.transport || 'unknown')} · device {safePeer(row.senderDeviceId)}
            {row.workspaceRoot ? ` · ${safePeer(row.workspaceRoot)}` : ''}
            {' · '}{safePeer(row.holdReason)}
          </small>
          <div className="peer-held-actions">
            <button className="btn" type="button" disabled={busy} onClick={() => void decide(row.id, false)}>Decline</button>
            <button className="btn primary" type="button" disabled={busy} onClick={() => void decide(row.id, true)}>Approve</button>
          </div>
        </article>
      ))}

      <div className="tasks-section">
        <span>Delivery receipts</span>
        <button
          className="tasks-clear"
          type="button"
          disabled={busy || !receipts.some((receipt) => receipt.receiptId && !['pending', 'held'].includes(receipt.status))}
          onClick={() => void acknowledgeTerminal()}
        >
          Clear completed
        </button>
      </div>
      {receipts.length === 0 ? <div className="empty">No sent-message receipts yet.</div> : null}
      {receipts.map((receipt, index) => (
        <div className="peer-receipt" key={`${receipt.messageId ?? 'receipt'}:${receipt.targetSessionKey ?? ''}:${index}`}>
          <span className={`peer-receipt-status ${safePeer(receipt.status)}`}>{safePeer(receipt.status).replace('_', ' ')}</span>
          <span className="peer-receipt-copy">
            <strong>{safePeer(receipt.targetSessionKey || 'Recipient')}</strong>
            <small>{safePeer(receipt.wording)}{receipt.wake ? ` · ${safePeer(receipt.wake)}` : ''}</small>
          </span>
          <time>{new Date(receipt.updatedAt).toLocaleString()}</time>
        </div>
      ))}
    </div>
  );
}

function safePeer(value: string): string {
  return sanitizePeerTextForTerminal(value);
}
