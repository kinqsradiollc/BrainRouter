/**
 * DESK-5c — the real terminal: a persistent host-side shell session rendered
 * through xterm. The panel owns its bridge round-trips directly (query ids
 * namespaced per mount) and polls term-read on a 200ms cadence.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function TerminalPanel(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [dead, setDead] = useState(false);
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
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const ns = `term${Math.random().toString(36).slice(2, 8)}`;
    let termId = '';
    let next = 0;
    const off = window.brainrouter.onEvent((msg) => {
      const e = msg.event as { kind: string; id?: string; ok?: boolean; result?: { id?: string; chunk?: string; next?: number; alive?: boolean } };
      if (e.kind !== 'query-result' || !e.id?.startsWith(ns)) return;
      if (e.id === `${ns}:open` && e.ok && e.result?.id) { termId = e.result.id; return; }
      if (e.id === `${ns}:read` && e.ok && e.result) {
        if (e.result.chunk) term.write(e.result.chunk);
        next = e.result.next ?? next;
        if (e.result.alive === false) setDead(true);
      }
    });
    window.brainrouter.send({ kind: 'query', id: `${ns}:open`, name: 'term-open' });
    const data = term.onData((d) => {
      if (termId) window.brainrouter.send({ kind: 'query', id: `${ns}:w`, name: 'term-write', args: { id: termId, data: d } });
    });
    const poll = setInterval(() => {
      if (termId) window.brainrouter.send({ kind: 'query', id: `${ns}:read`, name: 'term-read', args: { id: termId, from: next } });
    }, 200);
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* detached */ } });
    ro.observe(el);
    return () => {
      clearInterval(poll);
      ro.disconnect();
      data.dispose();
      off();
      if (termId) window.brainrouter.send({ kind: 'query', id: `${ns}:kill`, name: 'term-kill', args: { id: termId } });
      term.dispose();
    };
  }, []);
  return (
    <div className="xterm-wrap">
      <div className="xterm-host" ref={hostRef} />
      {dead ? <div className="empty">Shell exited — close and reopen the Terminal view to restart it.</div> : null}
    </div>
  );
}
