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
import { installPreview, type ProvisionAction } from '@kinqs/brainrouter-core/tooling';
import { Button } from './primitives/Button.js';
import { bridgeQuery } from '../lib/bridgeQuery.js';

/**
 * The plan type comes from the module that PRODUCES it. A structural copy lived
 * here and omitted the `auto_install` arm, so the default configuration — the
 * one Part I exists for — reached `plan.missing[0]` on an action that has no
 * `missing`, and the banner threw during render instead of reporting the
 * install. A notice that crashes reports nothing.
 */
type Plan = ProvisionAction;

export interface ToolingNoticeBodyProps {
  plan: Plan;
  /** Labels the host actually installed — what it TRIED is `plan.install`. */
  installed: string[];
  showCommand: string | null;
  setShowCommand: (command: string | null) => void;
  decline: (id: string) => void;
}

/**
 * Split out from the fetching shell so every arm can be rendered and asserted
 * without a DOM. The arm that crashed was unreachable from any test precisely
 * because the only way to reach it was an effect nothing could drive.
 */
export function ToolingNoticeBody(p: ToolingNoticeBodyProps): React.ReactElement | null {
  const { plan, installed, showCommand, setShowCommand, decline } = p;
  if (plan.kind === 'ready') return null;

  // The auto-install arm is the REPORT half of I1: it already ran, so there is
  // nothing to decline — what is owed is what ran and whether it worked. The
  // command stays inspectable afterwards, since "it installed something" is
  // only useful if you can see what.
  if (plan.kind === 'auto_install') {
    const ran = plan.install[0];
    // Reporting the attempt as an outcome would be the same class of claim this
    // whole notice exists to stop.
    const failed = plan.install.filter((r) => !installed.includes(r.label));
    return (
      <div className={`tool-notice${failed.length > 0 ? ' blocked' : ''}`}>
        <span className="tool-notice-msg">
          {installed.length > 0 ? `Installed ${installed.join(', ')}. ` : ''}
          {failed.length > 0
            ? `Could not install ${failed.map((r) => r.label).join(', ')} — run it yourself, or check that the GitHub CLI is signed in.`
            : `This unlocks ${plan.install.map((r) => r.unlocks).join(', ')}. Turn it off in settings if you would rather install tools yourself.`}
        </span>

        {showCommand ? <code className="tool-notice-cmd">{showCommand}</code> : null}

        {ran ? (
          <div className="tool-notice-actions">
            <Button
              variant="default"
              onClick={() => setShowCommand(showCommand ? null : ran.installCommand)}
            >
              {showCommand ? 'Hide command' : 'Show what ran'}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

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
          // `installPreview`, not the bare command. It is core's wording for
          // this exact moment — what runs, what it installs, and that you may
          // run it yourself — and it had no caller until 2026-08-12 while this
          // button showed the command with none of that around it. I1's own
          // sentence is that a one-click install whose command is hidden is
          // asking for trust it has not earned; a command with no explanation
          // is most of the way back to hidden.
          onClick={() => setShowCommand(showCommand ? null : installPreview(first))}
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

export function ToolingNotice(): React.ReactElement | null {
  const [plan, setPlan] = useState<Plan>({ kind: 'ready' });
  const [installed, setInstalled] = useState<string[]>([]);
  const [showCommand, setShowCommand] = useState<string | null>(null);

  useEffect(() => {
    // Checked ONCE per launch. Probing three binaries every turn taxes every
    // session for an answer that changes when someone installs software.
    void bridgeQuery<{ plan: Plan; installed?: string[] }>('tooling-check', {})
      .then((r) => {
        if (!r?.plan) return;
        setPlan(r.plan);
        setInstalled(r.installed ?? []);
      })
      .catch(() => { /* a probe that fails is not worth a banner */ });
  }, []);

  const decline = useCallback((id: string) => {
    // Remembered, so the same offer is never made twice. Asking again next
    // launch is how a prompt becomes noise, and then the one that matters gets
    // dismissed reflexively.
    void bridgeQuery('tooling-decline', { id }).catch(() => {});
    setPlan({ kind: 'ready' });
  }, []);

  return (
    <ToolingNoticeBody
      plan={plan}
      installed={installed}
      showCommand={showCommand}
      setShowCommand={setShowCommand}
      decline={decline}
    />
  );
}
