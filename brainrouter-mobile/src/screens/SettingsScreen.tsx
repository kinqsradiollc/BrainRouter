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
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await transport.query<{ models: ModelInfo[]; current: string }>('list-models');
      if (!alive) return;
      setModels(res?.models ?? []);
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
          <View style={[styles.row, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
            <Icon name="plug" size={18} color={theme.colors.text2} />
            <Text style={[styles.rowBody, { color: theme.colors.text, fontSize: 14 }]}>Host</Text>
            <Text style={{ color: theme.colors.muted, fontSize: 13, fontFamily: MONO }}>{status}</Text>
          </View>
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
  rowBody: { flex: 1, minWidth: 0 },
});
