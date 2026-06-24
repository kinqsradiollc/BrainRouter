/**
 * SessionScreen (S-03) — the core chat surface (prototype UF-03). Custom topbar
 * (back · title · connection dot · context ring · menu) + the live transcript
 * (user/assistant bubbles with a streaming caret, muted reasoning, tool cards,
 * notices) + composer (pills, send→stop). A pending approval auto-presents the
 * ApprovalSheet. State comes from the pure transcript reducer via
 * `useSessionStore`; commands go out through `useActiveSession`.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { MONO } from '../theme/fonts';
import { useActiveSession, useSessionStore } from '../state/sessionStore';
import { useTransport, useConnectionStatus } from '../state/TransportProvider';
import type { ChatsStackParamList } from '../navigation/types';
import type { TranscriptItem } from '../domain/session/transcript';
import { Composer } from '../components/chat/Composer';
import { ToolCard } from '../components/chat/ToolCard';
import { ApprovalSheet } from '../components/chat/ApprovalSheet';
import { SessionHeader } from '../components/chat/SessionHeader';

type Props = NativeStackScreenProps<ChatsStackParamList, 'Session'>;

const MAX_CONTEXT = 200_000;

/** Group-thousands without relying on Intl (Hermes ships a minimal Intl). */
function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function Row({ item }: { item: TranscriptItem }): React.JSX.Element {
  const theme = useTheme();
  switch (item.kind) {
    case 'user':
      return (
        <View style={[styles.bubble, styles.user, { backgroundColor: theme.colors.overlay, borderColor: theme.colors.border }]}>
          <Text style={[styles.bubbleText, { color: theme.colors.text }]}>{item.text}</Text>
        </View>
      );
    case 'assistant':
      return (
        <View style={[styles.bubble, styles.assistant, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border }]}>
          <Text style={[styles.bubbleText, { color: theme.colors.text }]}>
            {item.text}
            {item.streaming ? <Text style={{ color: theme.colors.accent }}>{' ▍'}</Text> : null}
          </Text>
        </View>
      );
    case 'reasoning':
      return (
        <Text style={[styles.reason, { color: theme.colors.muted, borderLeftColor: theme.colors.borderStrong }]}>
          {item.text}
        </Text>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'notice':
      return (
        <Text style={[styles.notice, { color: item.level === 'error' ? theme.colors.danger : theme.colors.text2 }]}>
          {item.text}
        </Text>
      );
    default:
      return <View />;
  }
}

function WorkingLine(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.work}>
      <ActivityIndicator size="small" color={theme.colors.accent} />
      <Text style={[styles.workText, { color: theme.colors.text2 }]}>Working…</Text>
    </View>
  );
}

export function SessionScreen({ route, navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const { sessionKey } = route.params;
  const { startTurn, interrupt, respond } = useActiveSession(sessionKey);
  const transport = useTransport();
  const status = useConnectionStatus();

  const items = useSessionStore((s) => s.items);
  const running = useSessionStore((s) => s.running);
  const pending = useSessionStore((s) => s.pendingInteraction);
  const tokens = useSessionStore((s) => s.tokens);
  const model = useSessionStore((s) => s.model);
  const scrollRef = useRef<ScrollView | null>(null);
  const [contextPct, setContextPct] = useState<number | null>(null);

  // Initial context-window fill from the host.
  useEffect(() => {
    let alive = true;
    void (async () => {
      // Host returns { used, window, compactAt, limit, pct } — `pct` is already
      // computed against the model's context window; fall back to used/window.
      const cu = await transport.query<{ used: number; window: number; pct: number }>('context-usage');
      if (alive && cu) setContextPct(typeof cu.pct === 'number' ? cu.pct : cu.window ? (cu.used / cu.window) * 100 : 0);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  // Tick the ring up as the turn reports token usage.
  useEffect(() => {
    if (tokens) setContextPct((tokens.promptTokens / MAX_CONTEXT) * 100);
  }, [tokens]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['top', 'left', 'right', 'bottom']}>
      <SessionHeader
        title={sessionKey}
        status={status}
        contextPct={contextPct}
        onBack={() => navigation.goBack()}
        onMenu={() => navigation.navigate('Changes', { sessionKey })}
      />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
        >
          {items.length === 0 ? (
            <Text style={[styles.hint, { color: theme.colors.muted }]}>Send a message to start a turn.</Text>
          ) : (
            items.map((item) => <Row key={item.id} item={item} />)
          )}
          {running ? <WorkingLine /> : null}
        </ScrollView>

        {tokens ? (
          <Text style={[styles.tokens, { color: theme.colors.muted, borderTopColor: theme.colors.border }]}>
            {fmt(tokens.promptTokens + tokens.completionTokens)} tokens · {tokens.calls} calls
          </Text>
        ) : null}

        <Composer running={running} onSend={startTurn} onStop={interrupt} model={model ?? undefined} />
      </KeyboardAvoidingView>

      <ApprovalSheet request={pending} onRespond={respond} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  hint: { fontSize: 13, textAlign: 'center', marginTop: 40 },
  bubble: { maxWidth: '84%', paddingVertical: 9, paddingHorizontal: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  user: { alignSelf: 'flex-end', borderBottomRightRadius: 5 },
  assistant: { alignSelf: 'flex-start', borderBottomLeftRadius: 5 },
  bubbleText: { fontSize: 14, lineHeight: 20 },
  reason: { fontSize: 12, fontStyle: 'italic', borderLeftWidth: 2, paddingLeft: 9, paddingVertical: 2 },
  notice: { fontSize: 12.5, lineHeight: 18 },
  work: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 4 },
  workText: { fontSize: 12.5 },
  tokens: { fontSize: 11, fontFamily: MONO, paddingHorizontal: 16, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth },
});
