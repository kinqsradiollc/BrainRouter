import React from 'react';
import { Box, Text } from 'ink';
import { renderMarkdown } from './markdownRender.js';
import { classifyDiffLine, looksLikeDiff } from './toolFormat.js';
import type { ScrollbackEntry } from './ChatApp.js';

/**
 * REFAC-CHATAPP-SPLIT part 4 (0.4.6) — the scrollback row renderer + its
 * preview/duration helpers, extracted verbatim from ChatApp.tsx. Presentational
 * (props in, JSX out); ScrollbackEntry is a type-only import from ChatApp so
 * there's no runtime cycle. No behavior change.
 */
export const ScrollbackRow = React.memo(function ScrollbackRow({ entry, accentColor, cols }: { entry: ScrollbackEntry; accentColor: string; cols: number }) {
  switch (entry.kind) {
    case 'raw':
      return <Text wrap={entry.noWrap ? 'truncate' : 'wrap'}>{entry.text}</Text>;
    case 'user':
      // Flex layout: ❯ on the left, prompt body in an inner column that
      // takes the remaining width. Continuation lines (when the user
      // pastes a multi-line prompt) align under the body column, not
      // under the caret.
      return (
        <Box marginTop={1}>
          <Text color={accentColor}>❯ </Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text>{entry.text}</Text>
          </Box>
        </Box>
      );
    case 'assistant': {
      // Pass the WHOLE rendered markdown to a single <Text> instead of
      // splitting on \n and re-rendering each line. The old line-split
      // approach broke ANSI styling that spans newlines — e.g. a
      // multi-line blockquote whose `gray italic` open code sat on line
      // 1 but whose close code sat on line 3 lost its style on lines
      // 2-3. `renderMarkdown` re-scopes the styling per line so the
      // single <Text> reads cleanly.
      //
      // The `⏺` lives in its own Text to the left of the body. The body
      // Box has flexGrow=1 so it takes the remaining terminal width and
      // Ink's wrap-ansi handles reflow inside it. Continuation lines
      // (both from wrap and from explicit \n in the rendered output)
      // align under the body column.
      //
      // `entry.raw === true` (user's rawScrollback preference) skips
      // marked entirely — useful when the user wants to see the LLM's
      // literal markdown source.
      // Pass the live terminal width so GFM tables render to fit (and re-fit
      // on resize — `cols` is a prop, so the row re-renders when it changes).
      const rendered = (entry.raw ? entry.text : renderMarkdown(entry.text, { width: cols })).trimEnd();
      const meta = entry.durationMs !== undefined
        ? `  ${Math.floor(entry.durationMs / 1000)}s${entry.tokensIn !== undefined ? ` · ${entry.tokensIn.toLocaleString()} in / ${entry.tokensOut?.toLocaleString() ?? 0} out` : ''}`
        : '';
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="green">⏺ </Text>
            <Box flexDirection="column" flexGrow={1}>
              <Text>{rendered}</Text>
            </Box>
          </Box>
          {meta ? (
            <Box paddingLeft={2}>
              <Text color="gray" dimColor>{meta}</Text>
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'tool': {
      // Claude-code layout:
      //   ⏺ Read(src/foo.ts)
      //     ⎿ <line 1 of preview>
      //       <line 2 of preview>
      //       (+N more lines hidden)
      // The header DOT is green on success and red on failure so the user
      // can scan a long turn at a glance. Duration appended in dim if set.
      const dotColor = entry.ok ? 'green' : 'red';
      const previewLines = entry.preview ? splitForPreview(entry.preview) : null;
      const isDiff = entry.preview ? looksLikeDiff(entry.preview) : false;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={dotColor}>⏺ </Text>
            <Text wrap="truncate">{entry.header}</Text>
            {entry.durationMs !== undefined ? (
              <Text color="gray" dimColor>{`  · ${formatDuration(entry.durationMs)}`}</Text>
            ) : null}
            {!entry.ok ? (
              <Text color="red" dimColor>{'  · failed'}</Text>
            ) : null}
          </Box>
          {previewLines ? previewLines.visible.map((line, i) => (
            <ToolPreviewLine
              key={i}
              line={line}
              isFirst={i === 0}
              isDiff={isDiff}
            />
          )) : null}
          {previewLines && previewLines.hidden > 0 ? (
            <Box>
              <Text color="gray" dimColor>{`    (+${previewLines.hidden} more line${previewLines.hidden === 1 ? '' : 's'} hidden)`}</Text>
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'memory':
      // Memory pipeline events — briefing / capture / citation / contradiction.
      // Warnings (contradictions, extraction failures) stand out; info events
      // stay dim so the chat doesn't drown in capture chatter.
      return (
        <Box>
          <Text
            color={entry.level === 'warn' ? 'yellow' : 'gray'}
            bold={entry.level === 'warn'}
            dimColor={entry.level === 'info'}
            wrap="truncate"
          >
            {entry.level === 'warn' ? '⚠ ' : '· '}{entry.text}
          </Text>
        </Box>
      );
    case 'plan':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray" bold>📋 Plan</Text>
          {entry.explanation ? (
            <Box marginBottom={1}>
              <Text color="gray" dimColor italic>   ↳ {entry.explanation}</Text>
            </Box>
          ) : null}
          {entry.items.map((item, i) => {
            const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '⏳' : '☐';
            const color = item.status === 'completed' ? 'green' : item.status === 'in_progress' ? 'yellow' : 'gray';
            // Multi-line steps indent under the first line so the checkbox
            // anchor stays visually attached to the whole step.
            const stepLines = String(item.step).split('\n');
            return (
              <Box key={i} flexDirection="column">
                <Box>
                  <Text color={color}>  {mark} </Text>
                  <Text color={item.status === 'completed' ? 'gray' : undefined}>{stepLines[0]}</Text>
                </Box>
                {stepLines.slice(1).map((line, j) => (
                  <Box key={j}>
                    <Text>{'      '}</Text>
                    <Text color={item.status === 'completed' ? 'gray' : undefined} dimColor>{line}</Text>
                  </Box>
                ))}
              </Box>
            );
          })}
        </Box>
      );
    case 'notice': {
      // info  → gray dim
      // warn  → yellow
      // error → red bold
      const level = entry.level ?? 'info';
      const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : 'gray';
      return (
        <Box>
          <Text color={color} bold={level === 'error'} dimColor={level === 'info'} wrap="truncate">
            {entry.text}
          </Text>
        </Box>
      );
    }
    case 'agent-result': {
      // Multi-line agent completion block. Header gets a 🏁/💥 icon and
      // the agent id/role; body wraps freely so long findings (Headline,
      // TL;DR, Summary blocks the child wrote) survive without being
      // clipped to terminal width like the old single-line notice was.
      const ok = entry.status === 'completed';
      const icon = ok ? '🏁' : '💥';
      const headerColor = ok ? 'green' : 'red';
      const bodyLines = entry.body ? entry.body.split('\n') : [];
      return (
        <Box flexDirection="column">
          <Text color={headerColor} bold>
            {`${icon} Agent ${entry.childId} (${entry.role}) ${entry.status}`}
          </Text>
          {bodyLines.length > 0 ? (
            <Box paddingLeft={4} flexDirection="column">
              {bodyLines.map((line, i) => (
                <Text key={i} color="gray" wrap="wrap">{line || ' '}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'reasoning': {
      const lines = entry.text.split('\n');
      // A dim-magenta left rule frames the chain-of-thought as a distinct
      // "thinking aside" — visually separate from the model's actual prose.
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="magenta" italic dimColor>💭 thinking</Text>
          <Box
            flexDirection="column"
            marginLeft={1}
            paddingLeft={1}
            borderStyle="single"
            borderColor="magenta"
            borderDimColor
            borderTop={false}
            borderRight={false}
            borderBottom={false}
          >
            {lines.map((line, i) => (
              <Text key={i} color="gray" italic wrap="wrap">{line || ' '}</Text>
            ))}
          </Box>
        </Box>
      );
    }
    case 'child-fleet': {
      const n = entry.children.length;
      if (n === 0) return null;
      const badge = n > 1 ? `[×${n} parallel] ` : '';
      // Color-cycle the per-child chips so multiple parallel agents are
      // visually distinguishable at a glance.
      const palette = ['cyan', 'magenta', 'yellow', 'blueBright', 'greenBright'];
      return (
        <Box flexDirection="column">
          <Box>
            <Text color="green" bold>{`◐ ${badge}running:`} </Text>
            {entry.children.map((c, i) => {
              const idShort = c.childId.startsWith('agent-') ? c.childId.slice(0, 14) : `agent-${c.childId.slice(0, 8)}`;
              const color = palette[i % palette.length];
              const tail = c.tool ? ` ${c.tool}` : '';
              return (
                <React.Fragment key={c.childId}>
                  {i > 0 ? <Text color="gray"> · </Text> : null}
                  <Text color={color}>{idShort}</Text>
                  <Text color="gray">{` (${c.role})${tail}`}</Text>
                </React.Fragment>
              );
            })}
          </Box>
        </Box>
      );
    }
    case 'compaction': {
      const summaryLines = entry.summary ? entry.summary.split('\n').slice(0, 8) : [];
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>{`📦 Compacted ${entry.droppedMessages} message(s) → kept ${entry.keptMessages}`}</Text>
          {summaryLines.length > 0 ? (
            <Box paddingLeft={3} flexDirection="column">
              {summaryLines.map((line, i) => (
                <Text key={i} color="gray" dimColor wrap="wrap">{line || ' '}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }
  }
});

/**
 * Render one line of a tool-result preview. Diff lines get red/green
 * coloring (see classifyDiffLine). The first line of the preview is
 * prefixed with `⎿` connector under the tool header; continuation lines
 * just indent to align with the connector body.
 */
function ToolPreviewLine({ line, isFirst, isDiff }: { line: string; isFirst: boolean; isDiff: boolean }) {
  const indent = isFirst ? '    ⎿ ' : '      ';
  let textColor: string | undefined = 'gray';
  let dim = true;
  if (isDiff) {
    const kind = classifyDiffLine(line);
    if (kind === 'add') { textColor = 'green'; dim = false; }
    else if (kind === 'del') { textColor = 'red'; dim = false; }
    else if (kind === 'hunk') { textColor = 'cyan'; dim = true; }
  }
  return (
    <Box>
      <Text color="gray" dimColor>{indent}</Text>
      <Text color={textColor} dimColor={dim} wrap="truncate">{line}</Text>
    </Box>
  );
}

const TOOL_PREVIEW_MAX_LINES = 8;

/** Split preview into the visible head + the count of hidden tail lines. */
function splitForPreview(preview: string): { visible: string[]; hidden: number } {
  const lines = preview.split('\n');
  if (lines.length <= TOOL_PREVIEW_MAX_LINES) return { visible: lines, hidden: 0 };
  return { visible: lines.slice(0, TOOL_PREVIEW_MAX_LINES), hidden: lines.length - TOOL_PREVIEW_MAX_LINES };
}

/** Human-readable duration: 950ms, 1.2s, 12s, 1m 23s. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}



