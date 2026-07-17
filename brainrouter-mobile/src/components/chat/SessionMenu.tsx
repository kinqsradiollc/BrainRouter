/**
 * SessionMenu — the Session topbar's ⋮ action sheet. A lightweight bottom-sheet
 * Modal listing session actions (View plan, Review changes, …). Tapping the
 * backdrop or an item dismisses it.
 */
import React from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { Icon, type IconName } from '../Icon';

export interface SessionMenuItem {
  label: string;
  icon: IconName;
  onPress: () => void;
}

export interface SessionMenuProps {
  visible: boolean;
  onClose: () => void;
  items: SessionMenuItem[];
}

export function SessionMenu({ visible, onClose, items }: SessionMenuProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={[styles.card, { backgroundColor: theme.colors.overlay, borderTopColor: theme.colors.borderStrong }]}>
          <View style={[styles.handle, { backgroundColor: theme.colors.borderStrong }]} />
          {items.map((it) => (
            <Pressable
              key={it.label}
              onPress={() => {
                onClose();
                it.onPress();
              }}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.colors.raised : 'transparent' }]}
            >
              <Icon name={it.icon} size={20} color={theme.colors.text2} />
              <Text style={[styles.label, { color: theme.colors.text }]}>{it.label}</Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  card: { borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 28 },
  handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 14, borderRadius: 8 },
  label: { fontSize: 15, fontWeight: '500' },
});
