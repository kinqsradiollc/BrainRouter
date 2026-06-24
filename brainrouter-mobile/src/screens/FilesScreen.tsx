/**
 * FilesScreen (S-20) — read-only workspace file browser. A flat list of paths
 * from the `file-list` query; tapping opens the FileViewer. (A full tree lands
 * later; flat is enough to inspect on the go.)
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { MONO } from '../theme/fonts';
import { ListScreen } from '../components/primitives/ListScreen';
import { Icon } from '../components/Icon';
import type { MoreStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'Files'>;

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function FilesScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [files, setFiles] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await transport.query<{ files: string[] }>('list-files');
      if (alive) setFiles(r?.files ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const rows = files ?? [];

  return (
    <ListScreen loading={files === null} isEmpty={rows.length === 0} emptyTitle="No files" emptyDetail="Workspace files appear here.">
      {rows.map((p) => (
        <Pressable
          key={p}
          onPress={() => navigation.navigate('FileViewer', { path: p })}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: pressed ? theme.colors.overlay : theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card },
          ]}
        >
          <Icon name="file" size={18} color={theme.colors.text2} />
          <View style={styles.body}>
            <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
              {baseName(p)}
            </Text>
            <Text style={[styles.path, { color: theme.colors.muted }]} numberOfLines={1}>
              {p}
            </Text>
          </View>
          <Icon name="chev-right" size={16} color={theme.colors.muted} />
        </Pressable>
      ))}
    </ListScreen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: '500' },
  path: { fontSize: 11, marginTop: 2, fontFamily: MONO },
});
