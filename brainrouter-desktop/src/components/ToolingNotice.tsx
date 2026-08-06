/**
 * ADR-028 I1 — what is missing, and the one click that fixes it.
 *
 * Shown once per launch, never blocking. A missing tool disables one feature;
 * it does not gate the app, so this is a dismissible line rather than a modal.
 *
 * The install command is visible BEFORE it runs. A one-click install whose
 * command is hidden is asking for trust it has not earned, and someone who
 * would rather run it in their own shell must be able to read it first.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button } from './primitives/Button.js';
import { bridgeQuery } from '../lib/bridgeQuery.js';

interface Requirement { id: string; label: string; unlocks: string; installCommand: string }
type Plan =
  | { kind: 'ready' }
  | { kind: 'offer' | 'blocked'; missing: Requirement[]; message: string };

export function ToolingNotice(): React.ReactElement | null {
  const [plan, setPlan] = useState<Plan>({ kind: 'ready' });
  const [showCommand, setShowCommand] = useState<string | null>(null);

  useEffect(() => {
    // Checked ONCE per launch. Probing three binaries every turn taxes every
    // session for an answer that changes when someone installs software.
    void bridgeQuery<{ plan: Plan }>('tooling-check', {})
      .then((r) => { if (r?.plan) setPlan(r.plan); })
      .catch(() => { /* a probe that fails is not worth a banner */ });
  }, []);

  const decline = useCallback((id: string) => {
    // Remembered, so the same offer is never made twice. Asking again next
    // launch is how a prompt becomes noise, and then the one that matters gets
    // dismissed reflexively.
    void bridgeQuery('tooling-decline', { id }).catch(() => {});
    setPlan({ kind: 'ready' });
  }, []);

  if (plan.kind === 'ready') return null;
  const first = plan.missing[0];
  if (!first) return null;

  return (
    <div className={`tool-notice${plan.kind === 'blocked' ? ' blocked' : ''}`}>
      <span className="tool-notice-msg">{plan.message}</span>

      {showCommand ? (
        <code className="tool-notice-cmd">{showCommand}</code>
      ) : null}

      <div className="tool-notice-actions">
        <Button
          variant="default"
          onClick={() => setShowCommand(showCommand ? null : first.installCommand)}
        >
          {showCommand ? 'Hide command' : 'Show command'}
        </Button>
        {plan.kind === 'offer' ? (
          <button className="tool-notice-skip" onClick={() => decline(first.id)}>Not now</button>
        ) : null}
      </div>
    </div>
  );
}
