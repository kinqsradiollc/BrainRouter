/**
 * T4 — modal interaction overlays: the multiple-choice question dialog (when
 * an agent asks the user to pick) and the "Do you trust this folder?" prompt
 * shown before opening a workspace. Extracted verbatim from App.tsx; the App
 * owns the state and the answer/switch handlers.
 */
import React, { type Dispatch, type SetStateAction } from 'react';
import type { InteractionRequest } from '@kinqs/brainrouter-agent-protocol';

type InteractionResponse = { type: 'confirm'; approved: boolean } | { type: 'choice'; labels: string[] } | { type: 'dismissed' };

export interface InteractionDialogsProps {
  interaction: InteractionRequest | null;
  picked: string[];
  setPicked: Dispatch<SetStateAction<string[]>>;
  answerInteraction: (response: InteractionResponse) => void;
  trustAsk: { root: string; resume?: string } | null;
  setTrustAsk: Dispatch<SetStateAction<{ root: string; resume?: string } | null>>;
  switchToWorkspace: (root: string, resumeKey?: string) => void;
}

export function InteractionDialogs(p: InteractionDialogsProps): React.ReactElement | null {
  const { interaction, picked, setPicked, answerInteraction, trustAsk, setTrustAsk, switchToWorkspace } = p;
  return (
    <>
      {interaction && interaction.type === 'choice' ? (
        <div className="overlay" onKeyDown={(e) => {
          if (e.key === 'Escape') answerInteraction({ type: 'dismissed' });
        }} tabIndex={-1} ref={(el) => el?.focus()}>
          <div className="dialog">
            {(
              <>
                <div className="dialog-title">{interaction.question}</div>
                <div className="dialog-options">
                  {interaction.options.map((o) => (
                    <label key={o.label} className={`opt${picked.includes(o.label) ? ' picked' : ''}`}
                      onClick={() => setPicked((p) => interaction.multiSelect
                        ? (p.includes(o.label) ? p.filter((x) => x !== o.label) : [...p, o.label])
                        : [o.label])}>
                      <b>{o.label}</b><span>{o.description}</span>
                    </label>
                  ))}
                </div>
                <div className="dialog-actions">
                  <button className="approve" disabled={picked.length === 0}
                    onClick={() => answerInteraction({ type: 'choice', labels: picked })}>Answer</button>
                  <button className="deny" onClick={() => answerInteraction({ type: 'dismissed' })}>Dismiss</button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {trustAsk ? (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setTrustAsk(null); }}>
          <div className="dialog" style={{ width: 460 }}>
            <div className="dialog-title">Do you trust this folder?</div>
            <div className="set-desc" style={{ marginBottom: 10 }}>
              BrainRouter may read, write, and execute files in this project once it opens.
              Trusting adds it to your projects — its chats live in the sidebar alongside your other projects.
            </div>
            <pre className="dialog-detail">{trustAsk.root}</pre>
            <div className="dialog-actions">
              <button className="deny" onClick={() => setTrustAsk(null)}>Cancel</button>
              <button className="approve" autoFocus onClick={() => {
                // T1 — persist trust in the shared CLI store (main enforces it),
                // not renderer localStorage. Optimistically show the project now.
                const root = trustAsk.root, resume = trustAsk.resume;
                setTrustAsk(null);
                void window.brainrouter.trustWorkspace(root).then(() => switchToWorkspace(root, resume));
              }}>Trust & open</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
