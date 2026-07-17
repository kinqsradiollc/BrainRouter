/**
 * ActivityScreen (S-10) — the cross-workspace task dashboard. Reads
 * `globalDashboard()` and renders the ported `domain/workspace/dashboard` logic:
 * lifecycle/kind tabs (running/finished/failed/workflows/agents/bash) with live
 * counts, then a card per task (desktop icon by kind + workspace + status dot).
 * Pure filtering/counting reused verbatim from the desktop.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View, StyleSheet, ScrollView } from 'react-native';
import { Screen, EmptyState } from '../components/primitives/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { Icon, type IconName } from '../components/Icon';
import { MONO } from '../theme/fonts';
import {
  DASH_TABS,
  filterTasks,
  countByTab,
  allTasks,
  taskLifecycle,
  taskStatusLabel,
  type DashTab,
  type DashTask,
  type WorkspaceDash,
} from '../domain/workspace/dashboard';

function taskIcon(kind: string): IconName {
  const k = kind.toLowerCase();
  if (k.includes('workflow')) return 'tasks';
  if (k.includes('bash') || k.includes('command') || k.includes('shell')) return 'terminal';
  if (k.includes('agent') || k.includes('verif') || k.includes('worker') || k.includes('sub')) return 'brain';
  return 'code';
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function ActivityScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [boards, setBoards] = useState<WorkspaceDash[] | null>(null);
  const [tab, setTab] = useState<DashTab>('running');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const dash = await transport.globalDashboard();
      if (!alive) return;
      setBoards(
        dash.workspaces.map((w) => ({
          workspaceRoot: w.workspaceRoot,
          tasks: (w.tasks as unknown as DashTask[]) ?? [],
          reviewGate: w.reviewGate,
        })),
      );
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const tasks = boards ? allTasks(boards) : [];
  const counts = countByTab(tasks);
  const visible = filterTasks(tasks, tab);

  return (
    <Screen title="Activity" subtitle="Tasks across your workspaces" scroll={false}>
      <View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm }}
        >
          {DASH_TABS.map((t) => {
            const on = t === tab;
            return (
              <Pressable
                key={t}
                onPress={() => setTab(t)}
                style={[styles.tab, { backgroundColor: on ? theme.colors.accentWash : theme.colors.raised, borderColor: on ? theme.colors.accentLine : theme.colors.border }]}
              >
                <Text style={{ color: on ? theme.colors.text : theme.colors.text2, fontSize: 12.5, textTransform: 'capitalize' }}>{t}</Text>
                <Text style={{ color: theme.colors.muted, fontSize: 11, fontFamily: MONO }}>{counts[t]}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView style={styles.flex} contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
        {boards === null ? (
          <EmptyState title="Loading…" />
        ) : visible.length === 0 ? (
          <EmptyState title={`No ${tab} tasks`} detail="Background tasks across your workspaces appear here." />
        ) : (
          visible.map((t) => {
            const life = taskLifecycle(t);
            const dot = life === 'failed' ? theme.colors.danger : life === 'running' ? theme.colors.accent : theme.colors.text2;
            return (
              <View key={t.id} style={[styles.card, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
                <Icon name={taskIcon(t.kind)} size={18} color={theme.colors.text2} />
                <View style={styles.cardBody}>
                  <Text style={{ color: theme.colors.text, fontSize: 13.5, fontWeight: '500' }} numberOfLines={1}>
                    {t.label}
                  </Text>
                  <Text style={{ color: theme.colors.muted, fontSize: 11, fontFamily: MONO }} numberOfLines={1}>
                    {baseName(t.workspaceRoot ?? '')} · {taskStatusLabel(t)}
                  </Text>
                </View>
                <View style={[styles.dot, { backgroundColor: dot }]} />
              </View>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  cardBody: { flex: 1, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
