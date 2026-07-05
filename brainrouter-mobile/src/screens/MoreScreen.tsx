/**
 * MoreScreen — the "More" tab hub: a list of the secondary record/tool surfaces
 * (Requirements · Annotations · Artifacts · Schedules, with Files/Search/CI to
 * come) that don't warrant their own tab. Each row opens its screen in the More
 * stack. Icons are the DESK-4k set.
 */
import React from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen } from '../components/primitives/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { Icon, type IconName } from '../components/Icon';
import type { MoreStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'More'>;

type ToolKey = 'Memory' | 'Requirements' | 'Annotations' | 'Artifacts' | 'Schedules' | 'CI' | 'Worktrees' | 'Search' | 'Files' | 'Track' | 'Terminal' | 'Editor';

const TOOLS: Array<{ key: ToolKey; label: string; icon: IconName; desc: string }> = [
  { key: 'Memory', label: 'Memory', icon: 'brain', desc: 'Search the brain memory engine' },
  { key: 'Requirements', label: 'Requirements', icon: 'plan', desc: 'Structured intent & acceptance criteria' },
  { key: 'Annotations', label: 'Annotations', icon: 'edit', desc: 'Feedback & review comments' },
  { key: 'Artifacts', label: 'Artifacts', icon: 'file', desc: 'Design notes, reports, sketches' },
  { key: 'Schedules', label: 'Schedules', icon: 'clock', desc: 'Cron & one-off scheduled runs' },
  { key: 'CI', label: 'CI checks', icon: 'check-circle', desc: 'GitHub Actions & PR checks' },
  { key: 'Worktrees', label: 'Worktrees', icon: 'branch', desc: 'Git worktrees in this repo' },
  { key: 'Files', label: 'Files', icon: 'folder', desc: 'Browse & read workspace files' },
  { key: 'Editor', label: 'Editor', icon: 'edit', desc: 'Quick edits to a workspace file' },
  { key: 'Terminal', label: 'Terminal', icon: 'terminal', desc: 'Run commands on the paired host' },
  { key: 'Track', label: 'Track', icon: 'tasks', desc: 'Work-item board (todo / doing / done)' },
  { key: 'Search', label: 'Search', icon: 'search', desc: 'Find sessions & messages' },
];

export function MoreScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  return (
    <Screen title="More" subtitle="Tools & records">
      <View style={{ gap: theme.spacing.sm }}>
        {TOOLS.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => navigation.navigate(t.key)}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? theme.colors.overlay : theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card },
            ]}
          >
            <Icon name={t.icon} size={20} color={theme.colors.text2} />
            <View style={styles.body}>
              <Text style={[styles.label, { color: theme.colors.text }]}>{t.label}</Text>
              <Text style={[styles.desc, { color: theme.colors.muted }]} numberOfLines={1}>
                {t.desc}
              </Text>
            </View>
            <Icon name="chev-right" size={16} color={theme.colors.muted} />
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, minWidth: 0 },
  label: { fontSize: 15, fontWeight: '500' },
  desc: { fontSize: 12, marginTop: 2 },
});
