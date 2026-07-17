/**
 * SettingsScreen (S-14) — settings home. Appearance (dark/light + runtime accent,
 * the desktop's overridable accent), the model picker (S-16: `list-models` →
 * `set-model`, prototype UF/US-14), connection status, and about. Theme controls
 * are local (ThemeProvider); the model list comes from the transport.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { Screen } from '../components/primitives/Screen';
import { useTheme, useThemeControls } from '../theme/ThemeProvider';
import { useTransport, useConnectionStatus } from '../state/TransportProvider';
import { Icon } from '../components/Icon';
import { MONO } from '../theme/fonts';
import { normalizeModels } from '../domain/session/sessionControls';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useConnectionStore } from '../state/connectionStore';
import type { RootStackParamList } from '../navigation/types';

interface ModelInfo {
  id: string;
  label: string;
}

const ACCENTS: Array<{ label: string; value: string | undefined }> = [
  { label: 'Indigo', value: undefined },
  { label: 'Green', value: '#34C28E' },
  { label: 'Orange', value: 'hsl(16, 65%, 58%)' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text style={[styles.label, { color: theme.colors.text2 }]}>{title}</Text>
      {children}
    </View>
  );
}

export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const { themeName, setThemeName, setAccent } = useThemeControls();
  const transport = useTransport();
  const status = useConnectionStatus();
  const rootNav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const mode = useConnectionStore((s) => s.mode);
  const hosts = useConnectionStore((s) => s.hosts);
  const activeUrl = useConnectionStore((s) => s.activeUrl);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await transport.query<{ models: Array<string | ModelInfo>; current: string }>('list-models');
      if (!alive) return;
      setModels(normalizeModels(res?.models));
      setCurrentModel(res?.current ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const pickModel = (id: string): void => {
    setCurrentModel(id);
    transport.send({ kind: 'set-model', model: id, persist: true });
  };

  return (
    <Screen title="Settings" subtitle={`Connection · ${status}`}>
      <View style={{ gap: theme.spacing.xl }}>
        <Section title="Appearance">
          <View style={styles.rowWrap}>
            {(['dark', 'light'] as const).map((name) => {
              const on = themeName === name;
              return (
                <Pressable
                  key={name}
                  onPress={() => setThemeName(name)}
                  style={[styles.chip, { backgroundColor: on ? theme.colors.accentWash : theme.colors.raised, borderColor: on ? theme.colors.accentLine : theme.colors.border, borderRadius: theme.radius.control }]}
                >
                  <Text style={{ color: theme.colors.text, textTransform: 'capitalize' }}>{name}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        <Section title="Accent">
          <View style={styles.rowWrap}>
            {ACCENTS.map((a) => (
              <Pressable
                key={a.label}
                onPress={() => setAccent(a.value)}
                style={[styles.chip, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.control }]}
              >
                <View style={[styles.swatch, { backgroundColor: a.value ?? theme.colors.accent }]} />
                <Text style={{ color: theme.colors.text }}>{a.label}</Text>
              </Pressable>
            ))}
          </View>
        </Section>

        <Section title="Model">
          <View style={{ gap: theme.spacing.sm }}>
            {models.length === 0 ? (
              <Text style={{ color: theme.colors.muted, fontSize: 13 }}>No models reported.</Text>
            ) : (
              models.map((m) => {
                const on = m.id === currentModel;
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => pickModel(m.id)}
                    style={[styles.row, { backgroundColor: on ? theme.colors.accentWash : theme.colors.raised, borderColor: on ? theme.colors.accentLine : theme.colors.border, borderRadius: theme.radius.card }]}
                  >
                    <Icon name="brain" size={18} color={on ? theme.colors.accent : theme.colors.text2} />
                    <View style={styles.rowBody}>
                      <Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: '500' }}>{m.label}</Text>
                      <Text style={{ color: theme.colors.muted, fontSize: 11, fontFamily: MONO }}>{m.id}</Text>
                    </View>
                    {on ? <Icon name="check-circle" size={18} color={theme.colors.accent} /> : null}
                  </Pressable>
                );
              })
            )}
          </View>
        </Section>

        <Section title="Connection">
          {/* Current state */}
          <View style={[styles.row, { backgroundColor: theme.colors.raised, borderColor: mode === 'remote' ? theme.colors.accentLine : theme.colors.border, borderRadius: theme.radius.card }]}>
            <Icon name="plug" size={18} color={mode === 'remote' ? theme.colors.accent : theme.colors.text2} />
            <View style={styles.rowBody}>
              <Text style={{ color: theme.colors.text, fontSize: 14, fontWeight: '500' }}>
                {mode === 'remote' ? 'Paired to a host' : 'Demo mode (mock data)'}
              </Text>
              <Text style={{ color: theme.colors.muted, fontSize: 11, fontFamily: MONO }} numberOfLines={1}>
                {mode === 'remote' ? (activeUrl ?? status) : 'no live host connected'}
              </Text>
            </View>
          </View>

          {/* Saved hosts — tap to connect / switch / reconnect; × to forget */}
          {hosts.map((h) => {
            const on = mode === 'remote' && h.url === activeUrl;
            return (
              <View key={h.url} style={[styles.hostRow, { backgroundColor: theme.colors.raised, borderColor: on ? theme.colors.accentLine : theme.colors.border, borderRadius: theme.radius.card }]}>
                <Pressable style={styles.hostMain} onPress={() => useConnectionStore.getState().connectTo(h.url)}>
                  <Icon name="plug" size={16} color={on ? theme.colors.accent : theme.colors.text2} />
                  <View style={styles.rowBody}>
                    <Text style={{ color: theme.colors.text, fontSize: 13, fontFamily: MONO }} numberOfLines={1}>{h.url}</Text>
                    <Text style={{ color: on ? theme.colors.accent : theme.colors.muted, fontSize: 11 }}>{on ? 'connected' : 'tap to connect'}</Text>
                  </View>
                </Pressable>
                <Pressable hitSlop={8} onPress={() => useConnectionStore.getState().forgetHost(h.url)} style={styles.forget}>
                  <Icon name="close" size={16} color={theme.colors.muted} />
                </Pressable>
              </View>
            );
          })}

          {/* Add a new host */}
          <Pressable
            accessibilityLabel="Add host"
            onPress={() => rootNav.navigate('Connect')}
            style={({ pressed }) => [styles.addHost, { backgroundColor: pressed ? theme.colors.accentPress : theme.colors.accent, borderRadius: theme.radius.card }]}
          >
            <Icon name="plus" size={18} color={theme.colors.accentText} />
            <Text style={{ color: theme.colors.accentText, fontWeight: '600', fontSize: 14 }}>Add host</Text>
          </Pressable>

          {mode === 'remote' ? (
            <Pressable
              onPress={() => useConnectionStore.getState().disconnect()}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.colors.overlay : theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}
            >
              <Icon name="close" size={16} color={theme.colors.danger} />
              <Text style={{ flex: 1, color: theme.colors.danger, fontSize: 14 }}>Disconnect (back to demo)</Text>
            </Pressable>
          ) : activeUrl ? (
            <Pressable
              onPress={() => useConnectionStore.getState().reconnect()}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.colors.overlay : theme.colors.raised, borderColor: theme.colors.accentLine, borderRadius: theme.radius.card }]}
            >
              <Icon name="plug" size={16} color={theme.colors.accent} />
              <Text style={{ flex: 1, color: theme.colors.accent, fontSize: 14 }}>Reconnect to last host</Text>
            </Pressable>
          ) : null}
        </Section>

        <Section title="About">
          <View style={[styles.row, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
            <Icon name="brain" size={18} color={theme.colors.text2} />
            <Text style={[styles.rowBody, { color: theme.colors.text, fontSize: 14 }]}>BrainRouter Mobile</Text>
            <Text style={{ color: theme.colors.muted, fontSize: 13, fontFamily: MONO }}>v0.4.15</Text>
          </View>
        </Section>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth },
  swatch: { width: 14, height: 14, borderRadius: 7 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  hostRow: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, paddingRight: 4 },
  hostMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  forget: { padding: 10 },
  addHost: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13 },
  rowBody: { flex: 1, minWidth: 0 },
});
