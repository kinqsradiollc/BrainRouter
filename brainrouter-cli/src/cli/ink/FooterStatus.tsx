import React from 'react';
import { Box, Text } from 'ink';
import { effortIndicator } from './reasoningWindow.js';
import { formatContextWindow } from '@kinqs/brainrouter-core/context';
import type { FooterState } from './ChatApp.js';

/**
 * REFAC-CHATAPP-SPLIT part 3 (0.4.6) — the footer status line, extracted
 * verbatim from ChatApp.tsx. Presentational (props in, JSX out); FooterState is
 * a type-only import from ChatApp so there's no runtime cycle. No behavior change.
 */
export function FooterStatus({
  promptLabel,
  phase,
  accentColor,
  accessMode,
  footer,
  cols,
}: {
  promptLabel: string;
  phase: 'idle' | 'turn-running';
  accentColor: string;
  accessMode: 'read' | 'write' | 'shell';
  footer: FooterState;
  /** Live terminal width, drives progressive collapse on narrow terminals. */
  cols: number;
}) {
  // Pill background mirrors the readline REPL's mode-to-token mapping:
  //   read  → green   (safe)
  //   write → accent  (default brand)
  //   shell → red     (escalated)
  // See cli/repl.ts:refreshPromptForMode for the rationale.
  const pillBg = accessMode === 'shell' ? 'red' : accessMode === 'write' ? accentColor : 'green';
  const pillFg = 'black';
  // Effort glyphs — claude-code v2.1.147 convention:
  //   low    → ○ (open circle, light)
  //   medium → ◐ (half circle)
  //   high   → ● (filled circle, heavy)
  // Rendered inline next to the pill, not as a separate boxed pill, so
  // the footer stays compact on narrow terminals.
  // `max` is the user-facing alias for `xhigh` (normalizeEffort canonicalises
  // it, but handle the literal defensively too). xhigh gets its own heavier
  // glyph + colour so the top reasoning tier is visible in the footer.
  const { glyph: effortGlyph, color: effortColor } = effortIndicator(footer.effort);

  // Left side: model (· Nk ctx) · session · branch. Right: ? for shortcuts.
  // The "Nk ctx" segment surfaces the model's max prompt context so the
  // user can see how close they are to the limit. Lookup lives in
  // `runtime/contextWindow.ts`; unknown models render "?" rather than
  // a guess. Override via ~/.config/brainrouter/contextWindows.json.
  const leftSegs: string[] = [];
  if (footer.model) {
    const ctxLabel = formatContextWindow(footer.model);
    leftSegs.push(`${footer.model}${ctxLabel !== '?' ? ` · ${ctxLabel} ctx` : ''}`);
  }
  if (footer.session) leftSegs.push(footer.session);
  if (footer.branch) leftSegs.push(footer.branch);
  if (footer.rightExtra) leftSegs.push(footer.rightExtra);

  // Progressive collapse.
  // Below 80 cols, drop the auxiliary left segments (model · session ·
  // branch). Below 60 cols, drop the right-side hint. Below 40 cols,
  // even the effort glyph collapses to just the access pill — that's
  // the smallest viable status row.
  const isSidebarVisible = cols >= 100;
  const showLeftSegs = cols >= 80 && leftSegs.length > 0 && !isSidebarVisible;
  const showEffortLabel = cols >= 50 && !isSidebarVisible;
  const showEffortGlyph = !!effortGlyph && cols >= 40 && !isSidebarVisible;
  const showRightHint = cols >= 60;
  const rightText = showRightHint
    ? (cols >= 80 ? '? for shortcuts  ·  / for commands' : '?  ·  /')
    : '';

  // Render the WHOLE footer as a single Text with nested Text children
  // for the colored pill and glyphs. wrap="truncate" on the outer Text
  // ensures it NEVER visually wraps (which is what causes Ink's diff
  // to leave residue on resize — each wrap-overflow row that Ink
  // thinks is 1 logical row but is 2+ visual rows accumulates as
  // duplicated composer/footer blocks on every resize).
  //
  // Ink supports nested Text — children inherit parent props (like
  // wrap) but their own color/backgroundColor/bold etc. apply locally.
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text wrap="truncate">
        <Text backgroundColor={pillBg} color={pillFg}>{` ◉ ${accessMode} `}</Text>
        {showEffortGlyph ? (
          <Text>
            {'  '}
            <Text color={effortColor}>{effortGlyph}</Text>
            {showEffortLabel ? <Text color="gray" dimColor>{` ${footer.effort}`}</Text> : null}
          </Text>
        ) : null}
        {showLeftSegs ? (
          <Text color="gray" dimColor>{'  ' + leftSegs.join(' · ')}</Text>
        ) : null}
        {phase === 'turn-running' && cols >= 50 ? (
          <Text color="gray" dimColor>{'  · running'}</Text>
        ) : null}
        {phase === 'idle' && (footer.runningChildren ?? 0) > 0 && cols >= 50 ? (
          <Text color="yellow">{`  · ${footer.runningChildren} working`}</Text>
        ) : null}
      </Text>
      {showRightHint ? (
        <Text color="gray" dimColor wrap="truncate">{rightText}</Text>
      ) : null}
    </Box>
  );
}
