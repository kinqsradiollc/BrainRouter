/**
 * WorktreesScreen (S-30) — git worktrees in the repo. Reuses the ported, tested
 * `domain/parse/worktreeParser` (porcelain → structured entries). Rows show the
 * branch icon, the worktree's directory, its branch (or "detached"), and
 * main/current badges. Read-only; add/remove lands later.
 */
import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { ListScreen } from '../components/primitives/ListScreen';
import { Icon } from '../components/Icon';
import { parseWorktreeList, type WorktreeEntry } from '../domain/parse/worktreeParser';

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function WorktreesScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [entries, setEntries] = useState<WorktreeEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await transport.query<{ porcelain: string; current?: string }>('worktrees');
      if (!alive) return;
      setEntries(r ? parseWorktreeList(r.porcelain ?? '', r.current) : []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const rows = entries ?? [];

  return (
    <ListScreen loading={entries === null} isEmpty={rows.length === 0} emptyTitle="No worktrees" emptyDetail="Git worktrees in this repo appear here.">
      {rows.map((w) => (
        <View
          key={w.path}
          style={[
            styles.card,
            { backgroundColor: w.isCurrent ? theme.colors.accentWash : theme.colors.raised, borderColor: w.isCurrent ? theme.colors.accentLine : theme.colors.border, borderRadius: theme.radius.card },
          ]}
        >
          <Icon name="branch" size={18} color={w.isCurrent ? theme.colors.accent : theme.colors.text2} />
          <View style={styles.body}>
            <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
              {baseName(w.path)}
            </Text>
            <Text style={[styles.meta, { color: theme.colors.muted }]} numberOfLines={1}>
              {w.isDetached ? 'detached' : (w.branch ?? '—')}
              {w.head ? ` · ${w.head.slice(0, 7)}` : ''}
            </Text>
          </View>
          {w.isMain ? <Text style={[styles.badge, { color: theme.colors.text2, borderColor: theme.colors.border }]}>main</Text> : null}
          {w.isCurrent ? <Text style={[styles.badge, { color: theme.colors.accent, borderColor: theme.colors.accentLine }]}>current</Text> : null}
        </View>
      ))}
    </ListScreen>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '500' },
  meta: { fontSize: 11, marginTop: 2, fontFamily: MONO },
  badge: { fontSize: 10, fontFamily: MONO, paddingHorizontal: 6, paddingVertical: 2, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, overflow: 'hidden' },
});
