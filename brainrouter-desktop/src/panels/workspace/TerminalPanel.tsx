/**
 * Native workspace terminal rendered through xterm.
 *
 * Electron discovers and launches installed shells; the renderer handles only
 * stable shell IDs, terminal bytes, and geometry. Terminal output remains
 * renderer-memory-only across panel remounts.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import {
  projectTerminalRead,
  projectTerminalSession,
  projectTerminalShellCatalog,
  type TerminalShellView,
} from '@kinqs/brainrouter-agent-protocol';
import '@xterm/xterm/css/xterm.css';
import { terminalTheme } from './terminalTheme.js';

// Renderer-memory only: preserves xterm's exact screen/scrollback state across
// panel remounts without persisting potentially sensitive terminal output.
const terminalSnapshots = new Map<string, { serialized: string; next: number }>();

export function TerminalPanel(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [dead, setDead] = useState(false);
  const [shells, setShells] = useState<TerminalShellView[]>([]);
  const [selected, setSelected] = useState('');
  const [activeLabel, setActiveLabel] = useState('Starting shell…');
  const [error, setError] = useState('');
  const openRef = useRef<(shellId: string, restart?: boolean) => void>(() => {});
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
    const term = new Terminal({
      fontFamily: mono,
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10_000,
      theme: terminalTheme(getComputedStyle(document.documentElement)),
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
      const e = msg.event as { kind: string; id?: string; ok?: boolean; result?: Record<string, unknown>; error?: string };
      if (e.kind !== 'query-result' || !e.id?.startsWith(ns)) return;
      if (e.id === `${ns}:shells` && e.ok && e.result) {
        const catalog = projectTerminalShellCatalog(e.result);
        if (!catalog) {
          setError('The terminal host returned an invalid shell catalog.');
          return;
        }
        setShells(catalog.shells);
        setSelected(catalog.selected);
        openRef.current(catalog.selected);
        return;
      }
      if (e.id === `${ns}:open` && e.ok && e.result) {
        const opened = projectTerminalSession(e.result);
        if (!opened) {
          setError('The terminal host returned an invalid session.');
          setActiveLabel('Shell unavailable');
          return;
        }
        const newId = opened.id;
        if (termId && termId !== newId) term.reset();
        termId = newId;
        const cached = terminalSnapshots.get(termId);
        if (cached) {
          term.write(cached.serialized);
          next = cached.next;
        } else {
          if (opened.snapshot) term.write(opened.snapshot);
          next = opened.next;
        }
        setDead(!opened.alive);
        setError('');
        setActiveLabel(opened.label);
        window.brainrouter.send({
          kind: 'query', id: `${ns}:resize`, name: 'term-resize',
          args: { id: termId, cols: term.cols, rows: term.rows },
        });
        term.focus();
        return;
      }
      if (e.id === `${ns}:open` && !e.ok) {
        setError(e.error || 'Could not start the selected native shell.');
        setActiveLabel('Shell unavailable');
        return;
      }
      if (e.id === `${ns}:read` && e.ok && e.result) {
        const read = projectTerminalRead(e.result);
        if (!read) {
          setError('The terminal host returned an invalid output frame.');
          return;
        }
        if (read.chunk) term.write(read.chunk);
        next = read.next;
        if (!read.alive) setDead(true);
      }
    });
    openRef.current = (shellId, restart = false) => {
      if (!shellId) return;
      if (restart && termId) {
        window.brainrouter.send({
          kind: 'query', id: `${ns}:kill`, name: 'term-kill', args: { id: termId },
        });
        terminalSnapshots.delete(termId);
        termId = '';
        next = 0;
        term.reset();
      }
      setDead(false);
      setError('');
      setActiveLabel('Starting shell…');
      window.brainrouter.send({
        kind: 'query', id: `${ns}:open`, name: 'term-open',
        args: { shellId, cols: term.cols, rows: term.rows },
      });
    };
    window.brainrouter.send({ kind: 'query', id: `${ns}:shells`, name: 'term-shells' });
    const data = term.onData((d) => {
      if (termId) window.brainrouter.send({ kind: 'query', id: `${ns}:w`, name: 'term-write', args: { id: termId, data: d } });
    });
    const poll = setInterval(() => {
      if (termId) window.brainrouter.send({ kind: 'query', id: `${ns}:read`, name: 'term-read', args: { id: termId, from: next } });
    }, 200);
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
    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme(getComputedStyle(document.documentElement));
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      clearInterval(poll);
      ro.disconnect();
      themeObserver.disconnect();
      data.dispose();
      off();
      if (termId) terminalSnapshots.set(termId, { serialized: serialize.serialize(), next });
      term.dispose();
    };
  }, []);
  return (
    <div className="xterm-wrap">
      <div className="terminal-toolbar">
        <div className={`terminal-live-indicator${dead || error ? ' is-offline' : ''}`} aria-hidden="true" />
        <label className="terminal-shell-picker" title="Choose the local shell used by this terminal">
          <select aria-label="Terminal shell" value={selected} onChange={(event) => {
            const shellId = event.target.value;
            setSelected(shellId);
            openRef.current(shellId, true);
          }}>
            {shells.map((shell) => (
              <option key={shell.id} value={shell.id}>
                {shell.label}
              </option>
            ))}
          </select>
        </label>
        <button className="terminal-new-button" type="button" disabled={!selected}
          title={dead ? 'Restart shell' : 'Open a fresh terminal'}
          aria-label={dead ? 'Restart shell' : 'New terminal'}
          onClick={() => openRef.current(selected, true)}>
          {dead ? '↻' : '+'}
        </button>
        <span className="terminal-toolbar-spacer" />
        <span className={`terminal-shell-status${dead || error ? ' status-failed' : ''}`}>
          {error || (dead ? `${activeLabel} exited` : activeLabel)}
        </span>
      </div>
      <div className="xterm-host" ref={hostRef} />
      {dead ? (
        <div className="terminal-exit-notice">
          Shell exited. Choose a shell or restart this terminal.
        </div>
      ) : null}
    </div>
  );
}
