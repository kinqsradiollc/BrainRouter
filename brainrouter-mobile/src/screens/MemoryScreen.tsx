/**
 * MemoryScreen (S-34) — search the brain memory engine. A query box over the
 * host `memory-search`, results as ranked recall cards (type · score · stale ·
 * snippet). Read-only. Ports the desktop MemoryPanel (#668). Display logic is
 * the pure `domain/view/memoryView` (unit-tested on mock RecalledMemory[]).
 */
import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RecalledMemory } from '@kinqs/brainrouter-types';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { Icon } from '../components/Icon';
import { MONO } from '../theme/fonts';
import {
  sortByScore, scorePercent, memoryTypeLabel, isStale, memoryCounts, contentSnippet,
} from '../domain/view/memoryView';

export function MemoryScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<RecalledMemory[] | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (): Promise<void> => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    try {
      const r = await transport.query<{ results: RecalledMemory[] }>('memory-search', { q: query });
      setResults(sortByScore(r?.results ?? []));
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const counts = results ? memoryCounts(results) : null;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['left', 'right', 'bottom']}>
      <View style={[styles.bar, { borderBottomColor: theme.colors.border, backgroundColor: theme.colors.raised }]}>
        <Icon name="search" size={18} color={theme.colors.muted} />
        <TextInput
          style={[styles.input, { color: theme.colors.text }]}
          value={q}
          onChangeText={setQ}
          placeholder="Search your memory…"
          placeholderTextColor={theme.colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={run}
        />
        <Pressable onPress={run} hitSlop={6} style={[styles.go, { backgroundColor: theme.colors.accent }]}>
          <Icon name="arrow-up" size={16} color={theme.colors.accentText} />
        </Pressable>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {loading ? (
          <ActivityIndicator color={theme.colors.accent} style={styles.spin} />
        ) : results === null ? (
          <Text style={[styles.hint, { color: theme.colors.muted }]}>
            Search the brain memory engine — persona, codebase facts, decisions, lessons.
          </Text>
        ) : results.length === 0 ? (
          <Text style={[styles.hint, { color: theme.colors.muted }]}>No memories matched.</Text>
        ) : (
          <>
            <Text style={[styles.count, { color: theme.colors.muted }]}>
              {counts!.total} recalls{counts!.stale ? ` · ${counts!.stale} stale` : ''}
            </Text>
            {results.map((m) => (
              <View key={m.recordId} style={[styles.card, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border }]}>
                <View style={styles.head}>
                  <Icon name="brain" size={15} color={theme.colors.text2} />
                  <Text style={[styles.type, { color: theme.colors.text2, borderColor: theme.colors.borderStrong }]}>{memoryTypeLabel(m.type)}</Text>
                  {isStale(m) ? <Text style={[styles.stale, { color: theme.colors.warn, borderColor: theme.colors.warn }]}>stale</Text> : null}
                  <Text style={[styles.score, { color: theme.colors.accent }]}>{scorePercent(m.score)}</Text>
                </View>
                <Text style={[styles.content, { color: theme.colors.text }]}>{contentSnippet(m.content)}</Text>
                <Text style={[styles.meta, { color: theme.colors.muted }]}>{m.recordId}{m.skillTag ? ` · ${m.skillTag}` : ''}</Text>
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
  flex: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, fontSize: 14, padding: 0 },
  go: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 12, gap: 8 },
  spin: { marginTop: 30 },
  hint: { fontSize: 13, textAlign: 'center', marginTop: 30, lineHeight: 19, paddingHorizontal: 20 },
  count: { fontSize: 11, fontFamily: MONO, marginBottom: 2 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 11, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  type: { fontFamily: MONO, fontSize: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  stale: { fontFamily: MONO, fontSize: 9, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  score: { marginLeft: 'auto', fontFamily: MONO, fontSize: 12, fontWeight: '600' },
  content: { fontSize: 13, lineHeight: 19 },
  meta: { fontFamily: MONO, fontSize: 10.5 },
});
