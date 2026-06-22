/**
 * SettingsScreen (S-14) — settings home. M0 wires the theme controls (dark/light
 * + runtime accent) to prove the ThemeProvider seam; the full settings surface
 * (models/providers S-16, appearance S-17, etc.) lands in M1.
 */
import React from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { Screen } from '../components/primitives/Screen';
import { useTheme, useThemeControls } from '../theme/ThemeProvider';
import { useConnectionStatus } from '../state/TransportProvider';

const ACCENTS: Array<{ label: string; value: string | undefined }> = [
  { label: 'Indigo (default)', value: undefined },
  { label: 'Green signal', value: '#34C28E' },
  { label: 'Warm orange', value: 'hsl(16, 65%, 58%)' },
];

export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const { themeName, setThemeName, setAccent } = useThemeControls();
  const status = useConnectionStatus();

  return (
    <Screen title="Settings" subtitle={`Connection: ${status}`}>
      <View style={{ gap: theme.spacing.lg }}>
        <View style={{ gap: theme.spacing.sm }}>
          <Text style={[styles.label, { color: theme.colors.text2 }]}>Appearance</Text>
          <View style={styles.rowWrap}>
            {(['dark', 'light'] as const).map((name) => (
              <Pressable
                key={name}
                onPress={() => setThemeName(name)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: themeName === name ? theme.colors.accentWash : theme.colors.raised,
                    borderColor: themeName === name ? theme.colors.accentLine : theme.colors.border,
                    borderRadius: theme.radius.control,
                  },
                ]}
              >
                <Text style={{ color: theme.colors.text }}>{name}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={{ gap: theme.spacing.sm }}>
          <Text style={[styles.label, { color: theme.colors.text2 }]}>Accent</Text>
          <View style={styles.rowWrap}>
            {ACCENTS.map((a) => (
              <Pressable
                key={a.label}
                onPress={() => setAccent(a.value)}
                style={[
                  styles.chip,
                  { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.control },
                ]}
              >
                <View style={[styles.swatch, { backgroundColor: a.value ?? theme.colors.accent }]} />
                <Text style={{ color: theme.colors.text }}>{a.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth },
  swatch: { width: 14, height: 14, borderRadius: 7 },
});
