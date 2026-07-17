# BrainRouter — Expo / React Native Implementation Guide

Companion to [Design.md](Design.md) and the canonical design language [themes/brainrouter.md](themes/brainrouter.md) — **"The Memory Instrument."** This file translates that framework-neutral spec into paste-ready Expo / React Native code: a design-token module, themed components, navigation, and Reanimated motion. **When building the BrainRouter mobile app, this is the source of truth for styling** — it supersedes any ad-hoc styling in the planning prototypes.

Assumes **Expo SDK 51+** with `expo-router`, `expo-font`, `react-native-reanimated` v3, `react-native-svg`, `expo-haptics`, and `phosphor-react-native`.

> **The one ownable idea:** *memory has temperature.* Recent recall runs warm, archival memory cools. Everything else gets out of the way. Calm near-monochrome surfaces, **exactly one** chromatic accent (**Signal `#34C28E`**), and **monospace for every datum**.
>
> **Non-negotiables** (from the spec's Don't list): **no AI-purple/indigo/violet, no neon, no outer-glow shadows; no Inter, no serif; no emojis** (Phosphor icons only); **no pure `#000`/`#fff`**. Render every datum (IDs, counts, timestamps, hashes, confidence, `file:line`) in **Geist Mono**.

---

## 1. Color Tokens

Near-monochrome base, one accent ("Signal"). The **Recall Heat** ramp is *functional data encoding* — use it only inside the memory graph / recall timelines (as a legend), never as UI chrome.

```ts
// theme/colors.ts
export const dark = {
  // surfaces (climb by lightness — elevation is color-steps, not glow)
  base:    '#0B0D0F',                 // Void    — page canvas (never #000)
  raised:  '#14171A',                 // Substrate — panels, cards, tab bar
  overlay: '#1E2227',                 // Lifted  — sheets, menus, active rows

  // hairline borders (tinted to the surface)
  border:       'rgba(255,255,255,0.08)', // Filament
  borderStrong: 'rgba(255,255,255,0.14)', // Filament-Strong (focus/hover)

  // text (never pure white)
  text:          '#ECEFF2',           // Frost — primary
  textSecondary: '#9BA3AC',           // Mist  — labels, secondary
  textMuted:     '#5E6670',           // Ash   — metadata, placeholders, disabled

  // Signal — THE single chromatic pull (action, active nav, focus, links, live)
  accent:      '#34C28E',
  accentPress: '#28A87C',
  accentWash:  'rgba(52,194,142,0.14)', // active-row tint, selected halo
  accentText:  '#06140E',               // text/icon on a Signal fill

  // Recall Heat — DATA ONLY (graph + timeline). Never buttons/nav/chrome.
  heatHot:  '#E0A063',  // Ember  — recalled now / just reinforced
  heatWarm: '#C98F6E',  // Coal   — recently active
  heatCool: '#6B7480',  // Slate  — dormant
  heatCold: '#3C434B',  // Cinder — archival / decayed

  // semantic state (not brand hues)
  danger: '#E5675F',    // Rose  — contradiction, destructive, error
  warn:   '#D9A441',    // Amber — stale-vs-code, caution
  ok:     '#34C28E',    // Signal reused — success / confirmed
} as const;

export const light = {
  base:'#FAFAFA', raised:'#FFFFFF', overlay:'#F3F4F6',
  border:'rgba(16,19,22,0.10)', borderStrong:'rgba(16,19,22,0.18)',
  text:'#16191C', textSecondary:'#4B535B', textMuted:'#8A929B',
  accent:'#1E9E73', accentPress:'#17855F', accentWash:'rgba(30,158,115,0.12)', accentText:'#FFFFFF',
  heatHot:'#E0A063', heatWarm:'#C98F6E', heatCool:'#6B7480', heatCold:'#3C434B',
  danger:'#D2554D', warn:'#B9892F', ok:'#1E9E73',
} as const;

export type Palette = typeof dark;
export type ColorToken = keyof Palette;

// Dark is primary. Wire `light` through a ThemeProvider/context when you add the toggle.
export const c = dark;
```

**Elevation** = color step **+ a neutral depth shadow + a 1px inner top-highlight** — never a coloured glow. RN has no `inset` box-shadow, so emulate the top-highlight with a hairline top border on pressables.

```ts
// theme/elevation.ts  (iOS shadow*/ Android elevation)
import { Platform } from 'react-native';
export const elevation = {
  sm: Platform.select({
    ios: { shadowColor:'#000', shadowOpacity:0.35, shadowRadius:2, shadowOffset:{width:0,height:1} },
    android: { elevation: 2 },
  }),
  lg: Platform.select({           // sheets, modals
    ios: { shadowColor:'#000', shadowOpacity:0.5, shadowRadius:24, shadowOffset:{width:0,height:12} },
    android: { elevation: 16 },
  }),
} as const;
export const insetTop = { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.05)' }; // pressable highlight
```

---

## 2. Typography

**No Inter, no serif.** One sans (**Geist**) + one mono (**Geist Mono**), self-hosted (no CDN). **All data** — numbers, IDs, hashes, timestamps, provenance, token counts, `file:line` — is **Geist Mono**; prose and labels are Geist. Hierarchy comes from **weight + color**, not 90px type.

```tsx
// app/_layout.tsx — load self-hosted Geist (put .ttf files in assets/fonts/)
import { useFonts } from 'expo-font';

export default function Root() {
  const [loaded] = useFonts({
    'Geist-Regular':  require('../assets/fonts/Geist-Regular.ttf'),
    'Geist-Medium':   require('../assets/fonts/Geist-Medium.ttf'),
    'Geist-SemiBold': require('../assets/fonts/Geist-SemiBold.ttf'),
    'GeistMono-Regular': require('../assets/fonts/GeistMono-Regular.ttf'),
    'GeistMono-Medium':  require('../assets/fonts/GeistMono-Medium.ttf'),
  });
  if (!loaded) return null;
  return <Stack />;
}
```

```ts
// theme/typography.ts
import type { TextStyle } from 'react-native';
import { c } from './colors';

// letterSpacing is in points (RN), converted from the spec's em at each size.
export const typography = {
  display:  { color:c.text, fontFamily:'Geist-SemiBold', fontSize:44, lineHeight:52, letterSpacing:-0.88 },
  h1:       { color:c.text, fontFamily:'Geist-SemiBold', fontSize:28, lineHeight:34, letterSpacing:-0.42 },
  h2:       { color:c.text, fontFamily:'Geist-SemiBold', fontSize:20, lineHeight:28, letterSpacing:-0.20 },
  section:  { color:c.text, fontFamily:'Geist-Medium',   fontSize:16, lineHeight:24, letterSpacing:-0.08 },
  body:     { color:c.text, fontFamily:'Geist-Regular',  fontSize:14, lineHeight:21 },
  // mono family — DATA. Eyebrows are uppercase mono and mark sections/provenance.
  eyebrow:  { color:c.textSecondary, fontFamily:'GeistMono-Medium', fontSize:12, lineHeight:16, letterSpacing:0.48, textTransform:'uppercase' as const },
  data:     { color:c.text,          fontFamily:'GeistMono-Medium', fontSize:13, lineHeight:18, letterSpacing:-0.13, fontVariant:['tabular-nums'] as const },
  code:     { color:c.textSecondary, fontFamily:'GeistMono-Regular',fontSize:13, lineHeight:20 },
  button:   { color:c.accentText,    fontFamily:'Geist-SemiBold',   fontSize:14, lineHeight:14, letterSpacing:-0.1 },
} satisfies Record<string, TextStyle>;
```

> Rule of thumb: if it's a **datum**, it's `typography.data`/`code` (mono, `tabular-nums`). If it's **prose or a label**, it's Geist.

---

## 3. Signature Components

### Status Dot — the one signature loop (a "live" dot *breathes*)

The single ambient animation in the whole app: a Signal dot breathing opacity 0.5↔1 over 2.4s. Idle = Slate, error = Rose, stale = Amber (static).

```tsx
// components/StatusDot.tsx
import { useEffect } from 'react';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from 'react-native-reanimated';
import { c } from '../theme/colors';

type State = 'live' | 'idle' | 'error' | 'stale';
const fill: Record<State, string> = { live:c.accent, idle:c.heatCool, error:c.danger, stale:c.warn };

export function StatusDot({ state = 'idle', size = 8 }: { state?: State; size?: number }) {
  const o = useSharedValue(1);
  useEffect(() => {
    if (state === 'live') o.value = withRepeat(withTiming(0.5, { duration: 1200, easing: Easing.inOut(Easing.ease) }), -1, true);
    else o.value = 1;
  }, [state]);
  const style = useAnimatedStyle(() => ({ opacity: state === 'live' ? o.value : 1 }));
  return <Animated.View style={[{ width:size, height:size, borderRadius:size/2, backgroundColor:fill[state] }, style]} />;
}
```

### Primary Button — Signal fill, tactile, haptic

```tsx
// components/Button.tsx
import { Pressable, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import { c } from '../theme/colors';
import { typography } from '../theme/typography';
import { insetTop } from '../theme/elevation';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ title, onPress, variant='primary' }: { title:string; onPress:()=>void; variant?:Variant }) {
  return (
    <Pressable
      onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onPress(); }}
      style={({ pressed }) => [{
        height:44, paddingHorizontal:16, borderRadius:6,           // --radius-control
        alignItems:'center', justifyContent:'center', flexDirection:'row',
        transform:[{ scale: pressed ? 0.98 : 1 }],                 // tactile :active
        ...(variant === 'primary' && { backgroundColor: pressed ? c.accentPress : c.accent, ...insetTop }),
        ...(variant === 'secondary' && { borderWidth:1, borderColor:c.borderStrong, backgroundColor:'transparent' }),
        ...(variant === 'ghost' && { backgroundColor: pressed ? c.overlay : 'transparent' }),
        ...(variant === 'danger' && { borderWidth:1, borderColor:c.danger, backgroundColor:'transparent' }),
      }]}
    >
      <Text style={[typography.button,
        variant==='primary' ? { color:c.accentText } :
        variant==='danger' ? { color:c.danger } : { color:c.text }]}>
        {title}
      </Text>
    </Pressable>
  );
}
```

### Provenance Chip — the "system readout" layer (mono)

```tsx
// components/ProvenanceChip.tsx
import { View, Text } from 'react-native';
import { c } from '../theme/colors';
import { typography } from '../theme/typography';

export function ProvenanceChip({ source, ts, conf }: { source:string; ts:string; conf:number }) {
  return (
    <View style={{ flexDirection:'row', alignItems:'center', alignSelf:'flex-start',
      backgroundColor:c.overlay, borderRadius:4, paddingHorizontal:8, paddingVertical:3 }}>
      <Text style={[typography.code, { color:c.textMuted }]}>
        {source} · {ts} · conf {conf.toFixed(2)}
      </Text>
    </View>
  );
}
```

### Metric Readout — mono number, separated by a rule (no metric box)

```tsx
// components/Metric.tsx
import { View, Text } from 'react-native';
import { c } from '../theme/colors';
import { typography } from '../theme/typography';

export function Metric({ label, value, delta }: { label:string; value:string; delta?:string }) {
  return (
    <View style={{ paddingVertical:12, borderTopWidth:1, borderTopColor:c.border, gap:2 }}>
      <Text style={typography.eyebrow}>{label}</Text>
      <View style={{ flexDirection:'row', alignItems:'baseline', gap:8 }}>
        <Text style={[typography.data, { fontSize:22, lineHeight:26 }]}>{value}</Text>
        {delta ? <Text style={[typography.data, { color:c.textMuted }]}>{delta}</Text> : null}
      </View>
    </View>
  );
}
```

### Memory Node — graph centerpiece (heat fill; *type = border style*)

The freshness ramp fills the node (Ember→Cinder); **node type is encoded by border style, not hue** (solid = fact, dashed = inferred, dotted = uncertain). Selected = Signal ring + wash halo.

```tsx
// components/MemoryNode.tsx
import { Pressable, View, Text } from 'react-native';
import { c } from '../theme/colors';
import { typography } from '../theme/typography';
import { insetTop } from '../theme/elevation';

type Heat = 'hot' | 'warm' | 'cool' | 'cold';
type Kind = 'fact' | 'inferred' | 'uncertain';
const heat = { hot:c.heatHot, warm:c.heatWarm, cool:c.heatCool, cold:c.heatCold };
const borderStyle = { fact:'solid', inferred:'dashed', uncertain:'dotted' } as const;

export function MemoryNode({ label, prov, heat:h='cool', kind='fact', selected, onPress }:{
  label:string; prov:string; heat?:Heat; kind?:Kind; selected?:boolean; onPress:()=>void;
}) {
  return (
    <Pressable onPress={onPress} style={({pressed}) => [{
      borderRadius:10, padding:12, gap:6, ...insetTop,
      backgroundColor:c.raised,
      borderWidth:1.5, borderStyle:borderStyle[kind],
      borderColor: selected ? c.accent : c.border,
      transform:[{ scale: pressed ? 0.98 : 1 }],
      ...(selected && { backgroundColor:c.accentWash }),
    }]}>
      {/* heat bar communicates freshness without coloring chrome */}
      <View style={{ height:3, borderRadius:2, backgroundColor:heat[h], width:48 }} />
      <Text style={typography.section} numberOfLines={1}>{label}</Text>
      <Text style={[typography.code, { color:c.textMuted }]}>{prov}</Text>
    </Pressable>
  );
}
```

### Recall-Heat legend (always show the key when heat is on screen)

```tsx
// components/HeatLegend.tsx
import { View, Text } from 'react-native';
import { c } from '../theme/colors';
import { typography } from '../theme/typography';

const steps = [['Hot',c.heatHot],['Warm',c.heatWarm],['Cool',c.heatCool],['Cold',c.heatCold]] as const;
export function HeatLegend() {
  return (
    <View style={{ flexDirection:'row', gap:14 }}>
      {steps.map(([k,col]) => (
        <View key={k} style={{ flexDirection:'row', alignItems:'center', gap:5 }}>
          <View style={{ width:8, height:8, borderRadius:4, backgroundColor:col }} />
          <Text style={typography.eyebrow}>{k}</Text>
        </View>
      ))}
    </View>
  );
}
```

### Panel + divide-y rows (prefer grouping over boxed cards)

```tsx
// components/Panel.tsx
import { View, Text } from 'react-native';
import { c } from '../theme/colors';
import { typography } from '../theme/typography';

export function Panel({ title, children }: { title:string; children:React.ReactNode }) {
  return (
    <View style={{ backgroundColor:c.raised, borderWidth:1, borderColor:c.border, borderRadius:10 }}>
      <View style={{ padding:12 }}><Text style={typography.eyebrow}>{title}</Text></View>
      {children /* rows below add borderTopWidth:1 / c.border for divide-y */}
    </View>
  );
}
export function Row({ children }: { children:React.ReactNode }) {
  return <View style={{ paddingHorizontal:12, paddingVertical:10, borderTopWidth:1, borderTopColor:c.border, flexDirection:'row', alignItems:'center', gap:10, minHeight:44 }}>{children}</View>;
}
```

### Tool Card (mobile app, in-language) — data in mono

Maps the agent transcript's tool calls (see [../../brainrouter-mobile/docs/ui-spec.md](../../brainrouter-mobile/docs/ui-spec.md)) into the Memory-Instrument language: Phosphor glyph, sans name, **mono** target/`file:line`, StatusDot for ok/fail.

```tsx
// components/ToolCard.tsx
import { View, Text } from 'react-native';
import { Wrench } from 'phosphor-react-native';
import { c } from '../theme/colors';
import { typography } from '../theme/typography';
import { StatusDot } from './StatusDot';

export function ToolCard({ name, target, ok }: { name:string; target:string; ok:boolean }) {
  return (
    <View style={{ flexDirection:'row', gap:10, alignItems:'flex-start',
      backgroundColor:c.raised, borderWidth:1, borderColor:c.border, borderRadius:10, padding:11 }}>
      <Wrench size={18} color={c.textSecondary} weight="regular" />
      <View style={{ flex:1, gap:2 }}>
        <Text style={typography.section}>{name}</Text>
        <Text style={typography.code} numberOfLines={1}>{target}</Text>
      </View>
      <StatusDot state={ok ? 'idle' : 'error'} />
    </View>
  );
}
```

---

## 4. Navigation (bottom tabs — the mobile adaptation of the desktop sidebar)

The desktop design uses a **left sidebar** (active item = 2px Signal left-rule + wash). On a phone we adapt that to a **bottom tab bar** for thumb-reach (documented in [../../brainrouter-mobile/docs/ux-enhancements.md](../../brainrouter-mobile/docs/ux-enhancements.md) §1) — styled in the same language: Substrate bar, **Signal** active tint, Phosphor icons at one weight. (For a tablet/large layout, mirror the desktop with `expo-router/drawer` instead.)

```tsx
// app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import { ChatCircle, Pulse, ShieldCheck, GearSix } from 'phosphor-react-native';
import { c } from '../../theme/colors';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.base },
        headerTintColor: c.text,
        sceneContainerStyle: { backgroundColor: c.base },
        tabBarStyle: { backgroundColor: c.raised, borderTopColor: c.border, borderTopWidth: 1 },
        tabBarActiveTintColor: c.accent,        // Signal
        tabBarInactiveTintColor: c.textMuted,
        tabBarLabelStyle: { fontFamily: 'Geist-Medium', fontSize: 11 },
      }}
    >
      <Tabs.Screen name="chats"    options={{ title:'Chats',    tabBarIcon:({color})=><ChatCircle  size={22} color={color} weight="regular" /> }} />
      <Tabs.Screen name="activity" options={{ title:'Activity', tabBarIcon:({color})=><Pulse       size={22} color={color} weight="regular" /> }} />
      <Tabs.Screen name="review"   options={{ title:'Review',   tabBarIcon:({color})=><ShieldCheck size={22} color={color} weight="regular" /> }} />
      <Tabs.Screen name="settings" options={{ title:'Settings', tabBarIcon:({color})=><GearSix     size={22} color={color} weight="regular" /> }} />
    </Tabs>
  );
}
```

---

## 5. Motion (Reanimated)

Restrained and physical. **Animate transform + opacity only** — never width/height/top/left. No perpetual parallax/marquee. Haptic on commit / approval / status change.

```tsx
import Animated, { FadeIn, LinearTransition, withRepeat, withTiming, Easing } from 'react-native-reanimated';

// State/hover transition: 180ms cubic-bezier(0.2,0.8,0.2,1)
const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);
withTiming(target, { duration: 180, easing: EASE });

// Interactive spring (sheets, selection): stiffness 100, damping 20
// withSpring(target, { stiffness: 100, damping: 20 })

// Sheet / overlay enter: opacity + slight scale (no glow)
<Animated.View entering={FadeIn.duration(180)} />

// List/group reveal: stagger 40ms per item (entering={FadeIn.delay(i*40)})
// Group collapse: layout spring
<Animated.View layout={LinearTransition.springify().damping(18)} />

// The one signature loop: the "live" StatusDot breathes (see §3). A node being
// recalled pulses its heat ONCE (one pass), never perpetually.

// Tactile :active everywhere = transform scale(0.98) (handled in Pressable style).
```

```tsx
import * as Haptics from 'expo-haptics';
Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);          // approve / commit / execute
Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); // tool failure / contradiction
```

---

## 6. Icon Library

**Phosphor only** (`phosphor-react-native`), one weight (`regular` ≈ strokeWidth 1.5). **Never emojis.** Custom data glyphs (status dot, heat bar) are hand-built (see §3).

| Purpose | Phosphor (`phosphor-react-native`) |
|---|---|
| Chats / sessions | `ChatCircle` |
| Activity / live tasks | `Pulse` |
| Review / approvals | `ShieldCheck` |
| Settings | `GearSix` |
| Send | `PaperPlaneTilt` |
| Stop / interrupt | `Stop` |
| Tool call | `Wrench` |
| Plan | `ListChecks` |
| Diff / changes | `GitDiff` |
| Memory / recall | `Brain` |
| Provenance / source | `Path` |
| Search | `MagnifyingGlass` |
| Attach | `Paperclip` |
| Model / effort | `SlidersHorizontal` |
| Connection / host | `WifiHigh` |
| More | `DotsThree` |

```tsx
import { PaperPlaneTilt } from 'phosphor-react-native';
import { c } from '../theme/colors';
<PaperPlaneTilt size={20} color={c.accent} weight="regular" />
```

---

## 7. Platform Notes

- **Dark-primary**: default to the dark palette; wire `light` through a ThemeProvider when you add the toggle. Never pure `#000`/`#fff` — use **Void** `#0B0D0F` / **Frost** `#ECEFF2`.
- **Status bar**: `<StatusBar style="light" />` from `expo-status-bar` — the Void canvas needs light content.
- **Safe area**: wrap screens in `SafeAreaView` from `react-native-safe-area-context`; the transcript list and composer must clear the home indicator; the bottom tab bar sits above the inset.
- **Tabular numerics**: every datum uses `typography.data`/`code` with `fontVariant:['tabular-nums']` so token counts, timestamps, and `file:line` columns never jitter.
- **Mono for data, sans for prose** — the single most identity-defining rule. IDs, hashes, counts, timestamps, confidence, `file:line` → **Geist Mono**.
- **Recall Heat is data, not chrome** — only inside the graph/timeline, and always with a visible `HeatLegend`. Buttons/nav/state never use heat hues.
- **Elevation** = color step + neutral depth shadow + 1px top-highlight (`insetTop`). **No accent glow, no neon halo.**
- **No emojis** anywhere — Phosphor glyphs or custom SVG only.
- **Self-host Geist + Geist Mono** (bundle the `.ttf`s in `assets/fonts/`); no Google-Fonts/CDN.
- **Dynamic Type**: allow font scaling on titles/body; set `allowFontScaling={false}` on the StatusDot/heat labels and fixed-width mono columns where layout is rigid.
- **Accessibility**: group rows with `accessibilityRole="button"` + a combined label; mark decorative heat bars/dots as `accessibilityElementsHidden`. Signal (`#34C28E`) on Void passes AA for non-text UI; for small text on Signal use `accentText` `#06140E`.
- **Every data view ships skeleton / empty / error states** — shimmer skeletons matched to layout (not spinners), composed empty states (mono hint + one Signal action), inline errors in `--danger`.

---

*Derived from [themes/brainrouter.md](themes/brainrouter.md). For the mobile app's screens, flows, and architecture, see [../../brainrouter-mobile/docs/](../../brainrouter-mobile/docs/).*
