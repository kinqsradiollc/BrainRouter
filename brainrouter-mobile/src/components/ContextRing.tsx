/**
 * ContextRing — the small circular context-window gauge from the Session topbar
 * (prototype UF-03 `.ring`). An accent arc over a track ring with the percent in
 * the centre. Built on react-native-svg (RN can't do conic-gradient).
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '../theme/ThemeProvider';
import { MONO } from '../theme/fonts';

export function ContextRing({ pct, size = 30 }: { pct: number; size?: number }): React.JSX.Element {
  const theme = useTheme();
  const stroke = 3;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, pct));
  const arc = (clamped / 100) * circumference;

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size} style={styles.svg}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={theme.colors.overlay} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={theme.colors.accent}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={[arc, circumference]}
          strokeLinecap="round"
        />
      </Svg>
      <Text style={[styles.pct, { color: theme.colors.text2 }]}>{Math.round(clamped)}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  // rotate so the arc starts at 12 o'clock like the prototype's conic gradient
  svg: { position: 'absolute', transform: [{ rotate: '-90deg' }] },
  pct: { fontSize: 8.5, fontFamily: MONO },
});
