/**
 * DESK-5d — Codex/Claude-style session status icons. All real signal:
 * spinner = a turn is running here right now; amber dot = the transcript
 * ends on a user message (interrupted — waiting on a reply); hollow ring =
 * a normally-completed chat.
 */
import React from 'react';
import type { SessionRow } from '../types.js';

export function SessionStatus({ s, working }: { s: SessionRow; working?: boolean }): React.ReactElement {
  if (working) return <span className="st"><span className="spinner sm" /></span>;
  if (s.lastRole === 'user') return <span className="st st-dot warn" title="Interrupted — waiting for your reply" />;
  return <span className="st st-ring" title={s.turnCount ? `${s.turnCount} entries` : undefined} />;
}
