/**
 * CIScreen (S-25) — GitHub CI / PR checks. Reuses the ported, tested
 * `domain/ci/ciFormat` (summarize + status label + class + duration). A summary
 * chip over a list of checks (name · workflow · duration + status dot). This is
 * GitHub's real CI truth, distinct from the app's local "tests passed".
 */
import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { ListScreen } from '../components/primitives/ListScreen';
import { Icon } from '../components/Icon';
import { summarizeChecks, ciStatusLabel, checkClass, ciDuration, type CheckRow } from '../domain/ci/ciFormat';

export function CIScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [checks, setChecks] = useState<CheckRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await transport.query<CheckRow[]>('ci-checks');
      if (alive) setChecks(r ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const rows = checks ?? [];
  const summary = summarizeChecks(rows);
  const summaryColor =
    summary.conclusion === 'failing' ? theme.colors.danger : summary.conclusion === 'pending' ? theme.colors.warn : summary.conclusion === 'passing' ? theme.colors.accent : theme.colors.muted;

  return (
    <ListScreen loading={checks === null} isEmpty={rows.length === 0} emptyTitle="No CI checks" emptyDetail="GitHub Actions and PR checks appear here.">
      <View style={[styles.summary, { borderColor: theme.colors.border, borderRadius: theme.radius.card, backgroundColor: theme.colors.raised }]}>
        <Icon name={summary.conclusion === 'passing' ? 'check-circle' : summary.conclusion === 'failing' ? 'close' : 'clock'} size={18} color={summaryColor} />
        <Text style={[styles.summaryText, { color: theme.colors.text }]}>{ciStatusLabel(summary)}</Text>
      </View>
      {rows.map((c, i) => {
        const cls = checkClass(c.bucket);
        const dot = cls === 'ok' ? theme.colors.accent : cls === 'fail' || cls === 'cancel' ? theme.colors.danger : cls === 'pending' ? theme.colors.warn : theme.colors.muted;
        const dur = ciDuration(c.startedAt, c.completedAt);
        return (
          <View key={`${c.name}-${i}`} style={[styles.card, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
            <View style={[styles.dot, { backgroundColor: dot }]} />
            <View style={styles.body}>
              <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
                {c.name}
              </Text>
              <Text style={[styles.meta, { color: theme.colors.muted }]} numberOfLines={1}>
                {c.workflow ?? 'check'}
                {dur ? ` · ${dur}` : ''}
              </Text>
            </View>
          </View>
        );
      })}
    </ListScreen>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  summaryText: { fontSize: 13.5, fontWeight: '600' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4 },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: '500', fontFamily: MONO },
  meta: { fontSize: 11, marginTop: 2, fontFamily: MONO },
});
