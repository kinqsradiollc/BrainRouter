/**
 * SearchScreen (S-22) — search across sessions & messages. A search box over a
 * results list; submitting runs the transport `search` query. Logic is
 * mobile-friendly already (the host owns the index).
 */
import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { EmptyState } from '../components/primitives/Screen';
import { Icon } from '../components/Icon';
import { MONO } from '../theme/fonts';

interface SearchHit {
  sessionKey: string;
  title?: string;
  snippet: string;
}

export function SearchScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searched, setSearched] = useState(false);

  const run = async (): Promise<void> => {
    const term = q.trim();
    if (!term) return;
    setSearched(true);
    setHits(null);
    const r = await transport.query<SearchHit[]>('search', { q: term });
    setHits(r ?? []);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['left', 'right', 'bottom']}>
      <View style={[styles.bar, { borderBottomColor: theme.colors.border }]}>
        <View style={[styles.box, { backgroundColor: theme.colors.raised, borderColor: theme.colors.borderStrong }]}>
          <Icon name="search" size={16} color={theme.colors.muted} />
          <TextInput
            style={[styles.input, { color: theme.colors.text }]}
            value={q}
            onChangeText={setQ}
            placeholder="Search sessions & messages"
            placeholderTextColor={theme.colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={run}
          />
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.sm }} keyboardShouldPersistTaps="handled">
        {!searched ? (
          <EmptyState title="Search your work" detail="Find earlier sessions and messages by keyword." />
        ) : hits === null ? (
          <EmptyState title="Searching…" />
        ) : hits.length === 0 ? (
          <EmptyState title="No matches" detail={`Nothing found for “${q.trim()}”.`} />
        ) : (
          hits.map((h, i) => (
            <View key={`${h.sessionKey}-${i}`} style={[styles.hit, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
              <Text style={[styles.hitTitle, { color: theme.colors.text }]} numberOfLines={1}>
                {h.title ?? h.sessionKey}
              </Text>
              <Text style={[styles.hitSnippet, { color: theme.colors.text2 }]} numberOfLines={2}>
                {h.snippet}
              </Text>
              <Text style={[styles.hitMeta, { color: theme.colors.muted }]} numberOfLines={1}>
                {h.sessionKey}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  bar: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  box: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  input: { flex: 1, fontSize: 14, padding: 0 },
  hit: { padding: 12, borderWidth: StyleSheet.hairlineWidth, gap: 4 },
  hitTitle: { fontSize: 14, fontWeight: '500' },
  hitSnippet: { fontSize: 12.5, lineHeight: 17 },
  hitMeta: { fontSize: 11, fontFamily: MONO },
});
