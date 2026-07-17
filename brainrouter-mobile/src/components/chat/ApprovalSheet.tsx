/**
 * ApprovalSheet (S-05) — the headline mobile capability: when the agent needs a
 * human decision it raises an `interaction-request`, and this bottom sheet auto-
 * presents so you can Allow / Deny from anywhere (prototype UF-03 frame 3). It
 * renders the `confirm` interaction (command/context + Allow once / Always allow
 * / Deny). The biometric gate is shown here; wiring expo-local-authentication and
 * the `choice` variant are later M1 slices.
 */
import React from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { MONO } from '../../theme/fonts';
import { Icon } from '../Icon';
import type { InteractionRequest, InteractionResponse } from '../../transport/protocol';

export interface ApprovalSheetProps {
  request: InteractionRequest | null;
  onRespond: (id: string, response: InteractionResponse) => void;
}

export function ApprovalSheet({ request, onRespond }: ApprovalSheetProps): React.JSX.Element {
  const theme = useTheme();
  const confirm = request && request.type === 'confirm' ? request : null;

  const allow = (): void => {
    if (confirm) onRespond(confirm.id, { type: 'confirm', approved: true });
  };
  const deny = (): void => {
    if (confirm) onRespond(confirm.id, { type: 'confirm', approved: false });
  };

  return (
    <Modal visible={!!confirm} transparent animationType="fade" onRequestClose={deny}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: theme.colors.overlay, borderTopColor: theme.colors.borderStrong }]}>
          <View style={[styles.handle, { backgroundColor: theme.colors.borderStrong }]} />
          {confirm ? (
            <>
              <Text style={[styles.title, { color: theme.colors.text }]}>{confirm.title}</Text>
              {confirm.detail ? (
                <View style={[styles.code, { backgroundColor: theme.colors.base, borderColor: theme.colors.border }]}>
                  <Text style={[styles.codeText, { color: theme.colors.text, fontFamily: MONO }]}>{confirm.detail}</Text>
                </View>
              ) : null}
              {confirm.tool ? (
                <Text style={[styles.tool, { color: theme.colors.text2 }]}>
                  Tool <Text style={{ fontFamily: MONO, color: theme.colors.text }}>{confirm.tool}</Text>
                  {confirm.dangerous ? <Text style={{ color: theme.colors.danger }}> · destructive</Text> : null}
                </Text>
              ) : null}

              <Pressable onPress={allow} style={[styles.btn, { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent }]}>
                <Icon name="check-circle" size={18} color={theme.colors.accentText} />
                <Text style={[styles.btnText, { color: theme.colors.accentText }]}>Allow once</Text>
              </Pressable>
              <View style={styles.row}>
                <Pressable onPress={allow} style={[styles.btn, styles.flex, { backgroundColor: theme.colors.raised, borderColor: theme.colors.borderStrong }]}>
                  <Text style={[styles.btnText, { color: theme.colors.text }]}>Always allow</Text>
                </Pressable>
                <Pressable onPress={deny} style={[styles.btn, styles.flex, { borderColor: theme.colors.danger }]}>
                  <Icon name="close" size={18} color={theme.colors.danger} />
                  <Text style={[styles.btnText, { color: theme.colors.danger }]}>Deny</Text>
                </Pressable>
              </View>
              <View style={styles.bio}>
                <Icon name="shield" size={14} color={theme.colors.muted} />
                <Text style={[styles.bioText, { color: theme.colors.muted }]}>Confirm with device biometrics · fails closed</Text>
              </View>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  card: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 28,
  },
  handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginVertical: 8 },
  title: { fontSize: 16, fontWeight: '600', marginTop: 6 },
  tool: { fontSize: 12.5, marginTop: 10 },
  code: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: 12, marginTop: 12 },
  codeText: { fontSize: 12.5, lineHeight: 18 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 13,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 9,
  },
  btnText: { fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 9 },
  flex: { flex: 1 },
  bio: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 14 },
  bioText: { fontSize: 11 },
});
