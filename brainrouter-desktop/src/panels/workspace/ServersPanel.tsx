/**
 * Servers panel — lists the workspace's `.claude/launch.json` dev servers and
 * lets you Start/Stop each one, add a new (host-validated) config, and open a
 * running server in the IN-APP Browser panel (never the system browser). It is
 * self-contained: it talks to the host over one-shot bridgeQuery calls and takes
 * a single `onOpenInBrowser` prop for the Browser handoff.
 */
import React from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

interface ServerStatus {
  name: string;
  exe: string;
  args: string[];
  port: number;
  url: string;
  status: 'running' | 'stopped';
  pid: number | null;
  startedAt: string | null;
  error?: string;
  note?: string;
}

interface ServerListResult { servers: ServerStatus[] }

interface RuntimePreview {
  runtimeId: string;
  name: string;
  port: number;
  url: string;
  updatedAt: string;
}

interface RuntimePreviewListResult { previews: RuntimePreview[] }

export function ServersPanel({ onOpenInBrowser }: { onOpenInBrowser: (url: string) => void }): React.ReactElement {
  const [servers, setServers] = React.useState<ServerStatus[]>([]);
  const [runtimePreviews, setRuntimePreviews] = React.useState<RuntimePreview[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [pending, setPending] = React.useState<string>(''); // name being started/stopped
  const [logsFor, setLogsFor] = React.useState<string>('');
  const [logs, setLogs] = React.useState<string[]>([]);
  // Add-server form
  const [addName, setAddName] = React.useState('');
  const [addCmd, setAddCmd] = React.useState('npm');
  const [addArgs, setAddArgs] = React.useState('run dev');
  const [addPort, setAddPort] = React.useState('');
  const [addError, setAddError] = React.useState('');

  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refresh = React.useCallback(() => {
    setBusy(true);
    void Promise.allSettled([
      bridgeQuery<ServerListResult>('servers:list', {}, 10_000),
      bridgeQuery<RuntimePreviewListResult>('runtime-previews-list', {}, 10_000),
    ])
      .then(([serverResult, previewResult]) => {
        if (!mounted.current) return;
        if (serverResult.status === 'fulfilled') {
          setServers(Array.isArray(serverResult.value.servers) ? serverResult.value.servers : []);
          setError('');
        } else {
          setError(serverResult.reason instanceof Error ? serverResult.reason.message : 'Server lookup failed.');
        }
        setRuntimePreviews(
          previewResult.status === 'fulfilled' && Array.isArray(previewResult.value.previews)
            ? previewResult.value.previews
            : [],
        );
      })
      .finally(() => { if (mounted.current) setBusy(false); });
  }, []);

  React.useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const start = (name: string): void => {
    setPending(name);
    void bridgeQuery<ServerStatus>('servers:start', { name }, 40_000)
      .then((s) => { if (mounted.current && s?.error) setError(s.error); })
      .catch((err) => { if (mounted.current) setError((err as Error).message || 'Start failed.'); })
      .finally(() => { if (mounted.current) { setPending(''); refresh(); } });
  };

  const stop = (name: string): void => {
    setPending(name);
    void bridgeQuery<{ ok: boolean }>('servers:stop', { name }, 10_000)
      .catch((err) => { if (mounted.current) setError((err as Error).message || 'Stop failed.'); })
      .finally(() => { if (mounted.current) { setPending(''); refresh(); } });
  };

  const toggleLogs = (name: string): void => {
    if (logsFor === name) { setLogsFor(''); setLogs([]); return; }
    setLogsFor(name);
    void bridgeQuery<{ lines: string[] }>('servers:logs', { name }, 10_000)
      .then((r) => { if (mounted.current) setLogs(Array.isArray(r.lines) ? r.lines : []); })
      .catch(() => { if (mounted.current) setLogs([]); });
  };

  const addServer = (): void => {
    setAddError('');
    const args = addArgs.trim() ? addArgs.trim().split(/\s+/) : [];
    void bridgeQuery<{ ok: boolean; error?: string }>('servers:add', {
      name: addName.trim(), exe: addCmd.trim() || 'npm', args, port: Number(addPort) || 0,
    }, 10_000)
      .then((r) => {
        if (!mounted.current) return;
        if (r?.ok) { setAddName(''); setAddArgs('run dev'); setAddPort(''); refresh(); }
        else setAddError(r?.error || 'Could not add the server.');
      })
      .catch((err) => { if (mounted.current) setAddError((err as Error).message || 'Add failed.'); });
  };

  return (
    <div className="scroll">
      <div className="tasks-section">
        <span>Workspace dev servers</span>
        <button className="tasks-clear" type="button" onClick={refresh} disabled={busy}>{busy ? 'Refreshing...' : 'Refresh'}</button>
      </div>
      {error ? <div className="empty error">{error}</div> : null}
      {!error && servers.length === 0 ? <div className="empty">No dev servers in .claude/launch.json.</div> : null}
      {servers.map((s) => (
        <React.Fragment key={s.name}>
          <div className="task-row">
            <span className={`task-kind ${s.status === 'running' ? 'ok' : ''}`}>{s.status === 'running' ? '● running' : '○ stopped'}</span>
            <span className="file-name">{s.name} · {s.url || `:${s.port}`}</span>
            <span className="task-elapsed">{s.pid ? `pid ${s.pid}` : ''}</span>
            {s.status === 'running'
              ? <button className="task-link" type="button" disabled={pending === s.name} onClick={() => stop(s.name)}>{pending === s.name ? '…' : 'Stop'}</button>
              : <button className="task-link" type="button" disabled={pending === s.name} onClick={() => start(s.name)}>{pending === s.name ? 'Starting…' : 'Run'}</button>}
            {s.status === 'running' && s.url ? <button className="task-link" type="button" onClick={() => onOpenInBrowser(s.url)}>Open in Browser</button> : null}
            <button className="task-link" type="button" onClick={() => toggleLogs(s.name)}>{logsFor === s.name ? 'Hide logs' : 'Logs'}</button>
          </div>
          {logsFor === s.name ? (
            <div className="task-row" style={{ display: 'block' }}>
              <pre className="server-logs" style={{ margin: 0, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', opacity: 0.8 }}>
                {logs.length ? logs.join('\n') : 'No output captured yet.'}
              </pre>
            </div>
          ) : null}
        </React.Fragment>
      ))}
      <div className="tasks-section"><span>Runtime previews</span></div>
      <div className="set-desc" style={{ padding: '0 8px 8px' }}>
        Live loopback endpoints registered by isolated runtimes. Configure durable port defaults in Settings → Automation → Runtime.
      </div>
      {runtimePreviews.length === 0 ? <div className="empty">No live runtime previews.</div> : null}
      {runtimePreviews.map((preview) => (
        <div className="task-row" key={`${preview.runtimeId}:${preview.name}`}>
          <span className="task-kind ok">● registered</span>
          <span className="file-name">{preview.name} · {preview.url}</span>
          <span className="task-elapsed">{preview.runtimeId}</span>
          <button className="task-link" type="button" onClick={() => onOpenInBrowser(preview.url)}>Open in Browser</button>
        </div>
      ))}
      <div className="tasks-section"><span>Add a dev server</span></div>
      <div className="task-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 8 }}>
        <input className="br-type" placeholder="name" value={addName} onChange={(e) => setAddName(e.target.value)} />
        <input className="br-type" placeholder="port" value={addPort} onChange={(e) => setAddPort(e.target.value)} />
        <input className="br-type" placeholder="command (npm)" value={addCmd} onChange={(e) => setAddCmd(e.target.value)} />
        <input className="br-type" placeholder="args (run dev)" value={addArgs} onChange={(e) => setAddArgs(e.target.value)} />
      </div>
      {addError ? <div className="empty error">{addError}</div> : null}
      <div className="task-row" style={{ justifyContent: 'flex-end', padding: 8 }}>
        <button className="task-link" type="button" onClick={addServer} disabled={!addName.trim() || !addPort.trim()}>Add server</button>
      </div>
    </div>
  );
}
