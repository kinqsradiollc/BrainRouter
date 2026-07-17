/**
 * AnnotationsScreen (S-27) — the annotations list. Reuses the ported, tested
 * `domain/view/annotationsView` (sort + counts + anchor label); rows show a
 * severity dot, the comment body, and type·status·anchor meta.
 */
import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { ListScreen } from '../components/primitives/ListScreen';
import { sortAnnotations, openAnnotationCount, anchorLabel } from '../domain/view/annotationsView';
import type { AnnotationRecord } from '@kinqs/brainrouter-types';

export function AnnotationsScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [records, setRecords] = useState<AnnotationRecord[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await transport.query<AnnotationRecord[]>('annotation-list');
      if (alive) setRecords(r ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const rows = records ? sortAnnotations(records) : [];

  return (
    <ListScreen loading={records === null} isEmpty={rows.length === 0} emptyTitle="No annotations" emptyDetail="Feedback and review comments appear here.">
      <Text style={[styles.count, { color: theme.colors.text2 }]}>{openAnnotationCount(rows)} open · {rows.length} total</Text>
      {rows.map((a) => {
        const sev = a.severity;
        const dot =
          sev === 'high' ? theme.colors.danger : sev === 'medium' ? theme.colors.warn : sev === 'low' ? theme.colors.text2 : theme.colors.muted;
        const where = anchorLabel(a.anchor);
        return (
          <View key={a.id} style={[styles.card, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
            <View style={styles.head}>
              <View style={[styles.dot, { backgroundColor: dot }]} />
              <Text style={[styles.body, { color: theme.colors.text }]} numberOfLines={2}>
                {a.body}
              </Text>
            </View>
            <Text style={[styles.meta, { color: theme.colors.muted }]} numberOfLines={1}>
              {a.type} · {a.status}
              {where ? ` · ${where}` : ''}
            </Text>
          </View>
        );
      })}
    </ListScreen>
  );
}

const styles = StyleSheet.create({
  count: { fontSize: 12, fontFamily: MONO, marginBottom: 2 },
  card: { padding: 12, borderWidth: StyleSheet.hairlineWidth, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  body: { flex: 1, fontSize: 13.5, lineHeight: 19 },
  meta: { fontSize: 11, fontFamily: MONO },
});
