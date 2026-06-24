/**
 * Composer — the message input bar (S-04, prototype UF-03). A pill row carrying
 * the live settings (Mode · Model · Effort · branch, each with its DESK-4k icon)
 * above a rounded input with an add button and one primary action that flips
 * between Send (accent, arrow-up) when idle and Stop (danger, stop) while a turn
 * runs. The pickers behind the pills land in a later M1 slice.
 */
import React, { useState } from 'react';
import { View, TextInput, Pressable, StyleSheet, ScrollView, Text } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { MONO } from '../../theme/fonts';
import { Icon, type IconName } from '../Icon';

export interface ComposerProps {
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Active model id (e.g. claude-opus-4-8) for the Model pill. */
  model?: string;
}

/** claude-opus-4-8 → "Opus 4.8" for the pill. */
function shortModel(id: string): string {
  return id
    .replace(/^claude-/, '')
    .replace(/(\d)-(\d)/g, '$1.$2')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function Pill({ icon, label, value }: { icon: IconName; label?: string; value: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.pill, { backgroundColor: theme.colors.overlay, borderColor: theme.colors.border }]}>
      <Icon name={icon} size={13} color={theme.colors.text2} />
      {label ? <Text style={[styles.pillLabel, { color: theme.colors.text2 }]}>{label}</Text> : null}
      <Text style={[styles.pillValue, { color: theme.colors.text }]}>{value}</Text>
    </View>
  );
}

export function Composer({ running, onSend, onStop, model }: ComposerProps): React.JSX.Element {
  const theme = useTheme();
  const [text, setText] = useState('');
  const canSend = text.trim().length > 0;

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <View style={[styles.wrap, { borderTopColor: theme.colors.border, backgroundColor: theme.colors.raised }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>
        <Pill icon="spark" label="Mode" value="Auto" />
        <Pill icon="brain" label="Model" value={model ? shortModel(model) : 'Opus 4.8'} />
        <Pill icon="bolt" label="Effort" value="Smart" />
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
