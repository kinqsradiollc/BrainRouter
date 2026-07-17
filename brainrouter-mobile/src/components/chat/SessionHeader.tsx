/**
 * SessionHeader — the Session screen's custom topbar (prototype UF-03 `.topbar`):
 * back arrow · title + connection line (status dot + label) · context ring · menu
 * (⋮). Replaces the plain native header so the Session screen matches the
 * prototype. Icons are the DESK-4k set.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { Icon } from '../Icon';
import { ContextRing } from '../ContextRing';
import type { ConnectionStatus } from '../../transport/BrainRouterTransport';

export interface SessionHeaderProps {
  title: string;
  status: ConnectionStatus;
  contextPct: number | null;
  onBack: () => void;
  onMenu: () => void;
}

export function SessionHeader({ title, status, contextPct, onBack, onMenu }: SessionHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const dotColor =
    status === 'connected'
      ? theme.colors.accent
      : status === 'offline'
        ? theme.colors.danger
        : status === 'reconnecting'
          ? theme.colors.warn
          : theme.colors.muted;

  return (
    <View style={[styles.bar, { borderBottomColor: theme.colors.border, backgroundColor: theme.colors.base }]}>
      <Pressable onPress={onBack} hitSlop={8} accessibilityLabel="Back" style={styles.back}>
        <Icon name="arrow-left" size={20} color={theme.colors.text2} />
      </Pressable>

      <View style={styles.title}>
        <Text style={[styles.titleText, { color: theme.colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.conn}>
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          <Text style={[styles.connText, { color: theme.colors.muted }]} numberOfLines={1}>
            {status}
          </Text>
        </View>
      </View>

      {contextPct != null ? <ContextRing pct={contextPct} /> : null}

      <Pressable onPress={onMenu} hitSlop={8} accessibilityLabel="Session menu" style={[styles.icbtn, { borderColor: theme.colors.border, backgroundColor: theme.colors.raised }]}>
        <Icon name="dots" size={18} color={theme.colors.text2} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { width: 28, height: 34, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, minWidth: 0 },
  titleText: { fontSize: 15, fontWeight: '600' },
  conn: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  connText: { fontSize: 11, textTransform: 'capitalize' },
  icbtn: { width: 34, height: 34, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
});
