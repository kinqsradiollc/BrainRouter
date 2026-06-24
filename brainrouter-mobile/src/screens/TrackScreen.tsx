/**
 * TrackScreen (S-31) — the work-item board. Mobile drops desktop drag-and-drop
 * for a status-section list with tap-to-advance (todo → in-progress → done), the
 * mobile-appropriate "move" gesture. Mock-backed; transitions are optimistic
 * locally (the host persists them once wired).
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { ListScreen } from '../components/primitives/ListScreen';
import { Icon, type IconName } from '../components/Icon';

interface WorkItem {
  id: string;
  title: string;
  status: string;
  type?: string;
}

const COLUMNS: Array<{ key: string; label: string; icon: IconName }> = [
  { key: 'todo', label: 'To do', icon: 'tasks' },
  { key: 'in-progress', label: 'In progress', icon: 'clock' },
  { key: 'done', label: 'Done', icon: 'check-circle' },
];

const NEXT: Record<string, string> = { todo: 'in-progress', 'in-progress': 'done', done: 'done' };

export function TrackScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [items, setItems] = useState<WorkItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await transport.query<WorkItem[]>('track-items');
      if (alive) setItems(r ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const advance = (id: string): void =>
    setItems((prev) => prev?.map((it) => (it.id === id ? { ...it, status: NEXT[it.status] ?? it.status } : it)) ?? null);

  const all = items ?? [];

  return (
    <ListScreen loading={items === null} isEmpty={all.length === 0} emptyTitle="No work items" emptyDetail="Track work items across todo / in-progress / done.">
      {COLUMNS.map((col) => {
        const inCol = all.filter((it) => it.status === col.key);
        return (
          <View key={col.key} style={styles.section}>
            <View style={styles.head}>
              <Icon name={col.icon} size={15} color={theme.colors.text2} />
              <Text style={[styles.headLabel, { color: theme.colors.text2 }]}>{col.label}</Text>
              <Text style={[styles.count, { color: theme.colors.muted }]}>{inCol.length}</Text>
            </View>
            {inCol.map((it) => (
              <View key={it.id} style={[styles.card, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
                <View style={styles.body}>
                  <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={2}>
                    {it.title}
                  </Text>
                  <Text style={[styles.meta, { color: theme.colors.muted }]} numberOfLines={1}>
                    {it.id}
                    {it.type ? ` · ${it.type}` : ''}
                  </Text>
                </View>
                {it.status !== 'done' ? (
                  <Pressable onPress={() => advance(it.id)} hitSlop={8} accessibilityLabel="Advance status" style={[styles.move, { borderColor: theme.colors.border }]}>
                    <Icon name="arrow-right" size={16} color={theme.colors.accent} />
                  </Pressable>
                ) : null}
              </View>
            ))}
          </View>
        );
      })}
    </ListScreen>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8, marginBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4 },
  headLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  count: { fontSize: 11, fontFamily: MONO },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '500' },
  meta: { fontSize: 11, marginTop: 2, fontFamily: MONO },
  move: { width: 34, height: 34, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
});
