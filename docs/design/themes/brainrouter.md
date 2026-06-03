# BrainRouter — "The Memory Instrument"

> A calm, precise instrument for a living memory. Quiet surfaces, data in
> monospace, one confident signal of life — and a single ownable idea: **memory
> has temperature.** Recent recall runs warm; archival memory cools. Everything
> else gets out of the way.

BrainRouter's design language is calm, precise, and data-forward — built for a
developer memory platform you live in for hours. Near-monochrome surfaces, one
confident accent, and monospace for every datum. The interface recedes so the memory
graph, recall timelines, and provenance can speak.

**Mode:** dark-primary, with a first-class light mode. **Intent:** moderate
structural variance, restrained physical motion, high information density — lines
over boxes, numbers in monospace.

---

## Colors

Neutral, near-monochrome base. **Exactly one** UI accent ("Signal"). The "Recall
Heat" ramp is **functional data encoding** confined to the memory graph / timelines
(a heat legend, never chrome). No AI-purple, no neon, no ornamental gradients.

### Dark (primary)

| Name | Hex | Token | Role |
| :-- | :-- | :-- | :-- |
| Void | `#0B0D0F` | `--surface-base` | Page canvas (off-black, faint cool — never `#000`) |
| Substrate | `#14171A` | `--surface-raised` | Panels, cards, sidebar |
| Lifted | `#1E2227` | `--surface-overlay` | Popovers, menus, active rows |
| Filament | `rgba(255,255,255,0.08)` | `--border` | Hairline borders / dividers |
| Filament-Strong | `rgba(255,255,255,0.14)` | `--border-strong` | Focused/hover edges |
| Frost | `#ECEFF2` | `--text` | Primary text (near-white, not pure) |
| Mist | `#9BA3AC` | `--text-secondary` | Secondary text, labels |
| Ash | `#5E6670` | `--text-muted` | Metadata, disabled, placeholders |
| **Signal** | `#34C28E` | `--accent` | THE accent: primary action, active nav, focus, links, live |
| Signal-Press | `#28A87C` | `--accent-press` | `:active` / pressed |
| Signal-Wash | `rgba(52,194,142,0.14)` | `--accent-wash` | Active-row tint, selected-node halo |

### Recall Heat (graph + timeline data only — a legend, not UI chrome)

| Name | Hex | Token | Meaning |
| :-- | :-- | :-- | :-- |
| Ember | `#E0A063` | `--heat-hot` | Hot — recalled now / just reinforced |
| Coal | `#C98F6E` | `--heat-warm` | Warm — recently active |
| Slate | `#6B7480` | `--heat-cool` | Cool — dormant |
| Cinder | `#3C434B` | `--heat-cold` | Cold — archival / decayed (down-ranked) |

### Semantic

| Name | Hex | Token | Role |
| :-- | :-- | :-- | :-- |
| Rose | `#E5675F` | `--danger` | Contradiction, destructive, error (desaturated) |
| Amber | `#D9A441` | `--warn` | Stale-vs-code warning, caution |
| Signal | `#34C28E` | `--ok` | Success / confirmed (reuses the accent) |

### Light (mirror)

`--surface-base #FAFAFA` · `--surface-raised #FFFFFF` · `--surface-overlay #F3F4F6`
· `--border rgba(16,19,22,0.10)` · `--text #16191C` · `--text-secondary #4B535B` ·
`--text-muted #8A929B` · `--accent #1E9E73` (Signal, darkened for AA on white). Heat
ramp keeps the same hues at slightly higher contrast.

---

## Typography

**No Inter. No serif** (this is a dashboard). One sans + one mono, self-hosted (no
CDN). All **data** — numbers, IDs, hashes, timestamps, provenance, token counts,
file:line — is monospace; prose and labels are sans.

- **Sans — Geist** (self-hosted via `next/font/local` or the `geist` pkg): weights 400 / 500 / 600. UI, headings, prose.
- **Mono — Geist Mono**: weights 400 / 500. Data, code, provenance, the entire memory-graph metadata layer.

| Role | Family | Size / Line | Weight | Tracking |
| :-- | :-- | :-- | :-- | :-- |
| Display | Geist | 44 / 52 | 600 | -0.02em |
| H1 | Geist | 28 / 34 | 600 | -0.015em |
| H2 | Geist | 20 / 28 | 600 | -0.01em |
| H3 / Section | Geist | 16 / 24 | 500 | -0.005em |
| Body | Geist | 14 / 21 | 400 | 0 |
| Label / Eyebrow | Geist Mono | 12 / 16 | 500 | 0.04em · UPPERCASE |
| Data / Metric | Geist Mono | 13 / 18 | 500 | -0.01em |
| Code | Geist Mono | 13 / 20 | 400 | 0 |

Headlines don't scream — hierarchy comes from weight + color, not 90px type
(taste-skill). Eyebrow labels (uppercase mono) mark sections and provenance.

---

## Spacing, Shape & Elevation

- **Base unit:** 4px. Scale: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`.
- **Density:** data-forward. Prefer `divide-y` / `border-t` grouping over boxed
  cards; box only when elevation is functional. Numbers always mono.
- **Radius:** chip `4px` · control/input `6px` · card/panel `10px` · large panel
  `12px` · pill `9999px` (status dots & toggles ONLY). Architectural, not bloated —
  no 28px-everywhere.

| Token | Value | Use |
| :-- | :-- | :-- |
| `--radius-chip` | 4px | badges, tags, kbd |
| `--radius-control` | 6px | buttons, inputs, selects |
| `--radius-card` | 10px | cards, panels, nodes |
| `--radius-panel` | 12px | large containers, modals |

**Elevation = color-steps + a *subtle neutral* depth shadow — never a coloured
glow.** Base → raised → overlay climb by lightness, and a soft neutral drop adds the
real depth that keeps surfaces from reading flat/dated (flatness is what reads
"old"). Pressable surfaces (buttons, nodes) also get a 1px inner top-highlight to
feel tactile; borders stay hairline-tinted. The hard rule remains: **no *accent*
glow, no neon halo** — depth shadows are neutral black only.

```
--elev-inset:  inset 0 1px 0 rgba(255,255,255,0.05);                                  /* pressable top highlight */
--shadow-sm:   0 1px 2px rgba(0,0,0,0.35), 0 1px 1px rgba(0,0,0,0.22);                 /* resting cards */
--shadow-md:   0 6px 16px -6px rgba(0,0,0,0.5), 0 2px 6px -2px rgba(0,0,0,0.32);       /* hover / raised */
--shadow-lg:   0 24px 60px -20px rgba(0,0,0,0.62), 0 8px 20px -8px rgba(0,0,0,0.4);    /* popovers, modals, hero panel */
```

---

## Motion

Restrained and physical (MOTION_INTENSITY 4). Animate **transform + opacity only**.

- **Transition:** `180ms cubic-bezier(0.2, 0.8, 0.2, 1)` for hover/state.
- **Spring** (Framer, interactive): `stiffness 100, damping 20` — no linear easing.
- **Tactile `:active`:** `scale(0.98)` or `translateY(0.5px)`.
- **Lists/grids:** staggered reveal (`animation-delay: calc(var(--i) * 40ms)`), not instant mount.
- **The one signature loop:** a "live" status dot **breathes** (opacity 0.5↔1, 2.4s) on Signal; a node being recalled pulses its heat once. No perpetual parallax, no marquees, no mesh-gradient lava.

---

## Components

**Buttons** — Primary: `--accent` bg, `#06140E` text, `--radius-control`, `--elev-inset`, `:active scale .98`. Secondary: transparent + `--border-strong`, Frost text. Ghost: text-only, hover `--surface-overlay`. Destructive: `--danger`. No gradients.

**Input / Select** — `--surface-base` inset on raised panels, `--border` → `--accent` on focus with a 2px `--accent-wash` ring (no glow). Label above (mono eyebrow), helper/error below. Mono for any ID/numeric field.

**Card / Panel** — `--surface-raised`, `--border`, `--radius-card`, no shadow. Header = H3 + mono eyebrow. Use sparingly; prefer `divide-y` sections inside one panel.

**Memory Node** *(graph centerpiece)* — a pressable `--radius-card` surface filled by its **Recall Heat** (Ember→Cinder = freshness/decay), `--elev-inset` top-highlight, label in Geist, provenance in Geist Mono. **Type is encoded by border style, not hue:** solid = fact, dashed = inferred, dotted = uncertain/low-confidence. Selected = `--accent` ring + `--accent-wash` halo. Stale-vs-code = `--warn` hairline + a mono `STALE` tag.

**Edge** — 1px line; **opacity + weight encode association strength**; an actively-traversed recall path animates a single `--accent` dash flow (one pass, not perpetual). Dormant edges sit near `--heat-cold`.

**Recall Timeline** — horizontal lane of mono timestamps with heat dots; the lane is `divide-x` ticks, not boxes. Hovering a moment lifts it (`translateY`) and warms its dot.

**Scene / Context strip** — a labelled band (mono eyebrow = scene id) that gives its nodes a faint shared tint (a 4% wash, NOT a radial glow) so context reads as belonging, calmly.

**Provenance chip** — Geist Mono, `--radius-chip`, `--surface-overlay`, `--text-muted`: `source · ts · conf 0.82`. The "system readout" layer.

**Status dot** — 8px pill; Signal = live/breathing, Slate = idle, Rose = error, Amber = stale.

**Stat / Metric readout** — mono number (large, `--text`), mono unit/delta (`--text-muted`), separated by `border-t` rules — no metric boxes (VISUAL_DENSITY ≥ 6).

**Table** — `divide-y` rows, mono data columns, hover row = `--accent-wash`; no zebra, no card wrapper. Sticky header in `--surface-raised`.

**Sidebar nav** — `--surface-raised`; active item = 2px `--accent` left-rule + `--accent-wash` fill + Frost text. (Replaces the old golden-gradient pill.) Icons: Phosphor, `strokeWidth 1.5`.

**States (mandatory)** — Skeleton loaders matched to layout (shimmer via `--surface-overlay`, not spinners); composed empty states (mono hint + one Signal action); inline error in `--danger`.

---

## Do & Don't

**Do**
1. Keep the canvas near-monochrome; let **Signal** (`#34C28E`) be the only chromatic UI pull.
2. Render every datum (IDs, counts, timestamps, hashes, confidence, file:line) in **Geist Mono**.
3. Use **Recall Heat** only inside the graph/timeline as a freshness legend — with a visible legend key.
4. Build elevation from **color steps + 1px inner top-highlight**; tint borders to the surface.
5. Encode node **type via border style**, not extra colors.
6. Group with `divide-y` / `border-t`; box only when elevation is functional.
7. Self-host Geist + Geist Mono; preload; no Google-Fonts CDN.
8. Animate transform/opacity; spring physics; tactile `:active`.
9. Ship skeleton / empty / error states for every data view.
10. Phosphor icons at a single `strokeWidth` (1.5); never emojis.

**Don't**
1. **No AI-purple/indigo/violet, no neon, no outer-glow `box-shadow`.**
2. **No Inter, no serif** — they read generic and off-identity for this product.
3. **No metallic or ornamental gradients** — no gradient fills on surfaces, buttons, or text.
4. No pure `#000` / pure `#fff` — use Void / Frost.
5. No ornamental gradients on surfaces, buttons, or text.
6. No drop-shadow "floating cards"; no 3-equal-card feature rows.
7. No second accent — Heat is data, Semantic is state; neither is a brand hue.
8. No 90px hero type; control hierarchy with weight + color.
9. No animating `width/height/top/left`; no perpetual parallax/marquee.
10. No generic spinners or "egg" avatars; no `99.99%`-style fake data.

---

## Imagery & Layout

- **Imagery:** none decorative. The product *is* the picture — the memory graph,
  timelines, and readouts. At most one abstract node-field motif on the marketing
  hero (generated, not stock; never Unsplash).
- **Layout:** app shell = fixed left sidebar (nav) + top context bar + content.
  Content max-width `1400px`, `mx-auto`, `px-4` mobile collapse to single column.
  Graph views go full-bleed. CSS Grid for multi-column (`grid-cols-*`), never flex
  percentage math. Full-height uses `min-h-[100dvh]` (never `h-screen`).

---

## Agent Prompt Guide

Quick palette: canvas `#0B0D0F`, panel `#14171A`, text `#ECEFF2`, accent **Signal
`#34C28E`**, heat ramp `#E0A063 → #6B7480 → #3C434B`. Fonts **Geist** + **Geist
Mono**. Radius 6/10/12. Elevation = color steps + `inset 0 1px 0 rgba(255,255,255,0.05)`.

Examples:
- *"A memory node: 10px-radius `#14171A` surface, fill tinted toward `#E0A063` when hot; dashed `--border` = inferred; provenance row in Geist Mono `#5E6670`; selected → 2px `#34C28E` ring + `rgba(52,194,142,0.14)` halo; `:active scale .98`."*
- *"Recall timeline: horizontal `divide-x` tick lane, mono timestamps, heat-colored dots; hover lifts the moment 0.5px and warms its dot; no card box."*
- *"Sidebar nav item, active: 2px `#34C28E` left rule + `rgba(52,194,142,0.14)` fill, Frost text, Phosphor icon strokeWidth 1.5. No gradient."*
- *"Metric readout: large Geist Mono number `#ECEFF2`, delta in `#5E6670`, separated by `border-t` — no box."*

---

## Quick Start (tokens)

```css
:root {
  /* dark (primary) */
  --surface-base:#0B0D0F; --surface-raised:#14171A; --surface-overlay:#1E2227;
  --border:rgba(255,255,255,0.08); --border-strong:rgba(255,255,255,0.14);
  --text:#ECEFF2; --text-secondary:#9BA3AC; --text-muted:#5E6670;
  --accent:#34C28E; --accent-press:#28A87C; --accent-wash:rgba(52,194,142,0.14);
  --heat-hot:#E0A063; --heat-warm:#C98F6E; --heat-cool:#6B7480; --heat-cold:#3C434B;
  --danger:#E5675F; --warn:#D9A441;
  --font-sans:"Geist",ui-sans-serif,system-ui,sans-serif;
  --font-mono:"Geist Mono",ui-monospace,SFMono-Regular,monospace;
  --radius-chip:4px; --radius-control:6px; --radius-card:10px; --radius-panel:12px;
  --elev-inset:inset 0 1px 0 rgba(255,255,255,0.05);
  --ease:cubic-bezier(0.2,0.8,0.2,1);
}
:root[data-theme="light"] {
  --surface-base:#FAFAFA; --surface-raised:#FFFFFF; --surface-overlay:#F3F4F6;
  --border:rgba(16,19,22,0.10); --border-strong:rgba(16,19,22,0.18);
  --text:#16191C; --text-secondary:#4B535B; --text-muted:#8A929B;
  --accent:#1E9E73; --accent-wash:rgba(30,158,115,0.12);
  --elev-inset:inset 0 1px 0 rgba(255,255,255,0.6);
}
```

```css
/* Tailwind v4 — @theme (CSS-first; no tailwind.config.js needed) */
@theme {
  --color-base: var(--surface-base);
  --color-raised: var(--surface-raised);
  --color-overlay: var(--surface-overlay);
  --color-accent: var(--accent);
  --color-heat-hot: var(--heat-hot);
  --color-heat-cold: var(--heat-cold);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --radius-card: var(--radius-card);
}
```
