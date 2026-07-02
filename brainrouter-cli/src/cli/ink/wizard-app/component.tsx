import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from 'ink';
import {
  initWizardState,
  reduceWizard,
  type WizardDraft,
  type WizardState,
} from '../../wizard/types.js';
import type { ThemeMode } from '../../theme.js';
import { ACCENT } from './shared.js';
import {
  WelcomeStep,
  ThemeStep,
  ProviderStep,
  ApiKeyStep,
  ModelStep,
  McpStep,
  AgentMdStep,
  DoneStep,
} from './steps.js';

/**
 * Ink-based wizard. Replaces the raw-stdout `runWizard` runner
 * (which had compounding redraw bugs no matter how many off-by-one
 * fixes we applied — Ink owns the render loop and diffs the cell
 * grid, so frames never stack or creep).
 *
 * Driver pattern:
 *   - One `<WizardApp>` mounts at the top-level (`render(<WizardApp>)`).
 *   - It picks ONE child to render based on `state.currentStep`.
 *   - Each step is its own component (`<WelcomeStep>`, `<ThemeStep>`,
 *     etc.) that takes a `state` + `onAdvance` / `onBack` /
 *     `onAbort` / `onWarn` callback.
 *   - On terminal step (done / abort), the wizard calls
 *     `useApp().exit()` and `props.onFinish(state)` so the caller
 *     can persist + unmount.
 */

export interface WizardAppProps {
  workspaceRoot: string;
  /** Fires once the wizard reaches a terminal state. */
  onFinish: (state: WizardState) => void;
}

export function WizardApp({ workspaceRoot, onFinish }: WizardAppProps) {
  const [state, setState] = useState<WizardState>(() => initWizardState());
  const { exit } = useApp();

  // Use refs for the callbacks so child components receive STABLE
  // references across renders. Otherwise every render gives them a new
  // function identity, which (a) makes their useEffect dependency
  // arrays churn (re-firing preview/probe effects) and (b) prevents
  // React from skipping re-renders. The stable-callback ref pattern is
  // canonical for React 18/19 component composition.
  const onFinishRef = useRef(onFinish);
  useEffect(() => { onFinishRef.current = onFinish; });

  // Notify the caller + exit Ink when the wizard reaches terminal.
  // Dep on state.aborted + state.committed only — not on `state` or
  // `onFinish` — so the effect fires exactly ONCE per terminal
  // transition. (Earlier code depended on `state` itself, which fired
  // the effect on every state update; harmless but wasteful.)
  useEffect(() => {
    if (state.aborted || state.committed) {
      onFinishRef.current(state);
      exit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.aborted, state.committed]);

  const theme: ThemeMode = state.draft.theme ?? 'dark';
  const accent = ACCENT[theme];

  const dispatchAdvance = useCallback((patch: Partial<WizardDraft>) =>
    setState((s) => reduceWizard(s, { kind: 'advance', patch })), []);
  const dispatchWarn = useCallback((message: string) =>
    setState((s) => reduceWizard(s, { kind: 'warn', message })), []);
  const dispatchAbort = useCallback(() => setState((s) => reduceWizard(s, { kind: 'abort' })), []);
  const dispatchCommit = useCallback(() => setState((s) => reduceWizard(s, { kind: 'commit' })), []);

  switch (state.currentStep) {
    case 'welcome':
      return <WelcomeStep accent={accent} onAdvance={() => dispatchAdvance({})} onAbort={dispatchAbort} />;
    case 'theme':
      return (
        <ThemeStep
          accent={accent}
          onPick={(mode) => dispatchAdvance({ theme: mode })}
          onAbort={dispatchAbort}
        />
      );
    case 'provider':
      return (
        <ProviderStep
          accent={accent}
          onPick={(provider, customEndpoint) => dispatchAdvance({ provider, customEndpoint })}
          onAbort={dispatchAbort}
        />
      );
    case 'apiKey':
      return (
        <ApiKeyStep
          accent={accent}
          provider={state.draft.provider!}
          onAccept={(apiKey, warning) => {
            if (warning) dispatchWarn(warning);
            dispatchAdvance({ apiKey });
          }}
          onAbort={dispatchAbort}
        />
      );
    case 'model':
      return (
        <ModelStep
          accent={accent}
          provider={state.draft.provider!}
          apiKey={state.draft.apiKey ?? ''}
          customEndpoint={state.draft.customEndpoint}
          onPick={(model) => dispatchAdvance({ model })}
          onAbort={dispatchAbort}
        />
      );
    case 'mcp':
      return (
        <McpStep
          accent={accent}
          draft={state.draft}
          onAccept={(mcp, warning) => {
            if (warning) dispatchWarn(warning);
            dispatchAdvance({ mcp });
          }}
          onAbort={dispatchAbort}
        />
      );
    case 'agentMd':
      return (
        <AgentMdStep
          accent={accent}
          workspaceRoot={workspaceRoot}
          onPick={(writeAgentMd) => dispatchAdvance({ writeAgentMd })}
          onAbort={dispatchAbort}
        />
      );
    case 'done':
      // Commit immediately on mount; render the summary while the caller
      // persists.
      return <DoneStep state={state} accent={accent} onCommit={dispatchCommit} />;
  }
}
