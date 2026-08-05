# 0.4.19 research — reference desktop theme + product architecture

Working notes for ADR-027. Reference project studied read-only; NOTHING here may
be named in committed code/docs (golden rule 2) — ship BrainRouter-native.

## THEME — the exact system to replicate

**Pipeline:** Tailwind **v4 CSS-first** (no tailwind.config.js). Four files:
entry css (tokens/variants/utilities/keyframes) → a full **Radix Colors** palette
inlined as raw CSS vars (light hex / dark hex / display-p3 blocks) → an
`@theme inline` bridge mapping `--<family>-<step>` → `--color-<family>-<step>` so
`bg-slate-3`, `text-amber-11`, `border-green-a6` all exist → shadcn config.
A `@source inline(...)` safelist force-generates all 31 families × 12 steps
because accent classes are built dynamically.

**Primitives:** shadcn/ui built on **Base UI** (`@base-ui/react`), NOT Radix
primitives. 43 UI files. Icons: **lucide**.

### Token layers (4)
1. **Radix palette** — 31 families × steps 1–12 + a1–a12 alpha.
   Slate is the neutral spine: light `#fcfcfd → #1c2024`, dark `#111113 → #edeef0`.
2. **Product tokens** (`--dls-*`): surface=slate-1, sidebar=slate-2,
   canvas=slate-2, surface-muted=slate-3, text-primary=slate-12,
   text-secondary=slate-11, hover=slate-3, active=slate-5.
   **`--dls-border: #f3f4f6` (light) / `#262626` (dark) is the ONE token not
   derived from Radix** — deliberately lighter than `--border`, which is why
   those surfaces read softer.
   **`--dls-accent: #011627`** — near-black navy, the brand ink; hover `#000000`
   light / `#0a2540` dark. Radius 16/24px, shell+card shadows.
3. **shadcn semantic tokens** — background/foreground/card/popover/primary/
   muted/border/ring/sidebar/chart-1..5. Dark differs in only two places:
   `--muted-foreground` slate-11→slate-10 and `--border` slate-5→slate-3.
4. **`@theme inline`** bridge exposing everything as utilities.

### The signature look
- **Desk background**: `radial-gradient(circle at top, rgba(74,111,255,0.12),
  transparent 42%)` over `#0b1020` (deep navy). Transparent on macOS so native
  vibrancy shows through.
- **Floating panels**: `rounded-[14px]` + 1px border + `bg-dls-surface` +
  `shadow-[0_8px_24px_rgba(15,23,42,0.06)]` (dark `0_10px_30px_rgba(0,0,0,0.45)`)
  + on macOS `bg-dls-surface/85 backdrop-blur-2xl backdrop-saturate-150`.
- **Radius is globally RESCALED**: `--radius: 0.45rem` (7.2px), so `rounded-xl`
  ≈10px not 12px; buttons/cards/dialogs use `rounded-4xl` (~18.7px), menus
  `rounded-3xl` (~15.8px). Changing `--radius` re-proportions the whole app.
- **Menus are hardcoded dark-glass on BOTH themes** — force `dark` class +
  `bg-popover/70` + a `before:` pseudo with `backdrop-blur-2xl saturate-150`,
  `animate-none!`, destructive items NOT colored red.
- **Inner-hairline bevel** on buttons/inputs: `before:` pseudo with
  `shadow-[0_1px_black/4%]` light, `0_-1px_white/6%` dark.
- **Text-fade truncation instead of ellipsis** (Arc-style) via mask-image.

### Typography — dense, Linear-adjacent
Body **13px** / line-height 1.5, system-UI stack (webfonts imported but dormant).
**`--text-sm` is overridden to 13px.** Dominant sizes by frequency:
11px (187 uses) > 10px (92) > 12px (71) > 13px (51). Weights: normal/medium
(dominant)/semibold/bold. Only 3 deliberate letter-spacings: `.18em` uppercase
status pills, `.04em` uppercase sidebar section labels, `-.02em` hero.
Root font-size is a **zoom variable** (`--openwork-font-size`, 0.8–1.6, Cmd±/0).

### Platform variants — carries much of the identity
`@custom-variant electron/windows/mac/linux`, driven by root classes the preload
applies (`html.openwork-electron.openwork-platform-mac`). Enables
`mac:bg-transparent`, `mac:backdrop-blur-2xl`, `mac:titlebar-drag`, traffic-light
offsets (`mac:pl-28`). Custom utilities `titlebar-drag` / `titlebar-no-drag`
(`app-region`). Window: 1180×820, macOS `titleBarStyle:"hiddenInset"`,
`vibrancy: dark? "under-window" : "sidebar"`, `visualEffectState:"active"`.

### Layout dimensions (exact)
Left sidebar default **260px** (min 220, floor 180; max 420). Right panel
collapsed 72 / expanded 520 (min 320, max 960). Session header **h-9 (36px)**;
settings header h-10; side-panel tab bar h-10; sidebar logo header h-14 after an
h-12 mac drag strip; far-right icon rail **w-9**. Transcript column
`max-w-[720px]`, composer `max-w-[800px]`, settings `max-w-3xl`. 8px inset
gutter around panels. Sidebar lane metrics: 12px base pad, **16px per nest
depth**, 20px glyph lane, 44px label lane.

### Motion
Durations 75–300ms (200/150/100 dominant). Curves: `cubic-bezier(.22,1,.36,1)`
(accordion expo-out), `(.4,0,.6,1)` soft-pulse, `(.4,0,.2,1)` dot ticker.
9 named keyframes incl. shimmer/dot-ticker/command-highlight.
**`prefers-reduced-motion` honored in 4 places.** Framer Motion used in only 6
files via `LazyMotion features={domMax}` + `m.*` to keep the bundle small.
Signature loader: a 3×3 dot matrix cycling 4 frames every 180ms.

### ⚠️ Two overlapping design languages coexist
Newer shadcn/Base-UI layer (`--background/--primary/--muted`, `rounded-4xl`,
`ring-1 ring-foreground/5`) vs older "DLS" layer (`--dls-*`, `bg-dls-surface`,
soft-card classes, pill buttons). Settings/design-system/composer/onboarding are
DLS; session chrome and ui/** are shadcn. **A redesign must pick ONE.**

## PRODUCT ARCHITECTURE — what to adopt

**Shape:** desktop app for running/sharing AI agent workflows; a separate agent
engine SDK does the actual agent work; also exposes an MCP server with just TWO
tools (`search_capabilities`, `execute_capability`) so the same skills/MCPs work
from other agent clients. Monorepo: app (Vite/React renderer) + desktop
(Electron main, 49 modules) + server (Bun, compiled binary, Drizzle/SQLite) +
shared types + enterprise apps.

**Surfaces:** session workspace (multi-workspace sidebar, drag-reorder, nested
session groups, pin/archive/rename, activity dots) · right side panel with 3
modes (embedded **browser with real tabs via WebContentsView** / extensions /
voice) · **artifacts panel** (text editor, **spreadsheet editor**, markdown
preview, PDF, images — lazy-loaded) · terminal dock (real PTY + xterm) ·
settings (17 tabs, renderable full-page OR inline-compact) · extensions
marketplace (skills, plugins, MCP servers, OAuth provider connections) · voice
mode · cloud/org layer with white-label branding + policy restrictions ·
onboarding with workspace **blueprints/presets** that seed starter sessions.

**⭐ THE KEY IDEA FOR US — the "control" layer.** The UI registers named, typed,
introspectable actions (`{id, label, description, sideEffect, args, execute}`)
via a `useControlAction` hook. These are exposed over a local HTTP server so
agents (and their eval harness) can drive the REAL app. This is exactly the
mechanism the owner asked for — "these must be interactable with our agent" —
and it is far better than ad-hoc IPC: every UI capability becomes a discoverable,
typed, agent-callable action with a declared side-effect flag.

**State:** 4 deliberately separated layers — Zustand (13 stores, UI/ephemeral,
selector-subscribed) · TanStack Query v5 (server/session state, hand-tuned
gcTime incl. `Infinity` for permission/question caches written only via
setQueryData) · React Context (deep ordered provider stack) ·
`useSyncExternalStore` for non-React sources (theme, bootstrap config).

**Performance techniques worth copying:**
- **React Compiler in `annotation` mode** — only files with `"use memo"` are
  compiled; exactly 3 opt in (the hottest render paths). Surgical, not global.
- **No list virtualization** despite the dep being installed. Instead: a custom
  scroll controller with gesture-window heuristics + **turn folding** (a finished
  turn with >4 step rows collapses to one summary line) + consecutive-tool-call
  grouping. Cheaper and better UX than virtualizing a chat transcript.
- Lazy-load only the heavy artifact editors behind Suspense.
- `LazyMotion` + `m.*` instead of `motion.*`.
- Prefetch cloud inventory on mount so settings never mounts cold.
- Electron `backgroundThrottling: false` so streaming continues when hidden.
- Dev-only render profiler + a render-loop watchdog, with the overlay mounted
  OUTSIDE the profiled tree so it doesn't inflate commit counts.

**Data model:** workspace = local directory OR remote server; typed wire
contracts in a shared types package; a single `DesktopCommandMap` as the ONE
source of truth for renderer↔main IPC (every command declares `{args, result}`)
enforced by a typecheck against the handler registry — we should adopt this.
Sessions form a tree with user groups, pin/archive/tag, workspace-scoped routing.
Persistence: atomic JSON writes in Electron main + Drizzle/SQLite in the server.
