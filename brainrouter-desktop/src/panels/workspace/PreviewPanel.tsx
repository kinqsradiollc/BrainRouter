import React from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';

interface PreviewReservation {
  name: string;
  port: number;
  url: string;
}

interface RuntimePreview {
  runtimeId: string;
  name: string;
  port: number;
  url: string;
  updatedAt: string;
}

interface PreviewListResult {
  reservations: PreviewReservation[];
  previews: RuntimePreview[];
}

function updatedLabel(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

export function PreviewPanel(): React.ReactElement {
  const [data, setData] = React.useState<PreviewListResult>({ reservations: [], previews: [] });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(() => {
    setBusy(true);
    setError('');
    void bridgeQuery<PreviewListResult>('runtime-previews-list', {}, 10_000)
      .then((result) => setData({
        reservations: Array.isArray(result.reservations) ? result.reservations : [],
        previews: Array.isArray(result.previews) ? result.previews : [],
      }))
      .catch((err) => setError((err as Error).message || 'Preview lookup failed.'))
      .finally(() => setBusy(false));
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="scroll">
      <div className="tasks-section">
        <span>App previews</span>
        <button className="tasks-clear" type="button" onClick={refresh} disabled={busy}>{busy ? 'Refreshing...' : 'Refresh'}</button>
      </div>
      {error ? <div className="empty error">{error}</div> : null}
      {!error && data.previews.length === 0 ? <div className="empty">No runtime preview is registered.</div> : null}
      {data.previews.map((preview) => (
        <div key={`${preview.runtimeId}:${preview.name}`} className="task-row">
          <span className="task-kind">{preview.name}</span>
          <span className="file-name">{preview.url}</span>
          <span className="task-elapsed">{updatedLabel(preview.updatedAt)}</span>
          <button
            className="task-link"
            type="button"
            onClick={() => window.brainrouter.send({ kind: 'query', id: `preview-open:${preview.runtimeId}:${preview.name}`, name: 'action:open-external', args: { url: preview.url } } as never)}
          >
            Open
          </button>
        </div>
      ))}
      <div className="tasks-section"><span>Reserved ports</span></div>
      {data.reservations.length === 0 ? <div className="empty">No preview ports are reserved in settings.</div> : null}
      {data.reservations.map((reservation) => (
        <div key={reservation.name} className="task-row">
          <span className="task-kind">{reservation.name}</span>
          <span className="file-name">{reservation.url}</span>
          <span className="task-elapsed">:{reservation.port}</span>
        </div>
      ))}
    </div>
  );
}
