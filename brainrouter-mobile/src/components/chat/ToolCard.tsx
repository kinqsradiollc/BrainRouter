/**
 * ToolCard — one tool call in the transcript (prototype UF-03 `.tool`): a desktop
 * icon chosen from the tool name, the tool label, a mono one-line target/summary,
 * and a status indicator (spinner while running → accent dot ok / danger dot
 * error). Pure presentation over a `tool` TranscriptItem.
 */
import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { Icon, type IconName } from '../Icon';
import { MONO } from '../../theme/fonts';
import type { TranscriptItem } from '../../domain/session/transcript';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/** Map a tool name to its desktop glyph (mirrors the prototype's icon choices). */
function toolIcon(tool: string): IconName {
  const t = tool.toLowerCase();
  if (t.includes('edit') || t.includes('write')) return 'edit';
  if (t.includes('bash') || t.includes('command') || t.includes('terminal') || t.includes('run')) return 'terminal';
  if (t.includes('grep') || t.includes('search') || t.includes('glob')) return 'search';
  if (t.includes('read') || t.includes('file') || t.includes('cat')) return 'file';
  return 'code';
}

/** The one-line target: the tool's summary, else its most salient argument. */
function targetLine(item: ToolItem): string {
  if (item.summary) return item.summary;
  const a = item.args;
  const salient = a.path ?? a.pattern ?? a.command ?? a.query ?? a.file ?? Object.values(a)[0];
  return salient === undefined ? '' : String(salient);
}

function label(tool: string): string {
  return tool.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ToolCard({ item }: { item: ToolItem }): React.JSX.Element {
  const theme = useTheme();
  const dotColor =
    item.status === 'error' ? theme.colors.danger : item.status === 'ok' ? theme.colors.accent : theme.colors.muted;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card, padding: theme.spacing.md },
      ]}
    >
      <Icon name={toolIcon(item.tool)} size={18} color={theme.colors.text2} />
      <View style={styles.body}>
        <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
          {label(item.tool)}
        </Text>
        <Text style={[styles.sub, { color: theme.colors.muted, fontFamily: MONO }]} numberOfLines={1}>
          {targetLine(item)}
        </Text>
      </View>
      {item.status === 'running' ? (
        <ActivityIndicator size="small" color={theme.colors.accent} />
      ) : (
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, borderWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 13, fontWeight: '500' },
  sub: { fontSize: 11.5, marginTop: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
});
