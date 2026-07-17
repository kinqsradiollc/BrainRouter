/**
 * ProjectsScreen (S-02) — the projects (workspaces) list at the top of the
 * Projects tab. Each project owns its chat sessions; tap one to open its chats, or
 * create a new project. Backed by the transport's workspaceRecents / trustWorkspace
 * / openWorkspace. Refreshes on focus so a project created (or a chat added) shows up.
 */
import React, { useCallback, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen, EmptyState } from '../components/primitives/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport, useConnectionStatus } from '../state/TransportProvider';
import { Icon } from '../components/Icon';
import { MONO } from '../theme/fonts';
import type { ChatsStackParamList } from '../navigation/types';
import { projectRows, projectName, type ProjectRow } from '../domain/workspace/projects';

type Props = NativeStackScreenProps<ChatsStackParamList, 'Projects'>;

export function ProjectsScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const status = useConnectionStatus();
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        const r = await transport.workspaceRecents();
        if (alive) setRows(projectRows(r.recents, r.current));
      })();
      return () => {
        alive = false;
      };
    }, [transport]),
  );

  const open = async (root: string, projName: string): Promise<void> => {
    await transport.openWorkspace(root);
    navigation.navigate('Chats', { projectRoot: root, projectName: projName });
  };

  const create = async (): Promise<void> => {
    const root = name.trim();
    if (!root) return;
    await transport.trustWorkspace(root);
    const res = await transport.openWorkspace(root);
    setAdding(false);
    setName('');
    if (res.opened) navigation.navigate('Chats', { projectRoot: root, projectName: projectName(root) });
  };

  return (
    <Screen title="Projects" subtitle={`BrainRouter · ${status}`}>
      <Pressable
        accessibilityLabel="New project"
        onPress={() => setAdding(true)}
        style={({ pressed }) => [styles.newBtn, { backgroundColor: pressed ? theme.colors.accentPress : theme.colors.accent, borderRadius: theme.radius.card }]}
      >
        <Icon name="plus" size={18} color={theme.colors.accentText} />
        <Text style={[styles.newText, { color: theme.colors.accentText }]}>New project</Text>
      </Pressable>
      <View style={{ height: theme.spacing.md }} />

      {rows === null ? (
        <EmptyState title="Loading projects…" />
      ) : rows.length === 0 ? (
        <EmptyState title="No projects yet" detail="Tap “New project” to add one." />
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          {rows.map((p) => (
            <Pressable
              key={p.root}
              onPress={() => void open(p.root, p.name)}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.colors.overlay : theme.colors.raised, borderColor: p.current ? theme.colors.accentLine : theme.colors.border, borderRadius: theme.radius.card },
              ]}
            >
              <Icon name="panels" size={18} color={p.current ? theme.colors.accent : theme.colors.text2} />
              <View style={styles.body}>
                <Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={{ color: theme.colors.muted, fontSize: 11, fontFamily: MONO }} numberOfLines={1}>
                  {p.root}
                </Text>
              </View>
              {p.current ? <Text style={[styles.badge, { color: theme.colors.accent }]}>current</Text> : null}
              <Icon name="chev-right" size={16} color={theme.colors.muted} />
            </Pressable>
          ))}
        </View>
      )}

      <Modal visible={adding} transparent animationType="fade" onRequestClose={() => setAdding(false)}>
        <Pressable style={styles.backdrop} onPress={() => setAdding(false)}>
          <Pressable style={[styles.card, { backgroundColor: theme.colors.overlay, borderColor: theme.colors.borderStrong }]} onPress={() => {}}>
            <Text style={[styles.cardTitle, { color: theme.colors.text }]}>New project</Text>
            <TextInput
              autoFocus
              value={name}
              onChangeText={setName}
              placeholder="Project name or /path/to/repo"
              placeholderTextColor={theme.colors.muted}
              onSubmitEditing={() => void create()}
              style={[styles.input, { color: theme.colors.text, backgroundColor: theme.colors.base, borderColor: theme.colors.border }]}
            />
            <View style={styles.actions}>
              <Pressable onPress={() => { setAdding(false); setName(''); }} style={[styles.actBtn, { borderColor: theme.colors.border }]}>
                <Text style={{ color: theme.colors.text2 }}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void create()} style={[styles.actBtn, { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent }]}>
                <Text style={{ color: theme.colors.accentText, fontWeight: '600' }}>Create</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  newBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13 },
  newText: { fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, minWidth: 0 },
  badge: { fontSize: 10.5, fontFamily: MONO, marginRight: 4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 420, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 16, gap: 12 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  actBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
});
