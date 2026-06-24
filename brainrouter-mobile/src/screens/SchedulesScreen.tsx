/**
 * SchedulesScreen (S-29) — cron & one-off scheduled runs. Reuses the ported,
 * tested `domain/view/scheduleView` (partition + describe + relative time); rows
 * show a clock icon, the command, and cadence · next-run meta, split into
 * Active / Disabled sections.
 */
import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { ListScreen } from '../components/primitives/ListScreen';
import { Icon } from '../components/Icon';
import { partitionSchedules, describeSchedule, relTime, type ScheduleRecordView } from '../domain/view/scheduleView';

export function SchedulesScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [records, setRecords] = useState<ScheduleRecordView[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await transport.query<ScheduleRecordView[]>('schedule-list');
      if (alive) setRecords(r ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const { active, disabled } = partitionSchedules(records ?? []);
  const now = Date.now();

  const card = (s: ScheduleRecordView, on: boolean): React.JSX.Element => (
    <View key={s.id} style={[styles.card, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card, opacity: on ? 1 : 0.6 }]}>
      <Icon name="clock" size={18} color={on ? theme.colors.accent : theme.colors.muted} />
      <View style={styles.body}>
        <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
          {s.command}
        </Text>
        <Text style={[styles.meta, { color: theme.colors.muted }]} numberOfLines={1}>
          {describeSchedule(s)} · next {relTime(s.nextRun, now)}
        </Text>
      </View>
    </View>
  );

  return (
    <ListScreen loading={records === null} isEmpty={active.length + disabled.length === 0} emptyTitle="No schedules" emptyDetail="Cron and one-off runs appear here.">
      {active.length > 0 ? <Text style={[styles.section, { color: theme.colors.text2 }]}>Active</Text> : null}
      {active.map((s) => card(s, true))}
      {disabled.length > 0 ? <Text style={[styles.section, { color: theme.colors.text2 }]}>Disabled</Text> : null}
      {disabled.map((s) => card(s, false))}
    </ListScreen>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '500', fontFamily: MONO },
  meta: { fontSize: 11, marginTop: 2, fontFamily: MONO },
});
