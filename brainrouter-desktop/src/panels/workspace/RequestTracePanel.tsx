/**
 * ADR-041 D14 (glass box, commitment #1) — the Request Inspector panel. Renders
 * the per-request header trace for the active session (`request-trace.jsonl`,
 * written by the agent runtime when `cli.traceRequests` is on): for each recent
 * LLM request, the model, effort, message/tool counts, the exact tool names, and
 * a bounded excerpt of the rendered system prompt — what the model actually saw.
 * Self-contained: one-shot `bridgeQuery('request-trace:read')` on a light poll.
 */
import React from 'react';
import { bridgeQuery } from '../../lib/bridgeQuery.js';
import { usePanelPolling } from '../../lib/panels/usePanelPolling.js';

interface RequestTraceRecord {
  at: string;
  model: string;
  endpoint?: string;
  effort?: string;
  messageCount: number;
  systemChars: number;
  systemExcerpt: string;
  toolNames: string[];
}

interface RequestTraceResult { records: RequestTraceRecord[] }

export function RequestTracePanel({ active = true }: { active?: boolean }): React.ReactElement {
  const [records, setRecords] = React.useState<RequestTraceRecord[]>([]);
  const [error, setError] = React.useState('');
  const [loaded, setLoaded] = React.useState(false);

  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const res = await bridgeQuery<RequestTraceResult>('request-trace:read', { limit: 30 }, 10_000);
      if (!mounted.current) return;
      setRecords(Array.isArray(res.records) ? res.records : []);
      setError('');
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Request trace lookup failed.');
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, []);

  usePanelPolling({ active, intervalMs: 3_000, refresh });

  if (error) return <div className="scroll"><div className="empty">{error}</div></div>;
  if (loaded && records.length === 0) {
    return (
      <div className="scroll">
        <div className="empty">
          No request trace yet. Turn it on with <code>&quot;cli&quot;: {'{'} &quot;traceRequests&quot;: true {'}'}</code> in
          your config, then run a turn — each request the model sees is captured here.
        </div>
      </div>
    );
  }

  // Newest first for reading.
  const rows = [...records].reverse();
  return (
    <div className="scroll">
      {rows.map((r, i) => (
        <div className="task-row" key={`${r.at}-${i}`} style={{ display: 'block', padding: '8px 10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <strong>{r.model}</strong>
            <span style={{ opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>{r.at}</span>
          </div>
          <div style={{ opacity: 0.75, fontSize: '0.82em', marginTop: 2 }}>
            {r.messageCount} messages · system {r.systemChars} chars · {r.toolNames.length} tools
            {r.effort ? ` · effort ${r.effort}` : ''}
            {r.endpoint ? ` · ${r.endpoint}` : ''}
          </div>
          {r.toolNames.length > 0 && (
            <div style={{ opacity: 0.6, fontSize: '0.78em', marginTop: 2 }}>
              tools: {r.toolNames.join(', ')}
            </div>
          )}
          {r.systemExcerpt && (
            <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', fontSize: '0.78em', opacity: 0.85, maxHeight: 160, overflow: 'auto' }}>
              {r.systemExcerpt}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
