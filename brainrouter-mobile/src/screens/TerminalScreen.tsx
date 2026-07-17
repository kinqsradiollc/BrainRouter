/**
 * TerminalScreen (S-33) — a command-log view of the paired host's shell. A
 * scrollback of `$ command` + output over a command input. Mock-backed (the
 * host streams real shell output once wired); this is the read/run surface, not
 * a full pty.
 */
import React, { useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { Icon } from '../components/Icon';

interface Line {
  cmd: string;
  out: string;
}

export function TerminalScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [log, setLog] = useState<Line[]>([]);
  const [cmd, setCmd] = useState('');
  const scrollRef = useRef<ScrollView | null>(null);

  const run = async (): Promise<void> => {
    const c = cmd.trim();
    if (!c) return;
    setCmd('');
    setLog((l) => [...l, { cmd: c, out: '' }]);
    const r = await transport.query<{ output: string }>('term-run', { cmd: c });
    setLog((l) => {
      const next = l.slice();
      if (next.length) next[next.length - 1] = { cmd: c, out: r?.output ?? '' };
      return next;
    });
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['left', 'right', 'bottom']}>
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.body}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
      >
        {log.length === 0 ? (
          <Text style={[styles.hint, { color: theme.colors.muted }]}>Run a command on the paired host. Output appears here.</Text>
        ) : (
          log.map((line, i) => (
            <View key={i} style={styles.entry}>
              <Text style={[styles.cmd, { color: theme.colors.accent }]}>
                <Text style={{ color: theme.colors.muted }}>$ </Text>
                {line.cmd}
              </Text>
              {line.out ? <Text style={[styles.out, { color: theme.colors.text2 }]}>{line.out}</Text> : null}
            </View>
          ))
        )}
      </ScrollView>
      <View style={[styles.bar, { borderTopColor: theme.colors.border, backgroundColor: theme.colors.raised }]}>
        <Text style={[styles.prompt, { color: theme.colors.muted }]}>$</Text>
        <TextInput
          style={[styles.input, { color: theme.colors.text }]}
          value={cmd}
          onChangeText={setCmd}
          placeholder="command"
          placeholderTextColor={theme.colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={run}
        />
        <Pressable onPress={run} hitSlop={6} style={[styles.runBtn, { backgroundColor: theme.colors.accent }]}>
          <Icon name="arrow-up" size={16} color={theme.colors.accentText} />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  body: { padding: 12, gap: 8 },
  hint: { fontSize: 13, textAlign: 'center', marginTop: 30 },
  entry: { gap: 2 },
  cmd: { fontSize: 12.5, fontFamily: MONO },
  out: { fontSize: 12, lineHeight: 17, fontFamily: MONO },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  prompt: { fontSize: 14, fontFamily: MONO },
  input: { flex: 1, fontSize: 14, fontFamily: MONO, padding: 0 },
  runBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
