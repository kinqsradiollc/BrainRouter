/**
 * DESK-5d — Codex/Claude-style session status icons. All real signal:
 * spinner = a turn is running here right now; amber dot = the transcript
 * ends on a user message (interrupted — waiting on a reply); hollow ring =
 * a normally-completed chat.
 */
import React from 'react';
import type { SessionRow } from '../types.js';
import { Icon } from '../icons.js';
import { prStatusLabel, type PrStatus, type PrStatusRow } from '../lib/ci/prStatus.js';

export function SessionStatus({ s, working }: { s: SessionRow; working?: boolean }): React.ReactElement {
  if (working) return <span className="st"><span className="spinner sm" /></span>;
  if (s.lastRole === 'user') return <span className="st st-dot warn" title="Interrupted — waiting for your reply" />;
  return <span className="st st-ring" title={s.turnCount ? `${s.turnCount} entries` : undefined} />;
}

// §session-pr — per-session PR status glyph. Reuses existing icons; the colour
// comes from the `.st-pr-<status>` class (theme.css).
const PR_ICON: Record<PrStatus, string> = { open: 'branch', draft: 'branch', conflict: 'warn', merged: 'merge', closed: 'close' };
export function PrStatusIcon({ status, pr }: { status: PrStatus; pr: PrStatusRow }): React.ReactElement {
  return (
    <span className={`st st-pr st-pr-${status}`} title={`PR #${pr.number ?? '?'} · ${prStatusLabel(status)}`}>
      <Icon name={PR_ICON[status]} size={11} />
    </span>
  );
}
