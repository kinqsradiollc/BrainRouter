/**
 * Composer — the message input bar (S-04, prototype UF-03). A pill row carrying
 * the live session settings (Mode · Model · Effort · branch) above a rounded input
 * with one primary action that flips between Send (accent) when idle and Stop
 * (danger) while a turn runs. The Mode/Model/Effort pills are tappable: each opens
 * a PickerSheet wired to the host (set-model / action:set-session-mode) when the
 * matching onPick handler is provided.
 */
import React, { useState } from 'react';
import { View, TextInput, Pressable, StyleSheet, ScrollView, Text } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { MONO } from '../../theme/fonts';
import { Icon, type IconName } from '../Icon';
import { PickerSheet, type PickerOption } from './PickerSheet';
import {
  MODE_OPTIONS,
  EFFORT_OPTIONS,
  modeLabel,
  modelLabel,
  type ModeOption,
  type Effort,
} from '../../domain/session/sessionControls';

export interface ComposerProps {
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Active model id (e.g. claude-opus-4-8 / Qwen3.5-9B-Q4_K_M.gguf). */
  model?: string;
  executionMode?: string;
  reviewPolicy?: string;
  effort?: string;
  /** Selectable models from `list-models` (empty for a single local model). */
  models?: Array<{ id: string; label: string }>;
  onPickModel?: (id: string) => void;
  onPickMode?: (opt: ModeOption) => void;
  onPickEffort?: (key: Effort) => void;
}

function Pill({ icon, label, value, onPress }: { icon: IconName; label?: string; value: string; onPress?: () => void }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.pill, { backgroundColor: pressed ? theme.colors.raised : theme.colors.overlay, borderColor: theme.colors.border }]}
    >
      <Icon name={icon} size={13} color={theme.colors.text2} />
      {label ? <Text style={[styles.pillLabel, { color: theme.colors.text2 }]}>{label}</Text> : null}
      <Text style={[styles.pillValue, { color: theme.colors.text }]}>{value}</Text>
    </Pressable>
  );
}

export function Composer({
  running,
  onSend,
  onStop,
  model,
  executionMode,
  reviewPolicy,
  effort,
  models,
  onPickModel,
  onPickMode,
  onPickEffort,
}: ComposerProps): React.JSX.Element {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [picker, setPicker] = useState<null | 'model' | 'mode' | 'effort'>(null);
  const canSend = text.trim().length > 0;

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  const modeKey = MODE_OPTIONS.find((o) => o.executionMode === executionMode && o.reviewPolicy === reviewPolicy)?.key;
  const effortKey = effort ?? 'medium';

  // Resolve the open picker's props (title / options / selection / handler).
  const pp: { title: string; options: PickerOption[]; selectedKey?: string; emptyHint?: string; onPick: (key: string) => void } =
    picker === 'model'
      ? {
          title: 'Model',
          options: (models ?? []).map((m) => ({ key: m.id, label: m.label, sub: m.id })),
          selectedKey: model,
          emptyHint: 'The host reports a single local model — nothing to switch to here.',
          onPick: (id) => { onPickModel?.(id); setPicker(null); },
        }
      : picker === 'mode'
        ? {
            title: 'Mode',
            options: MODE_OPTIONS.map((o) => ({ key: o.key, label: o.label })),
            selectedKey: modeKey,
            onPick: (key) => { const o = MODE_OPTIONS.find((x) => x.key === key); if (o) onPickMode?.(o); setPicker(null); },
          }
        : {
            title: 'Reasoning effort',
            options: EFFORT_OPTIONS.map((e) => ({ key: e.key, label: e.label })),
            selectedKey: effortKey,
            onPick: (key) => { onPickEffort?.(key as Effort); setPicker(null); },
          };

  return (
    <View style={[styles.wrap, { borderTopColor: theme.colors.border, backgroundColor: theme.colors.raised }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>
        <Pill icon="spark" label="Mode" value={modeLabel(executionMode, reviewPolicy)} onPress={onPickMode ? () => setPicker('mode') : undefined} />
        <Pill icon="brain" label="Model" value={modelLabel(model)} onPress={onPickModel ? () => setPicker('model') : undefined} />
        <Pill icon="bolt" label="Effort" value={EFFORT_OPTIONS.find((e) => e.key === effortKey)?.label ?? 'Medium'} onPress={onPickEffort ? () => setPicker('effort') : undefined} />
        <Pill icon="branch" value="main" />
      </ScrollView>

      <View style={[styles.box, { backgroundColor: theme.colors.base, borderColor: theme.colors.borderStrong }]}>
        <View style={[styles.add, { backgroundColor: theme.colors.overlay, borderColor: theme.colors.border }]}>
          <Icon name="plus" size={18} color={theme.colors.text2} />
        </View>
        <TextInput
          style={[styles.input, { color: theme.colors.text }]}
          placeholder="Message…"
          placeholderTextColor={theme.colors.muted}
          value={text}
          onChangeText={setText}
          multiline
        />
        {running ? (
          <Pressable accessibilityLabel="Stop turn" onPress={onStop} hitSlop={6} style={[styles.action, { backgroundColor: theme.colors.danger }]}>
            <Icon name="stop" size={18} color={theme.colors.accentText} />
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel="Send message"
            onPress={submit}
            disabled={!canSend}
            hitSlop={6}
            style={[styles.action, { backgroundColor: canSend ? theme.colors.accent : theme.colors.overlay }]}
          >
            <Icon name="arrow-up" size={18} color={canSend ? theme.colors.accentText : theme.colors.muted} />
          </Pressable>
        )}
      </View>

      <PickerSheet
        visible={picker !== null}
        title={pp.title}
        options={pp.options}
        selectedKey={pp.selectedKey}
        emptyHint={pp.emptyHint}
        onPick={pp.onPick}
        onClose={() => setPicker(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 12 },
  pills: { gap: 6, paddingBottom: 8, paddingRight: 12 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10 },
  pillLabel: { fontSize: 11 },
  pillValue: { fontSize: 10.5, fontFamily: MONO, fontWeight: '500' },
  box: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    paddingHorizontal: 7,
    paddingVertical: 6,
  },
  add: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: { flex: 1, fontSize: 14, paddingVertical: 6, maxHeight: 120 },
  action: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
});
