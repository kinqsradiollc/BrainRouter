/**
 * §5.10 — five friendly permission modes that each set the access tier, approval
 * (executionMode × reviewPolicy), sandbox, and out-of-workspace policy in one
 * click. The highlighted card is the nearest match to the stored combination.
 */
import React from 'react';
import { PERMISSION_MODES, policyForMode, nearestMode } from '@kinqs/brainrouter-core/session/permission-modes';

export function PermissionModeCards({ ps, ks, onPref, onAction, setKnob }: {
  ps: (key: string, def: string) => string;
  ks: (key: string, def: string) => string;
  onPref: (key: string, value: string) => void;
  onAction: (id: string, action: string, args: Record<string, unknown>) => void;
  setKnob: (key: string, value: string) => void;
}): React.ReactElement {
  const current = nearestMode({
    executionMode: ps('executionMode', 'planning') as 'planning' | 'fast',
    reviewPolicy: ps('reviewPolicy', 'request') as 'request' | 'proceed',
    sandbox: ks('sandbox', 'off') as 'off' | 'on',
    externalDirWrites: ks('externalDirWrites', 'ask') as 'deny' | 'ask' | 'allow',
  });
  const apply = (id: (typeof PERMISSION_MODES)[number]['id']): void => {
    const p = policyForMode(id);
    if (!p) return;
    onPref('executionMode', p.executionMode);
    onPref('reviewPolicy', p.reviewPolicy);
    onAction('a-access', 'action:set-access', { mode: p.accessMode });
    setKnob('sandbox', p.sandbox);
    setKnob('externalDirWrites', p.externalDirWrites);
  };
  return (
    <div className="perm-modes">
      {PERMISSION_MODES.map((m) => (
        <button key={m.id} type="button" className={`perm-card${current === m.id ? ' active' : ''}`} onClick={() => apply(m.id)}>
          <div className="perm-card-label">{m.label}</div>
          <div className="perm-card-desc">{m.description}</div>
        </button>
      ))}
    </div>
  );
}
