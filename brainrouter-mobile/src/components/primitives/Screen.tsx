/**
 * Screen — a themed, safe-area-aware container used by every screen so the
 * canvas, padding, and typography come from the design tokens in one place.
 * Also exports EmptyState for the loading/empty placeholders the M0 screens use
 * until the M1 data surfaces land.
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/ThemeProvider';

export interface ScreenProps {
  title?: string;
  subtitle?: string;
  scroll?: boolean;
  children?: React.ReactNode;
}

export function Screen({ title, subtitle, scroll = true, children }: ScreenProps): React.JSX.Element {
  const theme = useTheme();
  const Body = scroll ? ScrollView : View;
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['top', 'left', 'right']}>
      {title ? (
        <View style={[styles.header, { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md }]}>
          <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
          {subtitle ? <Text style={[styles.subtitle, { color: theme.colors.text2 }]}>{subtitle}</Text> : null}
        </View>
      ) : null}
      <Body
        style={styles.body}
        contentContainerStyle={scroll ? { padding: theme.spacing.lg } : undefined}
      >
        {children}
      </Body>
    </SafeAreaView>
  );
}

export interface EmptyStateProps {
  title: string;
  detail?: string;
}

export function EmptyState({ title, detail }: EmptyStateProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.empty, { padding: theme.spacing.xl }]}>
      <Text style={[styles.emptyTitle, { color: theme.colors.text2 }]}>{title}</Text>
      {detail ? <Text style={[styles.emptyDetail, { color: theme.colors.muted }]}>{detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {},
  title: { fontSize: 20, fontWeight: '600' },
  subtitle: { fontSize: 13, marginTop: 2 },
  body: { flex: 1 },
  empty: { alignItems: 'center', justifyContent: 'center', gap: 6 },
  emptyTitle: { fontSize: 15, fontWeight: '500' },
  emptyDetail: { fontSize: 13, textAlign: 'center' },
});
