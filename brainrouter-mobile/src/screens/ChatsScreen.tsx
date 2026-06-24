/**
 * ChatsScreen (S-02) — projects/sessions list (prototype US-02). Session rows with
 * a status dot, the first-prompt title, a pin glyph, turn/status meta, and a
 * chevron; tapping opens the Session. Reads the current workspace + sessions from
 * the transport. The full sidebar (projects, fork, pagination) builds on the
 * ported domain/session logic in later slices.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen, EmptyState } from '../components/primitives/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport, useConnectionStatus } from '../state/TransportProvider';
import { Icon } from '../components/Icon';
import { MONO } from '../theme/fonts';
import type { ChatsStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<ChatsStackParamList, 'Chats'>;

interface SessionRow {
  sessionKey: string;
  firstUserMessage?: string;
  status?: string;
  pinned?: boolean;
  turnCount?: number;
  lastRole?: string;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function ChatsScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const status = useConnectionStatus();
  const [current, setCurrent] = useState<string | null>(null);
  const [rows, setRows] = useState<SessionRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const recents = await transport.workspaceRecents();
      if (!alive) return;
      setCurrent(recents.current);
      const sessions = await transport.query<SessionRow[]>('list-sessions');
      if (!alive) return;
      setRows(sessions ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const subtitle = current ? `${baseName(current)} · ${status}` : status;

  return (
    <Screen title="Chats" subtitle={subtitle}>
      {rows === null ? (
        <EmptyState title="Loading sessions…" />
      ) : rows.length === 0 ? (
        <EmptyState title="No sessions yet" detail="Start a chat to see it here." />
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          {rows.map((row) => {
            const active = (row.status ?? 'active') === 'active';
            const dot = active ? theme.colors.accent : theme.colors.muted;
            return (
              <Pressable
                key={row.sessionKey}
                onPress={() => navigation.navigate('Session', { sessionKey: row.sessionKey })}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? theme.colors.overlay : theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card },
                ]}
              >
                <View style={[styles.dot, { backgroundColor: dot }]} />
                <View style={styles.body}>
                  <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
                    {row.firstUserMessage ?? row.sessionKey}
                  </Text>
                  <Text style={[styles.meta, { color: theme.colors.muted }]} numberOfLines={1}>
                    {row.turnCount != null ? `${row.turnCount} turns` : row.sessionKey}
                    {row.status ? ` · ${row.status}` : ''}
                  </Text>
                </View>
                {row.pinned ? <Icon name="pin" size={15} color={theme.colors.text2} /> : null}
                <Icon name="chev-right" size={16} color={theme.colors.muted} />
              </Pressable>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4 },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '500' },
  meta: { fontSize: 11, marginTop: 2, fontFamily: MONO },
});
