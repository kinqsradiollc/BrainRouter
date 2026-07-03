/** The Tool calls panel: a reverse-chronological log of this session's tool runs. */
import React from 'react';

export function ToolsPanel({ log }: { log: Array<{ id: number; tool: string; ok: boolean; summary: string }> }): React.ReactElement {
  return (
    <div className="scroll">
      {log.length === 0 ? <div className="empty">No tool calls yet.</div> : log.slice().reverse().map((t) => (
        <div key={t.id} className="toollog-row"><span className={t.ok ? 'okdot' : 'faildot'} />{t.tool} — {t.summary}</div>
      ))}
    </div>
  );
}
