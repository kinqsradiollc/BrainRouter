/**
 * ListScreen — a bare safe-area + scroll container for the pushed list screens
 * (Requirements / Annotations / Artifacts / Schedules / …). The native stack
 * header owns the title + back, so this renders no title of its own. Handles the
 * loading / empty placeholders so each screen only supplies its rows.
 */
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../theme/ThemeProvider';
import { EmptyState } from './Screen';

export interface ListScreenProps {
  loading: boolean;
  isEmpty: boolean;
  emptyTitle: string;
  emptyDetail?: string;
  children?: React.ReactNode;
}

export function ListScreen({ loading, isEmpty, emptyTitle, emptyDetail, children }: ListScreenProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['left', 'right', 'bottom']}>
      <ScrollView style={styles.flex} contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
        {loading ? <EmptyState title="Loading…" /> : isEmpty ? <EmptyState title={emptyTitle} detail={emptyDetail} /> : children}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
});
