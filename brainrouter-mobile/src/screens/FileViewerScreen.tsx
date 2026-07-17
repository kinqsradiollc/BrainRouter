/**
 * FileViewerScreen (S-21) — read-only file content viewer. Shows the file at the
 * routed path as monospace text with a language badge (from the tested
 * `domain/view/language` map). Syntax highlighting is a later polish.
 */
import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet, ScrollView } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { monacoLanguage } from '../domain/view/language';
import type { MoreStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'FileViewer'>;

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function FileViewerScreen({ route, navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const { path } = route.params;
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: baseName(path) });
    let alive = true;
    void (async () => {
      const r = await transport.query<{ content?: string }>('read-file', { path });
      if (alive) setContent(r?.content ?? '');
    })();
    return () => {
      alive = false;
    };
  }, [transport, path, navigation]);

  const lang = monacoLanguage(path);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['left', 'right', 'bottom']}>
      <View style={[styles.head, { borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.path, { color: theme.colors.muted }]} numberOfLines={1}>
          {path}
        </Text>
        <Text style={[styles.badge, { color: theme.colors.text2, borderColor: theme.colors.border }]}>{lang}</Text>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={{ padding: theme.spacing.md }}>
        <Text style={[styles.code, { color: theme.colors.text }]}>{content ?? 'Loading…'}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  path: { flex: 1, fontSize: 11, fontFamily: MONO },
  badge: { fontSize: 10, fontFamily: MONO, paddingHorizontal: 6, paddingVertical: 2, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, overflow: 'hidden' },
  code: { fontSize: 12, lineHeight: 18, fontFamily: MONO },
});
