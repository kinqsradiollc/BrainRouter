import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { Frame } from './Frame.js';

/**
 * Arrow-key picker built on Ink.
 *
 * Replaces the raw-stdout `pickFromList` primitive that was creeping
 * upward on every cursor move + stacking frames on step transitions.
 * Ink's render loop handles all the redraw / diff / cursor mechanics
 * correctly because it owns the screen.
 *
 * Supports:
 *   - N rows (no 2-4 cap)
 *   - Optional "Other" free-text fallback
 *   - Pre-filled "Other" mode for env-var-derived defaults
 *   - Live preview rows (returned from `onCursorChange`, rendered
 *     INSIDE the frame above the footer)
 *   - Value column right-aligned per row
 *   - `›` selected glyph + theme-colored highlight
 *
 * Pattern lineage: state machine + reducer split lifted from grok-cli's
 * SuggestionOverlay; live-preview-from-state contract from codex's
 * theme_picker.rs.
 */

export interface PickerRow {
  id: string;
  label: string;
  value?: string;
  description?: string;
}

export interface PickerProps {
  title: string;
  subtitle?: string;
  badge?: string;
  /** Optional footer override; defaults to "↑/↓ navigate · ↵ confirm · esc / q cancel". */
  footer?: string;
  rows: PickerRow[];
  initialCursor?: number;
  multiSelect?: boolean;
  allowOther?: boolean;
  otherLabel?: string;
  otherDescription?: string;
  prefilledOther?: string;
  onCursorChange?: (id: string, index: number) => string[] | undefined;
  /** Hex / named color for the panel border + title. Defaults to brand orange. */
  accentColor?: string;
  /**
   * Back-compat: callers from `commands/config.ts` etc. pass a Theme
   * object (chalk-based). When present, we pull `accentColor` from
   * the theme's primary hex. Ignored if accentColor is also set.
   */
  theme?: { mode: string };
  /** Ignored (kept for back-compat with the raw-stdout picker shape). */
  eraseOnClose?: boolean;
  /** Resolves with the picker outcome. The component unmounts itself after the callback. */
  onResolve: (result: PickerResult) => void;
}

export type PickerResult =
  | { kind: 'pick'; id: string }
  | { kind: 'multi'; id: string; ids: string[]; otherText?: string }
  | { kind: 'other'; text: string }
  | { kind: 'cancelled' };

const OTHER_ID = '__other__';

function themeToAccent(mode?: string): string | undefined {
  if (mode === 'light') return '#A24E1F';
  if (mode === 'mono') return 'white';
  if (mode === 'dark') return '#CC9166';
  return undefined;
}

export function Picker(props: PickerProps) {
  const augmentedRows = useMemo<PickerRow[]>(() => {
    if (!props.allowOther) return props.rows;
    return [
      ...props.rows,
      {
        id: OTHER_ID,
        label: props.otherLabel ?? 'Other',
        description: props.otherDescription ?? 'Type a free-form answer',
      },
    ];
  }, [props.rows, props.allowOther, props.otherLabel, props.otherDescription]);

  const [cursor, setCursor] = useState(() =>
    Math.max(0, Math.min(props.initialCursor ?? 0, augmentedRows.length - 1)),
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [phase, setPhase] = useState<'pick' | 'other'>(
    props.prefilledOther !== undefined ? 'other' : 'pick',
  );
  const [otherText, setOtherText] = useState(props.prefilledOther ?? '');
  const [preview, setPreview] = useState<string[] | undefined>(undefined);

  // Picker is intentionally "exit-agnostic" — it just calls
  // `props.onResolve(result)` and trusts the caller (runPicker or the
  // chat overlay slot) to decide whether to unmount Ink. This matters
  // because when Picker renders as an overlay INSIDE the chat Ink, an
  // internal `useApp().exit()` would unmount the WHOLE chat instead of
  // just hiding the picker. runPicker.tsx wraps Picker in a small
  // `ExitWrapper` for the standalone mount that owns the exit.
  const finish = (result: PickerResult) => {
    props.onResolve(result);
  };

  // Recompute preview when cursor moves OR on first mount.
  //
  // CRITICAL: store onCursorChange in a ref instead of including it in
  // the deps array. Callers pass an inline lambda; React would see a
  // new function reference every render, fire this effect, which calls
  // setPreview(), which re-renders, which makes a new lambda, which
  // fires the effect again — infinite loop that swallows every
  // keystroke. The latest-callback ref pattern is the canonical fix.
  const onCursorChangeRef = useRef(props.onCursorChange);
  useEffect(() => { onCursorChangeRef.current = props.onCursorChange; });
  useEffect(() => {
    if (phase !== 'pick') {
      setPreview(undefined);
      return;
    }
    const cb = onCursorChangeRef.current;
    if (!cb) {
      setPreview(undefined);
      return;
    }
    const row = augmentedRows[cursor];
    if (!row || row.id === OTHER_ID) {
      setPreview(undefined);
      return;
    }
    try {
      setPreview(cb(row.id, cursor));
    } catch {
      setPreview(undefined);
    }
    // Intentionally omit augmentedRows + onCursorChangeRef from deps:
    // augmentedRows is derived from props and stable across renders
    // for a given mount; the callback is read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, phase]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      finish({ kind: 'cancelled' });
      return;
    }
    if (phase === 'other') {
      // TextInput owns Enter/Backspace/character handling via onChange.
      // We only handle Esc here to bail back to pick phase.
      if (key.escape) {
        setPhase('pick');
        setOtherText('');
      }
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + augmentedRows.length) % augmentedRows.length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % augmentedRows.length);
      return;
    }
    if (key.return) {
      const row = augmentedRows[cursor];
      if (props.multiSelect) {
        if (selected.size === 0) return;
        if (selected.has(OTHER_ID)) {
          setPhase('other');
          return;
        }
        const ids = augmentedRows.filter((r) => selected.has(r.id)).map((r) => r.id);
        finish({ kind: 'multi', id: ids[0] ?? '', ids });
        return;
      }
      if (row.id === OTHER_ID) {
        setPhase('other');
        return;
      }
      finish({ kind: 'pick', id: row.id });
      return;
    }
    if (input === ' ' && props.multiSelect) {
      const row = augmentedRows[cursor];
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      return;
    }
    if (key.escape || input === 'q') {
      finish({ kind: 'cancelled' });
      return;
    }
  });

  const footer = props.footer ?? (phase === 'other'
    ? '↵ accept  ·  esc back  ·  ⌫ erase'
    : props.multiSelect
      ? '↑/↓ navigate  ·  space toggle  ·  ↵ confirm  ·  esc / q cancel'
      : '↑/↓ navigate  ·  ↵ confirm  ·  esc / q cancel');
  const accent = props.accentColor ?? themeToAccent(props.theme?.mode) ?? '#CC9166';

  return (
    <Frame title={props.title} subtitle={props.subtitle} badge={props.badge} footer={footer} accentColor={accent}>
      {phase === 'pick' ? (
        <PickerRows rows={augmentedRows} cursor={cursor} accentColor={accent} multiSelect={!!props.multiSelect} selected={selected} />
      ) : (
        <Box flexDirection="column">
          <Text bold color={accent}>› Type your answer</Text>
          <Text color="gray" dimColor>{props.otherDescription ?? 'Press ENTER to accept'}</Text>
          <Box marginTop={1}>
            <Text color="cyan">› </Text>
            <TextInput
              value={otherText}
              onChange={setOtherText}
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) return;
                if (props.multiSelect) {
                  finish({
                    kind: 'multi',
                    id: augmentedRows.find((r) => selected.has(r.id) && r.id !== OTHER_ID)?.id ?? '',
                    ids: augmentedRows.filter((r) => selected.has(r.id) && r.id !== OTHER_ID).map((r) => r.id),
                    otherText: trimmed,
                  });
                  return;
                }
                finish({ kind: 'other', text: trimmed });
              }}
            />
          </Box>
        </Box>
      )}
      {preview && preview.length > 0 ? (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" borderTop={true} borderLeft={false} borderRight={false} borderBottom={false}>
          {preview.map((line, i) => <Text key={i}>{line}</Text>)}
        </Box>
      ) : null}
    </Frame>
  );
}

function PickerRows({ rows, cursor, accentColor, multiSelect, selected }: { rows: PickerRow[]; cursor: number; accentColor: string; multiSelect: boolean; selected: Set<string> }) {
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <PickerRowView key={row.id} row={row} selected={i === cursor} accentColor={accentColor} multiSelect={multiSelect} checked={selected.has(row.id)} />
      ))}
    </Box>
  );
}

function PickerRowView({ row, selected, accentColor, multiSelect, checked }: { row: PickerRow; selected: boolean; accentColor: string; multiSelect: boolean; checked: boolean }) {
  // Selected glyph + bold label + right-aligned value, lifted from
  // openSrc/grok-cli/src/ui/components/SuggestionOverlay.tsx
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={accentColor}>{selected ? ' › ' : '   '}</Text>
        {multiSelect ? <Text color={checked ? accentColor : 'gray'}>{checked ? '[x] ' : '[ ] '}</Text> : null}
        <Box flexGrow={1}>
          <Text bold={selected} color={selected ? accentColor : undefined}>{row.label}</Text>
        </Box>
        {row.value ? <Text color="gray">{row.value}</Text> : null}
      </Box>
      {row.description ? (
        <Box paddingLeft={5}>
          <Text color="gray" dimColor>{row.description}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
