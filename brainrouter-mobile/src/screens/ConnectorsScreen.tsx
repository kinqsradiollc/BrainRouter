/**
 * ConnectorsScreen (S-35) — the sources your agent can index, with live sync
 * status. Read-mostly list over the host `connectors-list`; sorted by health,
 * error sources highlighted. Ports the desktop connector catalog. Display logic
 * is the pure `domain/view/connectorsView` (unit-tested on mock ConnectorRecord[]).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { Icon, type IconName } from '../components/Icon';
import { MONO } from '../theme/fonts';
import {
  sortConnectors, connectorStatusLabel, connectorCounts, hasError, lastActivityLabel, connectorSubtitle,
} from '../domain/view/connectorsView';

/** A connector source → an app icon (stable names). Falls back to the plug. */
const SOURCE_ICON: Record<string, IconName> = {
  github: 'branch', gitlab: 'branch', bitbucket: 'branch',
  slack: 'bubble', discord: 'bubble', teams: 'bubble', gmail: 'bubble',
  jira: 'plan', linear: 'tasks', asana: 'tasks', clickup: 'tasks',
  notion: 'file', confluence: 'globe', gitbook: 'globe', web: 'globe', discourse: 'globe',
  'google-drive': 'folder', dropbox: 'folder', sharepoint: 'folder', s3: 'folder', filesystem: 'folder',
};

export function ConnectorsScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [items, setItems] = useState<ConnectorRecord[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await transport.query<{ connectors: ConnectorRecord[] }>('connectors-list', {});
      setItems(sortConnectors(r?.connectors ?? []));
    } catch {
      setItems([]);
    }
  }, [transport]);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const counts = items ? connectorCounts(items) : null;
  const statusColor = (c: ConnectorRecord): string =>
    hasError(c) ? theme.colors.danger : c.status === 'active' ? theme.colors.accent : theme.colors.text2;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['left', 'right', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.accent} />}
      >
        {items === null ? (
          <ActivityIndicator color={theme.colors.accent} style={styles.spin} />
        ) : items.length === 0 ? (
          <Text style={[styles.hint, { color: theme.colors.muted }]}>
            No connectors yet. Connect a source (GitHub, Slack, Notion…) on the desktop; it appears here with sync status.
          </Text>
        ) : (
          <>
            <Text style={[styles.count, { color: theme.colors.muted }]}>
              {counts!.total} sources{counts!.error ? ` · ${counts!.error} error` : ''}
            </Text>
            {items.map((c) => (
              <View
                key={c.id}
                style={[styles.card, { backgroundColor: theme.colors.raised, borderColor: hasError(c) ? theme.colors.danger : theme.colors.border }]}
              >
                <Icon name={SOURCE_ICON[c.source] ?? 'plug'} size={20} color={statusColor(c)} />
                <View style={styles.m}>
                  <Text style={[styles.nm, { color: theme.colors.text }]} numberOfLines={1}>{c.name}</Text>
                  <Text style={[styles.su, { color: hasError(c) ? theme.colors.danger : theme.colors.muted }]} numberOfLines={1}>
                    {connectorSubtitle(c)} · {lastActivityLabel(c)}
                  </Text>
                </View>
                <Text style={[styles.pill, { color: statusColor(c), borderColor: statusColor(c) }]}>{connectorStatusLabel(c.status)}</Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { padding: 12, gap: 8, flexGrow: 1 },
  spin: { marginTop: 30 },
  hint: { fontSize: 13, textAlign: 'center', marginTop: 30, lineHeight: 19, paddingHorizontal: 20 },
  count: { fontSize: 11, fontFamily: MONO, marginBottom: 2 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 11, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12 },
  m: { flex: 1, minWidth: 0 },
  nm: { fontSize: 14, fontWeight: '500' },
  su: { fontFamily: MONO, fontSize: 11, marginTop: 2 },
  pill: { fontFamily: MONO, fontSize: 10, fontWeight: '500', borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
});
