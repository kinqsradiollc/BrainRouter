/**
 * DESK-5c — the real terminal: a persistent host-side shell session rendered
 * through xterm. The panel owns its bridge round-trips directly (query ids
 * namespaced per mount) and polls term-read on a 200ms cadence.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';

// Renderer-memory only: preserves xterm's exact screen/scrollback state across
// panel remounts without persisting potentially sensitive terminal output.
const terminalSnapshots = new Map<string, { serialized: string; next: number }>();

type AdapterRow = { id: string; label: string; installed: boolean; requiresWorkspaceTrust: boolean };

export function TerminalPanel(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [dead, setDead] = useState(false);
  const [adapters, setAdapters] = useState<AdapterRow[]>([]);
  const [selected, setSelected] = useState('brainrouter');
  const [trusted, setTrusted] = useState(false);
  const [agentStatus, setAgentStatus] = useState('shell');
  const [followUp, setFollowUp] = useState('');
  const [setupState, setSetupState] = useState('');
  const launchRef = useRef<(adapterId: string, trust: boolean) => void>(() => {});
  const setupRef = useRef<(adapterId: string) => void>(() => {});
  const controlRef = useRef<(action: 'follow-up' | 'interrupt' | 'approve', text?: string) => void>(() => {});
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
    const styles = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontFamily: mono,
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: styles.getPropertyValue('--term-bg').trim() || '#121212',
        foreground: styles.getPropertyValue('--text').trim() || '#ececec',
        cursor: styles.getPropertyValue('--brand').trim() || '#d97757',
        selectionBackground: 'rgba(255,255,255,0.18)',
      },
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.open(el);
    fit.fit();

    const ns = `term${Math.random().toString(36).slice(2, 8)}`;
    let termId = '';
    let next = 0;
    const off = window.brainrouter.onEvent((msg) => {
      const e = msg.event as { kind: string; id?: string; ok?: boolean; result?: Record<string, unknown> };
      if (e.kind !== 'query-result' || !e.id?.startsWith(ns)) return;
      if (e.id === `${ns}:catalog` && e.ok && e.result) {
        setAdapters(Array.isArray(e.result.adapters) ? e.result.adapters as AdapterRow[] : []);
        if (typeof e.result.selected === 'string') setSelected(e.result.selected);
        return;
      }
      if (e.id === `${ns}:setup` && e.ok && e.result) {
        setSetupState(e.result.ok === true ? 'Ready' : String(e.result.error ?? 'Setup failed'));
        return;
      }
      if (e.id === `${ns}:status` && e.ok && e.result) {
        if (typeof e.result.status === 'string') setAgentStatus(e.result.status);
        return;
      }
      if ((e.id === `${ns}:open` || e.id === `${ns}:hosted-open` || e.id === `${ns}:attach`) && e.ok && e.result && typeof e.result.id === 'string') {
        const newId = e.result.id;
        if (termId && termId !== newId) term.reset();
        termId = newId;
        const cached = terminalSnapshots.get(termId);
        if (cached) {
          term.write(cached.serialized);
          next = cached.next;
        } else {
          if (typeof e.result.snapshot === 'string' && e.result.snapshot) term.write(e.result.snapshot);
          next = typeof e.result.next === 'number' ? e.result.next : 0;
        }
        if (typeof e.result.status === 'string') setAgentStatus(e.result.status);
        window.brainrouter.send({
          kind: 'query', id: `${ns}:resize`, name: 'term-resize',
          args: { id: termId, cols: term.cols, rows: term.rows },
        });
        return;
      }
      if (e.id === `${ns}:attach`) {
        window.brainrouter.send({
          kind: 'query', id: `${ns}:open`, name: 'term-open',
          args: { reuseKey: 'workspace-terminal', cols: term.cols, rows: term.rows },
        });
        return;
      }
      if (e.id === `${ns}:read` && e.ok && e.result) {
        if (typeof e.result.chunk === 'string' && e.result.chunk) term.write(e.result.chunk);
        next = typeof e.result.next === 'number' ? e.result.next : next;
        if (e.result.alive === false) setDead(true);
      }
    });
    window.brainrouter.send({ kind: 'query', id: `${ns}:catalog`, name: 'hosted-agent-catalog' });
    window.brainrouter.send({
      kind: 'query', id: `${ns}:attach`, name: 'hosted-agent-attach',
    });
    launchRef.current = (adapterId, trust) => {
      setDead(false);
      window.brainrouter.send({
        kind: 'query', id: `${ns}:hosted-open`, name: 'hosted-agent-start',
        args: { adapterId, trusted: trust, cols: term.cols, rows: term.rows },
      });
    };
    setupRef.current = (adapterId) => {
      setSetupState('Setting up…');
      window.brainrouter.send({ kind: 'query', id: `${ns}:setup`, name: 'hosted-agent-setup', args: { adapterId } });
    };
    controlRef.current = (action, text) => {
      window.brainrouter.send({ kind: 'query', id: `${ns}:control`, name: 'hosted-agent-control', args: { action, text } });
    };
    const data = term.onData((d) => {
      if (termId) window.brainrouter.send({ kind: 'query', id: `${ns}:w`, name: 'term-write', args: { id: termId, data: d } });
    });
    const poll = setInterval(() => {
      if (termId) window.brainrouter.send({ kind: 'query', id: `${ns}:read`, name: 'term-read', args: { id: termId, from: next } });
    }, 200);
    const statusPoll = setInterval(() => {
      window.brainrouter.send({ kind: 'query', id: `${ns}:status`, name: 'hosted-agent-status' });
    }, 1_000);
    const ro = new ResizeObserver(() => {
      try {
        const before = `${term.cols}x${term.rows}`;
        fit.fit();
        if (termId && before !== `${term.cols}x${term.rows}`) {
          window.brainrouter.send({
            kind: 'query', id: `${ns}:resize`, name: 'term-resize',
            args: { id: termId, cols: term.cols, rows: term.rows },
          });
        }
      } catch { /* detached */ }
    });
    ro.observe(el);
    return () => {
      clearInterval(poll);
      clearInterval(statusPoll);
      ro.disconnect();
      data.dispose();
      off();
      if (termId) terminalSnapshots.set(termId, { serialized: serialize.serialize(), next });
      term.dispose();
    };
  }, []);
  const selectedRow = adapters.find((adapter) => adapter.id === selected);
  return (
    <div className="xterm-wrap">
      <div className="terminal-agent-bar">
        <select aria-label="Terminal agent" value={selected} onChange={(event) => { setSelected(event.target.value); setSetupState(''); }}>
          {adapters.map((adapter) => <option key={adapter.id} value={adapter.id}>{adapter.label}{adapter.installed ? '' : ' — not installed'}</option>)}
        </select>
        {selectedRow?.requiresWorkspaceTrust ? (
          <label className="terminal-trust"><input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} /> Trust workspace</label>
        ) : null}
        <button type="button" disabled={!selectedRow?.installed || (!!selectedRow?.requiresWorkspaceTrust && !trusted)} onClick={() => launchRef.current(selected, trusted)}>Start</button>
        <button type="button" disabled={!selectedRow?.installed} onClick={() => setupRef.current(selected)}>Setup hooks + MCP</button>
        <span className={`terminal-agent-status status-${agentStatus}`}>{agentStatus}</span>
        {setupState ? <span className="terminal-setup-state">{setupState}</span> : null}
        <span className="terminal-agent-spacer" />
        <button type="button" onClick={() => controlRef.current('approve')}>Approve</button>
        <button type="button" onClick={() => controlRef.current('interrupt')}>Interrupt</button>
      </div>
      <div className="terminal-followup">
        <input value={followUp} onChange={(event) => setFollowUp(event.target.value)} placeholder="Send a follow-up to the hosted agent" onKeyDown={(event) => {
          if (event.key === 'Enter' && followUp.trim()) { controlRef.current('follow-up', followUp); setFollowUp(''); }
        }} />
        <button type="button" disabled={!followUp.trim()} onClick={() => { controlRef.current('follow-up', followUp); setFollowUp(''); }}>Send</button>
      </div>
      <div className="xterm-host" ref={hostRef} />
      {dead ? <div className="empty">Shell exited — close and reopen the Terminal view to restart it.</div> : null}
    </div>
  );
}
