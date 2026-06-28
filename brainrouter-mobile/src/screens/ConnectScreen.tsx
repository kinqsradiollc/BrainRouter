/**
 * ConnectScreen (S-01) — pair with a `brainrouter-host`. Collects the host
 * address + pairing code (the QR-scan path needs expo-camera, a later slice).
 * M1-pending: on Connect, build a RemoteTransport(host, code) and gate the app
 * on its connection; for now the form collects + validates and dismisses.
 */
import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { Icon } from '../components/Icon';
import { MONO } from '../theme/fonts';
import { useConnectionStore } from '../state/connectionStore';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Connect'>;

export function ConnectScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const canConnect = host.trim().length > 0;

  const connect = (): void => {
    // Swap the app's transport to a live RemoteTransport (connectionStore
    // disposes the prior one). Connection status surfaces in the Session topbar.
    useConnectionStore.getState().connect(host.trim(), code.trim() || undefined);
    navigation.goBack();
  };

  const field = {
    backgroundColor: theme.colors.raised,
    borderColor: theme.colors.borderStrong,
    color: theme.colors.text,
    borderRadius: theme.radius.control,
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.base }]} edges={['left', 'right', 'bottom']}>
      <View style={[styles.content, { padding: theme.spacing.xl }]}>
        <View style={[styles.logo, { backgroundColor: theme.colors.accentWash, borderColor: theme.colors.accentLine }]}>
          <Icon name="plug" size={28} color={theme.colors.accent} />
        </View>
        <Text style={[styles.title, { color: theme.colors.text }]}>Pair with a host</Text>
        <Text style={[styles.sub, { color: theme.colors.text2 }]}>
          Connect to a BrainRouter host on your machine to drive your coding agent from here.
        </Text>

        <Text style={[styles.label, { color: theme.colors.text2 }]}>Host address</Text>
        <TextInput
          style={[styles.input, field, { fontFamily: MONO }]}
          value={host}
          onChangeText={setHost}
          placeholder="ws://192.168.1.20:3747"
          placeholderTextColor={theme.colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <Text style={[styles.label, { color: theme.colors.text2 }]}>Pairing code (optional)</Text>
        <TextInput
          style={[styles.input, field, { fontFamily: MONO }]}
          value={code}
          onChangeText={setCode}
          placeholder="6-digit code"
          placeholderTextColor={theme.colors.muted}
          autoCapitalize="none"
          keyboardType="number-pad"
        />

        <Pressable
          onPress={connect}
          disabled={!canConnect}
          style={[styles.btn, { backgroundColor: canConnect ? theme.colors.accent : theme.colors.overlay }]}
        >
          <Icon name="plug" size={18} color={canConnect ? theme.colors.accentText : theme.colors.muted} />
          <Text style={[styles.btnText, { color: canConnect ? theme.colors.accentText : theme.colors.muted }]}>Connect</Text>
        </Pressable>

        <View style={styles.bio}>
          <Icon name="shield" size={14} color={theme.colors.muted} />
          <Text style={[styles.bioText, { color: theme.colors.muted }]}>Credentials are stored encrypted on this device.</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { flex: 1 },
  logo: { width: 56, height: 56, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  sub: { fontSize: 13.5, lineHeight: 19, marginTop: 6, marginBottom: 20 },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 6 },
  input: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 8, marginTop: 22 },
  btnText: { fontSize: 15, fontWeight: '600' },
  bio: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16 },
  bioText: { fontSize: 11 },
});
