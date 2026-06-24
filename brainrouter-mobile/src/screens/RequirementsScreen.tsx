/**
 * RequirementsScreen (S-26) — the requirements list. Reuses the ported, tested
 * `domain/view/requirementsView` (sort + active count); rows show a priority dot,
 * title, and status·priority·id meta. Read-only for now; create/edit lands later.
 */
import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { ListScreen } from '../components/primitives/ListScreen';
import { sortRequirements, activeRequirementCount } from '../domain/view/requirementsView';
import type { RequirementRecord } from '@kinqs/brainrouter-types';

export function RequirementsScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [records, setRecords] = useState<RequirementRecord[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await transport.query<RequirementRecord[]>('requirement-list');
      if (alive) setRecords(r ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const rows = records ? sortRequirements(records) : [];

  return (
    <ListScreen loading={records === null} isEmpty={rows.length === 0} emptyTitle="No requirements" emptyDetail="Requirements you capture appear here.">
      <Text style={[styles.count, { color: theme.colors.text2 }]}>
        {activeRequirementCount(rows)} active · {rows.length} total
      </Text>
      {rows.map((r) => {
        const dot = r.priority === 'high' ? theme.colors.danger : r.priority === 'medium' ? theme.colors.warn : theme.colors.muted;
        return (
          <View key={r.id} style={[styles.card, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
            <View style={[styles.dot, { backgroundColor: dot }]} />
            <View style={styles.body}>
              <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
                {r.title}
              </Text>
              <Text style={[styles.meta, { color: theme.colors.muted }]} numberOfLines={1}>
                {r.status} · {r.priority} · {r.id}
              </Text>
            </View>
          </View>
        );
      })}
    </ListScreen>
  );
}

const styles = StyleSheet.create({
  count: { fontSize: 12, fontFamily: MONO, marginBottom: 2 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4 },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '500' },
  meta: { fontSize: 11, marginTop: 2, fontFamily: MONO },
});
