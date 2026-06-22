/**
 * ChatsScreen (S-02) — projects/sessions list. In M0 it proves the transport
 * seam boots with data: it reads the current workspace + sessions from the
 * (Mock) transport and lists them; tapping a row opens the Session screen.
 * The full sidebar (projects, pin/fork, pagination) lands in M1 using the
 * already-ported `domain/session` + `domain/view/projectSessionsView` logic.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen, EmptyState } from '../components/primitives/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport, useConnectionStatus } from '../state/TransportProvider';
import type { ChatsStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<ChatsStackParamList, 'Chats'>;

interface SessionRowLike {
  sessionKey: string;
  firstUserMessage?: string;
  status?: string;
  pinned?: boolean;
}

export function ChatsScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const status = useConnectionStatus();
  const [current, setCurrent] = useState<string | null>(null);
  const [rows, setRows] = useState<SessionRowLike[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const recents = await transport.workspaceRecents();
      if (!alive) return;
      setCurrent(recents.current);
      const sessions = await transport.query<SessionRowLike[]>('list-sessions');
      if (!alive) return;
      setRows(sessions ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  return (
    <Screen title="Chats" subtitle={current ? `${current} · ${status}` : status}>
      {rows === null ? (
        <EmptyState title="Loading sessions…" />
      ) : rows.length === 0 ? (
        <EmptyState title="No sessions yet" detail="Start a chat to see it here." />
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          {rows.map((row) => (
            <Pressable
              key={row.sessionKey}
              onPress={() => navigation.navigate('Session', { sessionKey: row.sessionKey })}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? theme.colors.overlay : theme.colors.raised,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radius.card,
                  padding: theme.spacing.md,
                },
              ]}
            >
              <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={1}>
                {row.pinned ? '★ ' : ''}
                {row.firstUserMessage ?? row.sessionKey}
              </Text>
              <Text style={[styles.rowMeta, { color: theme.colors.muted }]}>
                {row.sessionKey}
                {row.status ? ` · ${row.status}` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: StyleSheet.hairlineWidth },
  rowTitle: { fontSize: 15, fontWeight: '500' },
  rowMeta: { fontSize: 12, marginTop: 2 },
});
