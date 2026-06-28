/**
 * ChatsScreen (S-02) — the chat sessions for ONE project (workspace). Reached from
 * the Projects screen, which passes the project root; this opens that workspace and
 * lists its sessions. "New chat" mints a fresh session in this project. Refreshes on
 * focus so a chat started here shows up when you come back.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen, EmptyState } from '../components/primitives/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport, useConnectionStatus } from '../state/TransportProvider';
import { Icon } from '../components/Icon';
import { MONO } from '../theme/fonts';
import type { ChatsStackParamList } from '../navigation/types';
import { newSessionKey } from '../domain/session/newSessionKey';

type Props = NativeStackScreenProps<ChatsStackParamList, 'Chats'>;

interface SessionRow {
  sessionKey: string;
  firstUserMessage?: string;
  status?: string;
  pinned?: boolean;
  turnCount?: number;
  lastRole?: string;
}

export function ChatsScreen({ navigation, route }: Props): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const status = useConnectionStatus();
  const projectRoot = route.params?.projectRoot;
  const projectName = route.params?.projectName;
  const [rows, setRows] = useState<SessionRow[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        if (projectRoot) await transport.openWorkspace(projectRoot); // make this the active project
        let sessions: SessionRow[];
        if (projectRoot) {
          const r = await transport.query<{ rows: SessionRow[] }>('workspace-sessions', { root: projectRoot });
          sessions = r?.rows ?? [];
        } else {
          const r = await transport.query<SessionRow[]>('list-sessions');
          sessions = Array.isArray(r) ? r : [];
        }
        if (alive) setRows(sessions);
      })();
      return () => {
        alive = false;
      };
    }, [transport, projectRoot]),
  );

  return (
    <Screen title={projectName ?? 'Chats'} subtitle={status}>
      <Pressable accessibilityLabel="Back to projects" onPress={() => navigation.goBack()} style={styles.back} hitSlop={8}>
        <Text style={{ color: theme.colors.text2, fontSize: 17, marginTop: -2 }}>‹</Text>
        <Text style={{ color: theme.colors.text2, fontSize: 13 }}>Projects</Text>
      </Pressable>

      <Pressable
        accessibilityLabel="New chat"
        onPress={() => navigation.navigate('Session', { sessionKey: newSessionKey() })}
        style={({ pressed }) => [styles.newChat, { backgroundColor: pressed ? theme.colors.accentPress : theme.colors.accent, borderRadius: theme.radius.card }]}
      >
        <Icon name="plus" size={18} color={theme.colors.accentText} />
        <Text style={[styles.newChatText, { color: theme.colors.accentText }]}>New chat</Text>
      </Pressable>
      <View style={{ height: theme.spacing.md }} />

      {rows === null ? (
        <EmptyState title="Loading sessions…" />
      ) : rows.length === 0 ? (
        <EmptyState title="No chats yet" detail="Tap “New chat” above to start one." />
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
  back: { flexDirection: 'row', alignItems: 'center', gap: 3, marginBottom: 10 },
  newChat: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13 },
  newChatText: { fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4 },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '500' },
  meta: { fontSize: 11, marginTop: 2, fontFamily: MONO },
});
