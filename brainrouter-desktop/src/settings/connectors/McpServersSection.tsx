/**
 * MCP Servers settings panel — the config.json server pool grouped into Brains
 * (single-active BrainRouter memory server) and Tools (third-party MCP), plus
 * the Onyx-style add-server modal. Extracted from settings.tsx with its own
 * add-server draft state; render is unchanged.
 */
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../icons.js';
import { Row, SetGroup } from '../shared/controls.js';
import type { ConfigSnapshot } from '../shared/types.js';

export function McpServersSection({ snapshot, onAction, refreshSnapshot }: {
  snapshot: ConfigSnapshot | null;
  onAction: (id: string, name: string, args?: Record<string, unknown>) => void;
  refreshSnapshot: () => void;
}): React.ReactElement {
  const [mcp, setMcp] = useState<{ id: string; url: string; apiKey: string; headers: string }>({ id: '', url: '', apiKey: '', headers: '' });
  // Add-MCP-server modal (Onyx-style, matching the Models provider modal) — the
  // form moved out of the inline panel into a dialog opened by "+ Add server".
  const [mcpModalOpen, setMcpModalOpen] = useState(false);

  // WS9 — group the flat pool into Brains (BrainRouter memory servers, only
  // one active at a time) and Tools (third-party MCP) so the single-active-
  // brain model reads at a glance. One row renderer, shared by both groups.
  const allServers = snapshot?.servers ?? [];
  const brains = allServers.filter((s) => s.identity === 'brainrouter');
  const tools = allServers.filter((s) => s.identity !== 'brainrouter');
  const renderServer = (s: NonNullable<ConfigSnapshot['servers']>[number]) => {
    const isBrain = s.identity === 'brainrouter';
    const isActiveBrain = isBrain && snapshot?.activeServer === s.id;
    const meta = [
      s.type ?? 'unknown',
      s.type === 'http' ? (s.url ?? '') : (s.command ?? ''),
      s.hasKey ? 'key set' : '',
      s.headerCount ? `${s.headerCount} headers` : '',
      s.envCount ? `${s.envCount} env` : '',
    ].filter(Boolean).join(' · ');
    return (
      <Row key={s.id} title={s.id} desc={<><span className={`dot ${s.online ? 'on' : 'off'}`} />{s.online ? 'online' : 'offline'}{isActiveBrain ? ' · active brain' : ''}{meta ? ` — ${meta}` : ''}</>}>
        {isBrain && !isActiveBrain ? <button className="btn" title="Make this the active BrainRouter brain (only one is active at a time)" onClick={() => { onAction('a-setactive', 'action:set-active-server', { id: s.id }); setTimeout(refreshSnapshot, 120); }}>Use as active</button> : null}
        <button className="btn" onClick={() => onAction('a-reconnect', 'action:reconnect-mcp', { id: s.id })}>Reconnect</button>
        <button className="btn" title="Remove this server" onClick={() => onAction('a-rmmcp', 'action:remove-mcp', { id: s.id })}>Remove</button>
      </Row>
    );
  };
  return (
    <>
      <div className="set-h">MCP</div>
      <div className="set-desc" style={{ marginBottom: 6 }}>MCP servers from config.json — the same pool the CLI connects. All auto-reconnect in the background.</div>
      {allServers.length === 0 ? <div className="empty">No MCP servers configured (offline mode — local tools only).</div> : null}

      {allServers.length ? (
        <SetGroup title={<><Icon name="brain" size={13} /> Brains</>}>
          <div className="set-desc" style={{ marginBottom: 8 }}>BrainRouter memory servers — the identity-bearing brain. Only ONE is active at a time; others stay configured and keep reconnecting.</div>
          {brains.length ? brains.map(renderServer) : <Row title="No brain configured" desc="Add a BrainRouter MCP server below to enable memory recall." />}
        </SetGroup>
      ) : null}

      {allServers.length ? (
        <SetGroup title={<><Icon name="bolt" size={13} /> Tools</>}>
          <div className="set-desc" style={{ marginBottom: 8 }}>Third-party MCP tool servers (filesystem, web, etc.) — kept separate from the brain.</div>
          {tools.length ? tools.map(renderServer) : <Row title="No tool servers" desc="Add MCP tool servers below." />}
        </SetGroup>
      ) : null}

      <button className="btn primary" style={{ marginTop: 6 }} onClick={() => setMcpModalOpen(true)}>+ Add server</button>

      {mcpModalOpen ? (() => {
        const canAdd = !!mcp.id.trim() && !!mcp.url.trim();
        const closeModal = (): void => setMcpModalOpen(false);
        // Portal to <body> so the Settings modal's popIn transform can't clip it.
        return createPortal((
          <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
            <div className="dialog" style={{ width: 520, maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div className="dialog-title" style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 'none' }}>
                <Icon name="bolt" size={24} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                  <span>Add an MCP server</span>
                  <span className="set-desc" style={{ margin: 0, fontWeight: 400 }}>Connect a remote HTTP MCP server — the same pool the CLI uses.</span>
                </span>
              </div>
              <div className="mcp-add" style={{ gap: 5, flex: 1, minHeight: 0, overflowY: 'auto' }}>
                <div className="set-h2" style={{ marginTop: 2 }}>Name</div>
                <input className="ctl" placeholder="name (e.g. my-tools)" value={mcp.id} onChange={(e) => setMcp((m) => ({ ...m, id: e.target.value }))} />
                <div className="set-desc" style={{ margin: 0 }}>Identifies this server in the app and config.json.</div>

                <div className="set-h2">URL</div>
                <input className="ctl" placeholder="https://mcp.example.com/mcp (or /sse)" value={mcp.url} onChange={(e) => setMcp((m) => ({ ...m, url: e.target.value }))} />
                <div className="set-h2">API key <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span></div>
                <input className="ctl" type="password" placeholder="API key / Bearer token" value={mcp.apiKey} onChange={(e) => setMcp((m) => ({ ...m, apiKey: e.target.value }))} />
                <div className="set-h2">Headers <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(optional)</span></div>
                <textarea className="ctl" rows={2} placeholder="one Header-Name=value per line" value={mcp.headers} onChange={(e) => setMcp((m) => ({ ...m, headers: e.target.value }))} />
                <div className="set-desc" style={{ margin: '2px 0 0' }}>Local stdio servers can run programs, so configure them from the trusted <code>brainrouter config</code> terminal flow.</div>

                {!canAdd ? (
                  <div className="set-desc" style={{ margin: '2px 0 0', color: 'var(--warn)' }}>
                    {!mcp.id.trim() ? 'Enter a name to add the server.' : 'Enter the server URL.'}
                  </div>
                ) : null}
                <div className="set-actions" style={{ marginTop: 6 }}>
                  <button className="btn" onClick={closeModal}>Cancel</button>
                  <button className="btn primary" disabled={!canAdd}
                    onClick={() => {
                      onAction('a-addmcp', 'action:add-mcp', { id: mcp.id.trim(), type: 'http', url: mcp.url.trim(), apiKey: mcp.apiKey.trim(), headers: mcp.headers.trim() });
                      setMcp({ id: '', url: '', apiKey: '', headers: '' });
                      setMcpModalOpen(false);
                      setTimeout(refreshSnapshot, 80);
                    }}>Add server</button>
                </div>
              </div>
            </div>
          </div>
        ), document.body);
      })() : null}
    </>
  );
}
