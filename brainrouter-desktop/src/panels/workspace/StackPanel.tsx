/**
 * ADR-028 A8 — the stack panel.
 *
 * Shows the chain bottom-up, each layer's readiness, the named blocker, and how
 * far a single merge could reach. Read-only first: mutation controls appear
 * only for operations that are already reachable with their confirmations.
 *
 * This component renders; it does not decide. Every judgement — which layer is
 * blocked, what by, which is mergeable, whether a control belongs on screen —
 * comes from `stackPanelView`, so the reasoning is unit-tested without Electron
 * and the markup stays readable.
 */
import React, { useState } from 'react';
import { Icon } from '../../icons.js';
import { Button } from '../../components/primitives/Button.js';
import {
  layerStatus, highestMergeable, mergeButtonLabel, showsAction, unavailableNotice, stackSummary,
  type StackLayerView, type StackAvailability, type LayerReadiness,
} from '../../lib/stack/stackPanelView.js';

/** Bottom-up: layer 1 is the one targeting trunk, and it reads bottom-first. */
function ordered(layers: readonly StackLayerView[]): StackLayerView[] {
  return [...layers].sort((a, b) => a.position - b.position);
}

const READINESS_LABEL: Record<LayerReadiness, string> = {
  merged: 'merged',
  ready: 'ready',
  queued: 'queued',
  waiting_on_checks: 'checks',
  waiting_on_review: 'review',
  changes_requested: 'changes',
  needs_sync: 'sync',
  blocked_below: 'blocked',
};

export function StackPanel({
  layers, availability, onView, onSync, onMerge, onOpenPr, busy,
}: {
  layers: StackLayerView[];
  availability: StackAvailability;
  onView: () => void;
  onSync: (rewrites: StackLayerView[]) => void;
  onMerge: (target: StackLayerView) => void;
  onOpenPr: (number: number) => void;
  busy?: boolean;
}): React.ReactElement {
  const [confirming, setConfirming] = useState<'sync' | 'merge' | null>(null);

  const chain = ordered(layers);
  const notice = unavailableNotice(availability);
  const mergeable = highestMergeable(chain);
  // Syncing rewrites the history of everything above the bottom unmerged layer.
  const rewrites = chain.filter((l) => !l.merged).slice(1);

  return (
    <div className="scroll stack-panel">
      <div className="sched-add">
        <div className="stack-head">
          <span className="stack-summary">{stackSummary(chain)}</span>
          {showsAction('view', availability) ? (
            <Button variant="default" onClick={onView} disabled={busy}>
              <Icon name="refresh" size={11} /> Refresh
            </Button>
          ) : null}
        </div>

        {notice ? (
          // Said once, at the top, rather than as a tooltip on a disabled
          // button nobody hovers.
          <div className="stack-notice">{notice}</div>
        ) : null}
      </div>

      {chain.length === 0 && !notice ? (
        <div className="empty">
          <span className="empty-title">No stack on this branch</span>
          <span className="empty-note">
            A stack is a chain of pull requests, each based on the one below it. Plan phases that
            build on each other become one automatically.
          </span>
        </div>
      ) : null}

      {chain.map((layer) => {
        const status = layerStatus(layer, chain);
        return (
          <button
            key={layer.number}
            className={`req-row stack-row st-${status.readiness}`}
            onClick={() => onOpenPr(layer.number)}
            title={`Open #${layer.number}`}
          >
            <span className="stack-pos">{layer.position}</span>
            <span className={`req-status st-${status.readiness}`}>
              {READINESS_LABEL[status.readiness]}
            </span>
            <span className="req-title">{layer.title}</span>
            <span className="req-id">#{layer.number}</span>
            {/* Last, so it wraps onto its own line beneath the title rather than
                competing with it. The blocker is the sentence that makes the row
                useful — never "not ready", always the specific thing to go do. */}
            {status.blocker ? <span className="stack-blocker">{status.blocker}</span> : null}
          </button>
        );
      })}

      {chain.length > 0 && !notice ? (
        <div className="stack-actions">
          {showsAction('sync', availability) && rewrites.length > 0 ? (
            <Button variant="default" onClick={() => setConfirming('sync')} disabled={busy}>
              Sync
            </Button>
          ) : null}
          {showsAction('merge', availability) && mergeable ? (
            <Button variant="primary" onClick={() => setConfirming('merge')} disabled={busy}>
              {mergeButtonLabel(mergeable, chain)}
            </Button>
          ) : null}
        </div>
      ) : null}

      {confirming === 'sync' ? (
        <div className="stack-confirm">
          {/* Consent to "sync the stack" is not consent to rewrite six branches
              you had forgotten were in it, so they are named. */}
          <div className="stack-confirm-title">
            This rewrites the history of {rewrites.length} branch
            {rewrites.length === 1 ? '' : 'es'}
          </div>
          <ul className="stack-confirm-list">
            {rewrites.map((l) => (
              <li key={l.number}>#{l.number} — {l.title}</li>
            ))}
          </ul>
          <div className="stack-confirm-note">
            Review comments on rewritten commits may become detached.
          </div>
          <div className="stack-actions">
            <Button variant="default" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { setConfirming(null); onSync(rewrites); }}>
              Sync {rewrites.length} branch{rewrites.length === 1 ? '' : 'es'}
            </Button>
          </div>
        </div>
      ) : null}

      {confirming === 'merge' && mergeable ? (
        <div className="stack-confirm">
          {/* All-or-nothing, so the confirmation names every pull request that
              lands. "Merge #12" that silently lands #9–#11 has not obtained
              consent for what happens. */}
          {(() => {
            const landing = chain.filter((l) => l.position <= mergeable.position && !l.merged);
            return (
              <>
                <div className="stack-confirm-title">
                  {landing.length === 1
                    ? 'This merges one pull request'
                    : `These ${landing.length} land together, bottom-first`}
                </div>
                <ul className="stack-confirm-list">
                  {landing.map((l) => <li key={l.number}>#{l.number} — {l.title}</li>)}
                </ul>
              </>
            );
          })()}
          <div className="stack-confirm-note">
            A stack merge can take a minute or more. It is still running until it says otherwise.
          </div>
          <div className="stack-actions">
            <Button variant="default" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { setConfirming(null); onMerge(mergeable); }}>
              Merge
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
