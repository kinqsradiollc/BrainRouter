/**
 * ArtifactsScreen (S-28) — the artifacts list. Reuses the ported, tested
 * `domain/view/artifactsView` (sort + draft count + kind label); rows show a
 * kind icon, title, and kind·status·format meta. Sandboxed preview lands later.
 */
import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { ListScreen } from '../components/primitives/ListScreen';
import { Icon, type IconName } from '../components/Icon';
import { sortArtifacts, draftArtifactCount, kindLabel } from '../domain/view/artifactsView';
import type { ArtifactRecord, ArtifactKind } from '@kinqs/brainrouter-types';

function artifactIcon(kind: ArtifactKind): IconName {
  switch (kind) {
    case 'html-prototype':
      return 'code';
    case 'sketch':
      return 'edit';
    case 'review-export':
      return 'review';
    case 'verification-summary':
      return 'check-circle';
    default:
      return 'file';
  }
}

export function ArtifactsScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [records, setRecords] = useState<ArtifactRecord[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await transport.query<ArtifactRecord[]>('artifact-list');
      if (alive) setRecords(r ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const rows = records ? sortArtifacts(records) : [];

  return (
    <ListScreen loading={records === null} isEmpty={rows.length === 0} emptyTitle="No artifacts" emptyDetail="Design notes, reports, and sketches appear here.">
      <Text style={[styles.count, { color: theme.colors.text2 }]}>{draftArtifactCount(rows)} draft · {rows.length} total</Text>
      {rows.map((a) => (
        <View key={a.id} style={[styles.card, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
          <Icon name={artifactIcon(a.kind)} size={18} color={theme.colors.text2} />
          <View style={styles.body}>
            <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
              {a.title}
            </Text>
            <Text style={[styles.meta, { color: theme.colors.muted }]} numberOfLines={1}>
              {kindLabel(a.kind)} · {a.status} · {a.format}
            </Text>
          </View>
        </View>
      ))}
    </ListScreen>
  );
}

const styles = StyleSheet.create({
  count: { fontSize: 12, fontFamily: MONO, marginBottom: 2 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '500' },
  meta: { fontSize: 11, marginTop: 2, fontFamily: MONO },
});
