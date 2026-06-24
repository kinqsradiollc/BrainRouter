/**
 * ChangesScreen (S-07) — the working-tree diff + commit/push surface, review-
 * gated (prototype UF-06). Pushed onto the Chats stack (native header owns the
 * back button), so it renders a bare safe-area body — not a Screen title. Lists
 * changed files with +/- counts and a changeset summary, then a commit bar whose
 * state comes from the ported `reviewGateUi.commitBlocked` rule.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EmptyState } from '../components/primitives/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { Icon } from '../components/Icon';
import { MONO } from '../theme/fonts';
import { commitBlocked } from '../domain/view/reviewGateUi';

// `changed-files` from the host is a bare array of porcelain rows — status code
// (M/A/D/??) + workspace-relative path. Per-file line counts are NOT part of this
// query (the desktop shows them only in the end-of-turn changeset); the aggregate
// +/- comes from `git-info`, exactly like the desktop EnvironmentPanel.
interface ChangedFile {
  path: string;
  status: string;
}
interface GitInfo {
  files: number;
  insertions: number;
  deletions: number;
}
interface Gate {
  status: string;
  blocked: boolean;
  reason: string;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function ChangesScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [stat, setStat] = useState<GitInfo | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const cf = await transport.query<ChangedFile[]>('changed-files');
      const gi = await transport.query<GitInfo>('git-info');
      const rc = await transport.query<{ gate: Gate | null }>('review-current');
      if (!alive) return;
      setFiles(Array.isArray(cf) ? cf : []);
      setStat(gi ?? null);
      setGate(rc?.gate ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const list = files ?? [];
  const totalAdd = stat?.insertions ?? 0;
  const totalDel = stat?.deletions ?? 0;
  const blocked = commitBlocked(gate, list.length);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['left', 'right', 'bottom']}>
      <ScrollView style={styles.flex} contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
        {files === null ? (
          <EmptyState title="Loading…" />
        ) : list.length === 0 ? (
          <EmptyState title="No changes" detail="A clean working tree — nothing to commit." />
        ) : (
          <>
            <View style={[styles.csum, { backgroundColor: theme.colors.accentWash, borderColor: theme.colors.accentLine, borderRadius: theme.radius.card }]}>
              <Icon name="diff" size={18} color={theme.colors.accent} />
              <Text style={{ color: theme.colors.text, fontSize: 12.5, fontFamily: MONO }}>
                {list.length} files · <Text style={{ color: theme.colors.accent }}>+{totalAdd}</Text> <Text style={{ color: theme.colors.danger }}>−{totalDel}</Text>
              </Text>
            </View>
            {list.map((f) => (
              <View key={f.path} style={[styles.row, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
                <Icon name="file" size={18} color={theme.colors.text2} />
                <View style={styles.rowBody}>
                  <Text style={{ color: theme.colors.text, fontSize: 13.5 }} numberOfLines={1}>
                    {baseName(f.path)}
                  </Text>
                  <Text style={{ color: theme.colors.muted, fontSize: 11, fontFamily: MONO }} numberOfLines={1}>
                    {f.path}
                  </Text>
                </View>
                <Text style={{ fontFamily: MONO, fontSize: 12, color: theme.colors.text2 }}>{f.status}</Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>

      {list.length > 0 ? (
        <View style={[styles.bar, { backgroundColor: theme.colors.raised, borderTopColor: theme.colors.border }]}>
          {blocked ? (
            <View style={[styles.gate, { borderColor: theme.colors.warn }]}>
              <Icon name="warn" size={16} color={theme.colors.warn} />
              <Text style={{ color: theme.colors.text2, fontSize: 12.5, flex: 1 }} numberOfLines={2}>
                {gate?.reason ?? 'Review required before commit'}
              </Text>
            </View>
          ) : null}
          <Pressable disabled={blocked} style={[styles.commit, { backgroundColor: blocked ? theme.colors.overlay : theme.colors.accent }]}>
            <Icon name="commit" size={18} color={blocked ? theme.colors.muted : theme.colors.accentText} />
            <Text style={{ color: blocked ? theme.colors.muted : theme.colors.accentText, fontWeight: '600', fontSize: 14 }}>
              {blocked ? 'Review required' : 'Commit & push'}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  csum: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  rowBody: { flex: 1, minWidth: 0 },
  bar: { padding: 12, borderTopWidth: StyleSheet.hairlineWidth, gap: 8 },
  gate: { flexDirection: 'row', alignItems: 'center', gap: 8, borderLeftWidth: 2, paddingLeft: 8, paddingVertical: 2 },
  commit: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: 8 },
});
