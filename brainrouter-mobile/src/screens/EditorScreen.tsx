/**
 * EditorScreen (S-32) — a lightweight editable code view (a demo workspace file).
 * The full desktop editor is Monaco; mobile uses a monospace TextInput for quick
 * edits on the go. Mock-backed: Save is local until the host's `file-write` is
 * wired. A WebView CodeMirror upgrade can slot in behind this same screen later.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { Icon } from '../components/Icon';
import { monacoLanguage } from '../domain/view/language';

const DEMO_PATH = 'src/auth/token.ts';

export function EditorScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await transport.query<{ content?: string }>('read-file', { path: DEMO_PATH });
      if (alive) setContent(r?.content ?? '');
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const onChange = (t: string): void => {
    setContent(t);
    setDirty(true);
    setSaved(false);
  };

  const save = (): void => {
    // TODO(host): query 'file-write' { path: DEMO_PATH, content }. Local-only for the demo.
    setDirty(false);
    setSaved(true);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['left', 'right', 'bottom']}>
      <View style={[styles.head, { borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.path, { color: theme.colors.muted }]} numberOfLines={1}>
          {DEMO_PATH}
        </Text>
        <Text style={[styles.badge, { color: theme.colors.text2, borderColor: theme.colors.border }]}>{monacoLanguage(DEMO_PATH)}</Text>
        <Pressable onPress={save} disabled={!dirty} hitSlop={6} style={[styles.save, { backgroundColor: dirty ? theme.colors.accent : theme.colors.overlay }]}>
          <Icon name="check-circle" size={14} color={dirty ? theme.colors.accentText : theme.colors.muted} />
          <Text style={[styles.saveText, { color: dirty ? theme.colors.accentText : theme.colors.muted }]}>{saved ? 'Saved' : 'Save'}</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={{ padding: theme.spacing.md }}>
        <TextInput
          style={[styles.code, { color: theme.colors.text }]}
          value={content ?? ''}
          onChangeText={onChange}
          editable={content !== null}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
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
  save: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  saveText: { fontSize: 12, fontWeight: '600' },
  code: { fontSize: 12.5, lineHeight: 18, fontFamily: MONO, textAlignVertical: 'top', minHeight: 400 },
});
