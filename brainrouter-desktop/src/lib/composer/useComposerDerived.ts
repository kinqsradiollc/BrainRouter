/**
 * T4 — composer/header derived state. Pure computations (memoised) over the
 * chat rows, the draft, and the shared prefs snapshot. Extracted verbatim
 * from App.tsx; no refs, no side effects. The App feeds the live inputs and
 * destructures the results back into the render.
 */
import { useMemo } from 'react';
import type { ChatRow } from '../../types.js';
import type { DeskCommand } from '../commands/commands.js';
import type { ConfigSnapshot } from '../../settings.js';
import { filterCommands } from '../../palette.js';

export interface ComposerDerivedInput {
  rows: ChatRow[];
  liveText: string;
  running: boolean;
  taskView: unknown;
  workflowView: unknown;
  slashDismissed: boolean;
  draft: string;
  commands: DeskCommand[];
  snapshot: ConfigSnapshot | null;
  info: { model?: string };
}

export interface ComposerDerived {
  sessionTitle: string;
  hasConversation: boolean;
  homeMode: boolean;
  slashActive: boolean;
  slashMatches: DeskCommand[];
  execMode: string;
  modeLabel: string;
  effort: string;
  modelChoices: string[];
}

export function useComposerDerived(i: ComposerDerivedInput): ComposerDerived {
  const { rows, liveText, running, taskView, workflowView, slashDismissed, draft, commands, snapshot, info } = i;

  const sessionTitle = useMemo(() => {
    const firstUser = rows.find((r) => r.kind === 'user') as { text: string } | undefined;
    return firstUser ? firstUser.text.slice(0, 48) : 'New session';
  }, [rows]);

  const hasConversation = useMemo(() => rows.some((r) => r.kind === 'user' || r.kind === 'assistant' || r.kind === 'tool-group'), [rows]);
  // DESK-6w — a card view (task convo / workflow) takes over the chat area, so
  // the home-mode vertical centering must NOT apply (it would push the card up).
  const homeMode = !hasConversation && !liveText && !running && !taskView && !workflowView;

  const slashActive = !slashDismissed && !running && draft.startsWith('/') && !/\s/.test(draft);
  const slashMatches = useMemo(() => (slashActive ? filterCommands(commands, draft) : []), [slashActive, commands, draft]);

  // DESK-4d² — composer control state derived from the shared prefs.
  const prefsObj = snapshot?.prefs as Record<string, unknown> | undefined;
  const execMode = String(prefsObj?.executionMode ?? 'planning');
  const reviewPolicy = String(prefsObj?.reviewPolicy ?? 'request');
  const modeLabel = execMode === 'planning' ? 'Plan mode' : reviewPolicy === 'proceed' ? 'Auto mode' : 'Accept edits';
  const effort = String(prefsObj?.effort ?? 'medium');
  const modelChoices = useMemo(() => {
    if (snapshot?.routerCatalog) {
      const routerChoices = [
        'auto',
        ...(snapshot.routerCatalog.primaryChain ?? []),
        ...((snapshot.routerCatalog.aliases ?? []).map((item) => item.id)),
        ...((snapshot.routerCatalog.canonical ?? []).map((item) => item.id)),
        ...((snapshot.routerCatalog.bare ?? []).map((item) => item.id)),
      ].filter((m): m is string => !!m);
      return [...new Set(routerChoices)];
    }
    const out = [info.model, snapshot?.fallbackModel].filter((m): m is string => !!m);
    return [...new Set(out)];
  }, [info.model, snapshot?.fallbackModel, snapshot?.routerCatalog]);

  return { sessionTitle, hasConversation, homeMode, slashActive, slashMatches, execMode, modeLabel, effort, modelChoices };
}
