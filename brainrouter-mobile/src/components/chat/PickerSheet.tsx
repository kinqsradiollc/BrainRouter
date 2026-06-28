/**
 * PickerSheet — a small bottom-sheet option list (Modal) behind the composer's
 * Model / Mode / Effort pills. Title + tappable options with the active one
 * checked; tapping the backdrop dismisses.
 */
import React from 'react';
import { Modal, View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { MONO } from '../../theme/fonts';
import { Icon } from '../Icon';

export interface PickerOption {
  key: string;
  label: string;
  sub?: string;
}

export interface PickerSheetProps {
  visible: boolean;
  title: string;
  options: PickerOption[];
  selectedKey?: string;
  emptyHint?: string;
  onPick: (key: string) => void;
  onClose: () => void;
}

export function PickerSheet({ visible, title, options, selectedKey, emptyHint, onPick, onClose }: PickerSheetProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* swallow taps on the card so they don't dismiss */}
        <Pressable style={[styles.card, { backgroundColor: theme.colors.overlay, borderTopColor: theme.colors.borderStrong }]} onPress={() => {}}>
          <View style={[styles.handle, { backgroundColor: theme.colors.borderStrong }]} />
          <Text style={[styles.title, { color: theme.colors.text2 }]}>{title}</Text>
          {options.length === 0 ? (
            <Text style={[styles.empty, { color: theme.colors.muted }]}>{emptyHint ?? 'No options.'}</Text>
          ) : (
            <ScrollView style={styles.list}>
              {options.map((o) => {
                const on = o.key === selectedKey;
                return (
                  <Pressable
                    key={o.key}
                    onPress={() => onPick(o.key)}
                    style={[styles.row, { backgroundColor: on ? theme.colors.accentWash : 'transparent', borderColor: on ? theme.colors.accentLine : theme.colors.border }]}
                  >
                    <View style={styles.rowBody}>
                      <Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: on ? '600' : '400' }}>{o.label}</Text>
                      {o.sub ? (
                        <Text style={{ color: theme.colors.muted, fontSize: 11, fontFamily: MONO }} numberOfLines={1}>
                          {o.sub}
                        </Text>
                      ) : null}
                    </View>
                    {on ? <Icon name="check-circle" size={18} color={theme.colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  card: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 28,
  },
  handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginVertical: 8 },
  title: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 4 },
  empty: { fontSize: 13, padding: 12 },
  list: { maxHeight: 340 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, marginBottom: 6 },
  rowBody: { flex: 1, minWidth: 0 },
});
