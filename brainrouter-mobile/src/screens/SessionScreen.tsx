/**
 * SessionScreen (S-03) — the core chat surface. M0 is a minimal proof of the
 * event seam: it subscribes to `transport.onEvent`, runs a turn via
 * `transport.send`, and renders the streamed status/deltas/tool lines. The full
 * transcript (ChatRow renderers, tool cards, composer + pickers, approval sheet)
 * lands in M1 on top of this seam.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import type { ChatsStackParamList } from '../navigation/types';
import { rid } from '../lib/rid';

type Props = NativeStackScreenProps<ChatsStackParamList, 'Session'>;

interface LogLine {
  id: number;
  text: string;
}

export function SessionScreen({ route }: Props): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const { sessionKey } = route.params;
  const [log, setLog] = useState<LogLine[]>([]);
  const scrollRef = useRef<ScrollView | null>(null);

  const append = (text: string) => setLog((prev) => [...prev, { id: rid(), text }]);

  useEffect(() => {
    const unsub = transport.onEvent((msg) => {
      const e = msg.event;
      switch (e.kind) {
        case 'status':
          append(`· ${e.text}`);
          break;
        case 'assistant-delta':
          append(e.text);
          break;
        case 'tool-start':
          append(`→ ${e.tool}(${JSON.stringify(e.args)})`);
          break;
        case 'tool-end':
          append(`✓ ${e.summary}`);
          break;
        case 'interaction-request':
          append(`⚠ approval requested: ${e.request.title}`);
          break;
        case 'turn-complete':
          append(`■ turn complete`);
          break;
        case 'turn-error':
          append(`✗ ${e.message}`);
          break;
        default:
          break;
      }
    });
    return unsub;
  }, [transport]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['left', 'right', 'bottom']}>
      <ScrollView
        ref={scrollRef}
        style={styles.body}
        contentContainerStyle={{ padding: theme.spacing.lg, gap: 4 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        <Text style={[styles.meta, { color: theme.colors.muted }]}>{sessionKey}</Text>
        {log.map((line) => (
          <Text key={line.id} style={[styles.line, { color: theme.colors.text }]}>
            {line.text}
          </Text>
        ))}
      </ScrollView>
      <View style={[styles.bar, { borderTopColor: theme.colors.border, padding: theme.spacing.md }]}>
        <Pressable
          onPress={() => transport.send({ kind: 'start-turn', prompt: 'summarize and then approve' })}
          style={[styles.btn, { backgroundColor: theme.colors.accent, borderRadius: theme.radius.control }]}
        >
          <Text style={[styles.btnText, { color: theme.colors.accentText }]}>Run test turn</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { flex: 1 },
  meta: { fontSize: 11, marginBottom: 8 },
  line: { fontSize: 14, lineHeight: 20 },
  bar: { borderTopWidth: StyleSheet.hairlineWidth },
  btn: { paddingVertical: 12, alignItems: 'center' },
  btnText: { fontSize: 15, fontWeight: '600' },
});
