# Claude-Clone Design Prototypes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is a DESIGN-PROTOTYPE plan, not a code/TDD plan.** There is no app wiring and no unit tests. Each task produces one self-contained static HTML (or CSS) file and is "green" when it passes its **Acceptance checklist** — verified by opening it in the Claude Code **preview** browser (structural `preview_snapshot` + `preview_screenshot` + `preview_inspect` on tokens). "Commit" steps still apply.

**Goal:** Produce a suite of static HTML/CSS prototypes that clone Claude/Anthropic's design language (per `docs/design/themes/anthorpic.md`) as a new "Claude for BrainRouter" app concept — one shared design-system, then one prototype per UI surface across Desktop, Web/Dashboard, Mobile, and CLI. No code is wired into the real apps.

**Architecture:** A single source-of-truth stylesheet (`claude-design-system.css`) holds every token and component class, ported verbatim from the Anthropic style reference and extended with a warm-slate dark mode + the handful of app-shell components Claude's product needs (sidebar, composer, message rows, artifact panel). Every prototype is a plain `.html` file that `<link>`s that one stylesheet — re-theming the whole set means editing one file (this mirrors the existing `brainrouter-mobile/prototypes/` convention). A gallery `index.html` links all screens; a `design-system.html` renders the living style guide.

**Tech Stack:** Hand-authored HTML5 + CSS (custom properties, flexbox/grid). No framework, no build step, no bundler. No external network calls — fonts resolve through a curated system stack (optional `@font-face` data-URI drop-in noted for pixel-faithful cloning). Verified in the built-in preview browser.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from `docs/design/themes/anthorpic.md`.

- **Clone the Anthropic design language exactly.** Page base `#faf9f5` (Ivory Light) — **never** pure white/gray. Primary text/borders `#141413` (Slate Dark). Dark inversion surface `#141413`.
- **Accent is held in reserve.** Clay `#d97757` (hover/press Ember `#c6613f`) — one accent per section maximum; default state uses **zero** chromatic color. Categorical tags may use Olive `#788c5d` / Sky `#6a9bcc` / Fig `#c46686` / Cactus `#bcd1ca`, never combined within a section.
- **Zero box-shadows anywhere.** Depth comes only from surface-color contrast + 1px `#141413` borders. Flat, high-contrast, print-on-screen.
- **Button radius is `0px`** for all controls, **except** the primary "Try Claude"-class CTA which uses the signature asymmetric `border-radius: 0 0 8px 8px` (flat top, rounded bottom). Cards `8px`, panels `16px`, feature/editorial cards `24px`, badges `0px`.
- **Type pairing:** grotesque sans for all UI chrome + body; serif for editorial/display **only on dark `#141413` surfaces**; mono for metadata labels (DATE, CATEGORY, token counts, IDs). Substitute stack (no CDN): sans → `-apple-system,"Segoe UI",Roboto,Inter,system-ui,sans-serif`; serif → `"Iowan Old Style",Palatino,Georgia,ui-serif,serif`; mono → `"Cascadia Code","JetBrains Mono",ui-monospace,Consolas,monospace`.
- **Emphasis = underline, never color.** Display/heading-lg keywords get a thick `text-decoration: underline`; never recolor or embolden headline keywords. Body text carries no emphasis decoration.
- **Metadata labels are pure text** — no pill/chip/capsule background fills for DATE/CATEGORY-style labels.
- **Base unit 4px**, compact density. Spacing scale `4/8/12/16/32/76/84`. Page max-width `1200px`, section gap `61px`, card padding `31px`.
- **Real content only.** Populate every screen with real BrainRouter domain content (memory recall, skills, Atlas graph, providers, sessions) — never lorem.
- **Accessibility & hygiene:** semantic HTML, one `<h1>` per page, visible `:focus-visible` outline (`2px solid #141413`, offset `2px`), honor `@media (prefers-reduced-motion: reduce)`, all attributes double-quoted, all non-void elements closed, body never scrolls sideways (wide content gets its own `overflow-x:auto` container).
- **Output location:** all files under `docs/design/prototypes/claude-clone/`. No changes anywhere else in the repo.

---

## File Structure

```
docs/design/prototypes/claude-clone/
├── claude-design-system.css     # F0 — single source of truth: tokens + component classes
├── design-system.html           # F1 — living style guide (swatches + every component)
├── index.html                   # F2 — gallery: links every prototype, grouped by surface
├── desktop/                      # ~1280×800 app-frame prototypes
│   ├── d1-home.html              #   New-chat home (greeting, suggestions, composer)
│   ├── d2-chat.html              #   Chat thread + composer + tool rows
│   ├── d3-sidebar.html           #   Conversations + Projects + Skills navigator (full shell)
│   ├── d4-artifact.html          #   Artifact/Memory side-panel (recalled memory + Atlas graph)
│   └── d5-settings.html          #   Skills gallery + model/provider picker + settings
├── web/                          # ~1200px centered editorial (dashboard functions)
│   ├── w1-overview.html          #   Dashboard home in Claude editorial style
│   └── w2-recall.html            #   Recall Inspector as a Claude editorial article
├── mobile/                       # ~390×844 (brainrouter-mobile prototype conventions)
│   ├── m1-chat.html              #   Mobile chat thread + composer
│   ├── m2-conversations.html     #   Conversations list + New chat
│   └── m3-detail.html            #   Skill / memory detail sheet
└── cli/                          # terminal aesthetic (dark inversion of the system)
    └── c1-terminal.html          #   Claude Code-style session (prompt, stream, tool, /palette)
```

**Responsibilities:** `claude-design-system.css` owns 100% of visual decisions; every `.html` is structure + real copy that consumes those classes. Files that change together (all prototypes) share the one stylesheet, so a re-theme is a one-file edit. Each screen is independently reviewable — a reviewer can accept `d2-chat.html` while rejecting `d5-settings.html`.

**Function/skill mapping** (the "by functions and skills" requirement — each prototype clones Claude's design in service of one BrainRouter function):

| Prototype | BrainRouter function / skill it dresses |
|---|---|
| d1-home | Start a session / brain landing |
| d2-chat | Converse + recall pipeline + tool use |
| d3-sidebar | Sessions, Projects, Skills navigation |
| d4-artifact | Memory / Atlas knowledge-graph viewing |
| d5-settings | Skills registry + Providers/Models config |
| w1-overview | Dashboard `/overview` |
| w2-recall | Dashboard `/recall-inspector` + `/evidence` |
| m1/m2/m3 | Mobile chat, sessions, skill/memory detail |
| c1-terminal | `brainrouter-cli` slash-command session |

---

## Task 0: Design System Stylesheet (Foundation)

**Files:**
- Create: `docs/design/prototypes/claude-clone/claude-design-system.css`

**Interfaces:**
- Produces: the CSS custom properties and component classes every later task consumes. Class names later tasks rely on: `.app`, `.rail`, `.rail__item`, `.thread`, `.msg`, `.msg--user`, `.msg--assistant`, `.msg__meta`, `.composer`, `.composer__input`, `.btn`, `.btn--cta`, `.btn--ghost`, `.card`, `.card--dark`, `.card--release`, `.label` (metadata), `.tag--olive/sky/fig/cactus`, `.underline-emphasis`, `.panel`, `.nav`. Data attribute: `data-theme="dark"` on `<html>` opts into the warm-slate inversion.

- [ ] **Step 1: Create the stylesheet with the full token block + component classes**

Write this file **verbatim** (it is the DRY foundation — no placeholders downstream depend on it):

```css
/*
  Claude-Clone Design System — single source of truth.
  Ported from docs/design/themes/anthorpic.md (Anthropic style reference).
  Every prototype links this file: <link rel="stylesheet" href="../claude-design-system.css" />
  Re-theme the whole set by editing ONLY this file.
*/
:root {
  /* Colors — achromatic ivory/slate base, chromatic budget reserved for Clay */
  --color-slate-dark:#141413; --color-ivory-light:#faf9f5; --color-ivory-medium:#f0eee6;
  --color-ivory-dark:#e8e6dc; --color-oat:#e3dacc; --color-cloud-medium:#b0aea5;
  --color-cloud-light:#d1cfc5; --color-cloud-dark:#87867f; --color-slate-medium:#3d3d3a;
  --color-slate-light:#5e5d59; --color-clay:#d97757; --color-accent-ember:#c6613f;
  --color-olive:#788c5d; --color-sky:#6a9bcc; --color-fig:#c46686; --color-cactus:#bcd1ca;

  /* Semantic aliases (map to base palette; do NOT introduce new hues) */
  --bg:var(--color-ivory-light); --surface-2:var(--color-ivory-medium);
  --surface-3:var(--color-oat); --ink:var(--color-slate-dark); --ink-2:var(--color-slate-light);
  --ink-muted:var(--color-cloud-dark); --line:var(--color-slate-dark); --accent:var(--color-clay);

  /* Type families (system-stack substitutes; no CDN) */
  --font-sans:-apple-system,"Segoe UI",Roboto,Inter,system-ui,sans-serif;
  --font-serif:"Iowan Old Style",Palatino,Georgia,ui-serif,serif;
  --font-mono:"Cascadia Code","JetBrains Mono",ui-monospace,Consolas,monospace;

  /* Type scale (from anthorpic.md) */
  --text-caption:12px; --text-body-sm:15px; --text-subheading:18px; --text-heading-sm:20px;
  --text-heading:24px; --text-heading-lg:61px; --text-display:91px;

  /* Spacing (4px base) */
  --sp-4:4px; --sp-8:8px; --sp-12:12px; --sp-16:16px; --sp-32:32px; --sp-76:76px; --sp-84:84px;

  /* Radii — 0px controls, asymmetric CTA, 8/16/24 for cards/panels/feature */
  --r-card:8px; --r-panel:16px; --r-feature:24px; --r-btn:0px; --r-cta:0 0 8px 8px;

  /* Layout */
  --page-max:1200px; --section-gap:61px; --card-pad:31px;

  --ease:cubic-bezier(.2,.8,.2,1);
}

/* Warm-slate dark inversion (Claude product dark mode) — opt in: <html data-theme="dark"> */
:root[data-theme="dark"] {
  --bg:#1f1e1d; --surface-2:#262624; --surface-3:#30302e;
  --ink:#f5f4ef; --ink-2:#c9c7bf; --ink-muted:#8a897f;
  --line:#3d3d3a; --accent:#e08b6a;
}

*,*::before,*::after { box-sizing:border-box; }
html,body { margin:0; }
body {
  background:var(--bg); color:var(--ink);
  font-family:var(--font-sans); font-size:var(--text-body-sm); line-height:1.4;
  letter-spacing:-0.002em; -webkit-font-smoothing:antialiased;
}
h1,h2,h3 { text-wrap:balance; margin:0; letter-spacing:-0.012em; font-weight:700; }
:focus-visible { outline:2px solid var(--line); outline-offset:2px; }

/* Emphasis: underline only, never color/weight */
.underline-emphasis { text-decoration:underline; text-decoration-thickness:3px; text-underline-offset:4px; }

/* Metadata label — pure text, no chip */
.label { font-family:var(--font-mono); font-size:var(--text-caption); color:var(--ink-muted);
  text-transform:uppercase; letter-spacing:0.04em; }

/* Buttons */
.btn { font-family:var(--font-sans); font-size:var(--text-body-sm); font-weight:500;
  background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:var(--r-btn);
  padding:12px 31px; cursor:pointer; transition:background .15s var(--ease),color .15s var(--ease); }
.btn:hover { background:var(--surface-2); }
.btn--cta { border-radius:var(--r-cta); } /* signature asymmetric radius */
.btn--ghost { background:transparent; padding:12px; }
.btn--accent { background:var(--accent); color:var(--color-ivory-light); border-color:var(--accent); }
.btn--accent:hover { background:var(--color-accent-ember); border-color:var(--color-accent-ember); }

/* Cards / surfaces */
.card { background:var(--surface-2); border-radius:var(--r-card); padding:var(--card-pad); }
.card--release { background:var(--surface-2); }
.card--dark { background:var(--color-slate-dark); color:var(--color-ivory-light); border-radius:var(--r-feature); padding:var(--card-pad); }
.card--dark h2 { font-family:var(--font-serif); font-weight:400; font-size:var(--text-display); line-height:1.1; }
.panel { border:1px solid var(--line); border-radius:var(--r-panel); }

/* Categorical tags (one per section) */
.tag { font-family:var(--font-mono); font-size:var(--text-caption); color:var(--ink); }
.tag--olive { color:var(--color-olive); } .tag--sky { color:var(--color-sky); }
.tag--fig { color:var(--color-fig); } .tag--cactus { color:var(--color-cactus); }

/* Arrow text link */
.arrow-link { color:var(--ink); text-decoration:none; font-weight:400; }
.arrow-link:hover { text-decoration:underline; }
.arrow-link::after { content:" \2192"; }

@media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; } }
```

- [ ] **Step 2: Add the app-shell component classes** (append to the same file — these are the classes Claude's *product* needs that the marketing reference doesn't cover; keep them inside the same token system)

```css
/* ---- App shell (Claude product surfaces) ---- */
.app { display:grid; grid-template-columns:260px 1fr; min-height:100vh; }
.rail { background:var(--surface-2); border-right:1px solid var(--line); padding:var(--sp-16);
  display:flex; flex-direction:column; gap:var(--sp-8); }
.rail__item { display:flex; align-items:center; gap:var(--sp-8); padding:var(--sp-8) var(--sp-12);
  border-radius:var(--r-btn); color:var(--ink); text-decoration:none; font-size:var(--text-body-sm); }
.rail__item[aria-current="true"] { background:var(--bg); border:1px solid var(--line); }
.rail__item:hover { background:var(--bg); }

/* Chat thread */
.thread { max-width:740px; margin:0 auto; padding:var(--sp-32) var(--sp-16);
  display:flex; flex-direction:column; gap:var(--sp-32); }
.msg { display:flex; flex-direction:column; gap:var(--sp-8); }
.msg__meta { font-family:var(--font-mono); font-size:var(--text-caption); color:var(--ink-muted);
  text-transform:uppercase; letter-spacing:0.04em; }
.msg--user .msg__body { background:var(--surface-2); border-radius:var(--r-card); padding:var(--sp-16); }
.msg--assistant .msg__body { font-family:var(--font-serif); font-size:var(--text-subheading); line-height:1.6; }
.tool-row { border:1px solid var(--line); border-radius:var(--r-card); padding:var(--sp-12) var(--sp-16);
  font-family:var(--font-mono); font-size:var(--text-caption); }

/* Composer */
.composer { max-width:740px; margin:0 auto var(--sp-32); border:1px solid var(--line);
  border-radius:var(--r-panel); background:var(--bg); padding:var(--sp-12); }
.composer__input { width:100%; border:0; background:transparent; color:var(--ink);
  font-family:var(--font-sans); font-size:var(--text-subheading); resize:none; outline:none; padding:var(--sp-8); }
.composer__bar { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-8); margin-top:var(--sp-8); }

/* Top nav */
.nav { height:68px; display:flex; align-items:center; justify-content:space-between;
  padding:0 var(--sp-32); background:var(--surface-2); border-bottom:1px solid transparent; }
.nav__mark { font-weight:700; font-size:16px; letter-spacing:-0.01em; }
```

- [ ] **Step 3: Verify structurally** — there is nothing to render yet. Open the file, confirm it parses (no CSS syntax error) by loading `design-system.html` in Task 1. Defer visual verification to Task 1.

- [ ] **Step 4: Commit**

```bash
git add docs/design/prototypes/claude-clone/claude-design-system.css
git commit -m "design(claude-clone): design-system stylesheet — Anthropic tokens + app-shell classes"
```

---

## Task 1: Living Style Guide (`design-system.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/design-system.html`

**Interfaces:**
- Consumes: `claude-design-system.css` (all tokens/classes from Task 0).
- Produces: the reference page reviewers use to sign off the system before screens are built.

- [ ] **Step 1: Build the page skeleton** linking the stylesheet and laying out labelled sections with `flex`/`grid` + `gap`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Claude-Clone · Design System</title>
  <link rel="stylesheet" href="claude-design-system.css" />
</head>
<body>
  <header class="nav"><span class="nav__mark">CLAUDE · BRAINROUTER</span>
    <button class="btn btn--cta">Try Claude</button></header>
  <main style="max-width:var(--page-max);margin:0 auto;padding:var(--sp-32) var(--sp-16);
              display:flex;flex-direction:column;gap:var(--section-gap)">
    <section><p class="label">Color</p><!-- swatch grid --></section>
    <section><p class="label">Type</p><!-- scale specimens --></section>
    <section><p class="label">Buttons</p><!-- btn variants --></section>
    <section><p class="label">Cards</p><!-- card / card--dark / card--release --></section>
    <section><p class="label">Emphasis</p><!-- underline-emphasis demo --></section>
  </main>
</body>
</html>
```

- [ ] **Step 2: Fill each section with real specimens** — every color token as a swatch with its hex + role; the full type scale (caption→display) with the serif-on-dark rule demonstrated; all `.btn` variants including the asymmetric `.btn--cta`; `.card`, `.card--dark` (serif display headline), `.card--release`; an `.underline-emphasis` headline. Real copy (e.g. headline "AI research and products for BrainRouter" with "research" + "products" underlined).

- [ ] **Step 3: Verify in preview** (Acceptance checklist):
  - `preview_start` → open `design-system.html`; `preview_screenshot` shows ivory `#faf9f5` ground, no shadows anywhere.
  - `preview_inspect` on `body` → `background-color` resolves to `rgb(250, 249, 245)`.
  - `preview_inspect` on `.btn--cta` → `border-radius` is `0px 0px 8px 8px`.
  - `preview_inspect` on `.card--dark h2` → `font-family` starts with a serif; on `.btn` → `border-radius: 0px`.
  - `preview_console_logs` (level:error) → empty.
  - Toggle `document.documentElement.setAttribute('data-theme','dark')` via `preview_eval` → ground flips to warm slate `#1f1e1d`, text stays legible.

- [ ] **Step 4: Commit**

```bash
git add docs/design/prototypes/claude-clone/design-system.html
git commit -m "design(claude-clone): living style guide"
```

---

## Task 2: Desktop — New-Chat Home (`desktop/d1-home.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/desktop/d1-home.html`
- Note: links `../claude-design-system.css`.

**Interfaces:**
- Consumes: `.app`, `.rail`, `.composer`, `.btn`, `.underline-emphasis` from Task 0.

- [ ] **Step 1: Build the app frame** — `.app` grid (260px rail + main). Rail: BrainRouter wordmark, `.btn--accent` "New chat", nav `.rail__item`s (Chats, Projects, Skills, Memory, Atlas), account row pinned bottom.
- [ ] **Step 2: Build the centered greeting** — serif display headline on ivory is **forbidden**, so use sans `--text-heading-lg` (61px, weight 700): e.g. "Good evening. What should we recall?" with one keyword underlined via `.underline-emphasis`. Below: 4 suggestion cards (`.card`, radius 8px) with real BrainRouter prompts ("Summarize this session's decisions", "Search memory for the recall-timeout fix", "Run the /atlas skill on brainrouter-core", "Draft a changelog from today's commits").
- [ ] **Step 3: Build the composer** — `.composer` with textarea placeholder "Message Claude…", `.composer__bar` holding a model pill ("claude-opus-4-8", mono `.label`) + attach glyph + `.btn--accent` send.
- [ ] **Step 4: Verify (Acceptance checklist):**
  - `preview_snapshot` shows one `<h1>`, the 4 suggestion cards, and the composer textarea.
  - `preview_inspect` `.rail` → `border-right` is `1px solid rgb(20,20,19)`; no `box-shadow` on any card (inspect `.card` → `box-shadow: none`).
  - Body does not scroll horizontally at 1280px (`preview_resize` width 1280; scrollWidth ≤ clientWidth via `preview_eval`).
  - `:focus-visible` outline visible when tabbing to the composer (`preview_eval` focus, screenshot).
- [ ] **Step 5: Commit** — `git add … && git commit -m "design(claude-clone): desktop new-chat home"`

---

## Task 3: Desktop — Chat Thread + Composer (`desktop/d2-chat.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/desktop/d2-chat.html`

**Interfaces:**
- Consumes: `.app`, `.rail`, `.thread`, `.msg*`, `.tool-row`, `.composer`, `.label`.

- [ ] **Step 1: Reuse the app frame** from d1 (rail identical — copy the markup; DRY lives in the CSS, not the HTML).
- [ ] **Step 2: Build the thread** — a real BrainRouter exchange:
  - `.msg--user` bubble: "Why did the reranker time out on Windows and how was it fixed?" with `.msg__meta` "YOU · 19:12".
  - `.msg--assistant` (serif body): a 2-paragraph answer about kind-aware model probe + CPU timeout, one clause `.underline-emphasis`.
  - A `.tool-row`: `mcp · recall("reranker timeout")  →  7 memories` and a second `git · log --oneline -5`.
  - A changeset-style `.card`: "3 files changed · +113 −4" with mono file list.
- [ ] **Step 3: Pin the composer** at the bottom of the main column (same component as d1).
- [ ] **Step 4: Verify (Acceptance checklist):**
  - `preview_snapshot` shows user msg, assistant msg, tool rows, changeset card, composer in order.
  - `preview_inspect` `.msg--assistant .msg__body` → serif `font-family`; `.tool-row` → mono `font-family`, `border-radius: 8px`.
  - `.msg__meta` renders uppercase mono (`preview_inspect` `text-transform: uppercase`).
  - No shadows; ivory ground; error console empty.
- [ ] **Step 5: Commit** — `-m "design(claude-clone): desktop chat thread"`

---

## Task 4: Desktop — Sidebar Navigator (Full Shell) (`desktop/d3-sidebar.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/desktop/d3-sidebar.html`

**Interfaces:**
- Consumes: `.app`, `.rail`, `.rail__item`, `.label`.

- [ ] **Step 1: Build an expanded rail** with three grouped, `.label`-headed sections: **RECENTS** (5 real session titles + relative timestamps in mono), **PROJECTS** (BrainRouter Core, Dashboard, Mobile, Docs), **SKILLS** (planning-skill, debugging-and-error-recovery, verify-loop, changelog-generator — the real `skills/` entries). Active row uses `aria-current="true"`.
- [ ] **Step 2: Main column = a light "Projects" board** — a 3-col grid of `.card--release` cards, each a project with a mono DATE label + arrow-link "Open →". No shadows; cards differentiated by `#f0eee6` surface only.
- [ ] **Step 3: Verify (Acceptance checklist):**
  - `preview_snapshot` shows the three rail groups with their mono labels and the project card grid.
  - `preview_inspect` active `.rail__item` → has a `1px solid` border + ivory background (selected state via contrast, not color).
  - Card grid reflows to 1 column at 640px (`preview_resize` 600 → snapshot).
- [ ] **Step 4: Commit** — `-m "design(claude-clone): desktop sidebar navigator"`

---

## Task 5: Desktop — Artifact / Memory Panel (`desktop/d4-artifact.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/desktop/d4-artifact.html`

**Interfaces:**
- Consumes: `.app`, `.thread`, `.panel`, `.card--dark`, `.label`, `.tag--*`.

- [ ] **Step 1: Two-column split** — left = a short chat thread (reuse `.thread`), right = an artifact `.panel` (16px radius, 1px border) titled "Memory · recall-timeout-fix".
- [ ] **Step 2: Fill the artifact panel** — a recalled-memory record: mono `.label`s (TYPE, FRESHNESS, SOURCE), body text, and a **dark editorial card** (`.card--dark`, 24px radius) embedding a hand-drawn Atlas graph as inline SVG (nodes = files, edges = imports; luminous hairlines on `#141413`, matching the reference imagery). Categorical `.tag--sky` for "provider" nodes, `.tag--olive` for "memory" nodes (one family per group).
- [ ] **Step 3: Verify (Acceptance checklist):**
  - `preview_snapshot` shows both columns; the artifact panel has the mono metadata labels and the dark SVG card.
  - `preview_inspect` `.card--dark` → `background rgb(20,20,19)`, `border-radius 24px`; SVG scales with `max-width:100%`.
  - At 900px the panel stacks under the thread (`preview_resize` 880 → snapshot), no horizontal scroll.
- [ ] **Step 4: Commit** — `-m "design(claude-clone): desktop artifact/memory panel"`

---

## Task 6: Desktop — Skills Gallery + Model/Provider Settings (`desktop/d5-settings.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/desktop/d5-settings.html`

**Interfaces:**
- Consumes: `.app`, `.rail`, `.card`, `.card--release`, `.btn`, `.btn--cta`, `.label`, `.tag--*`.

- [ ] **Step 1: Settings shell** — left rail becomes a settings nav (`.label` "SETTINGS" + rows: Skills, Providers, Models, Connectors, Permissions, Appearance). Main column has a heading (sans, 24px) + section body.
- [ ] **Step 2: Skills gallery** — 3-col `.card--release` grid, each a real skill (name in sans 20px/600, one-line description, mono footer "CATEGORY · agent", arrow-link "Configure →"). Include planning-skill, verify-loop, changelog-generator, debugging-and-error-recovery, spec-driven-skill, handover-skill.
- [ ] **Step 3: Model/provider picker** — a `.panel` listing providers (Anthropic, LM Studio, OpenRouter) each with a mono model list and a radio-style selected row (selected = 1px border + ivory, per the no-color-for-state rule). "Save" uses `.btn--cta`.
- [ ] **Step 4: Verify (Acceptance checklist):**
  - `preview_snapshot` shows the skills grid (6 cards) + provider panel.
  - `preview_inspect` a skill card → `border-radius 8px`, no shadow; selected provider row → border + ivory bg, not an accent fill.
  - Save button → asymmetric `border-radius 0 0 8px 8px`.
- [ ] **Step 5: Commit** — `-m "design(claude-clone): desktop skills + settings"`

---

## Task 7: Web — Dashboard Overview (Editorial) (`web/w1-overview.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/web/w1-overview.html`

**Interfaces:**
- Consumes: `.nav`, `.card--dark`, `.card--release`, `.btn--cta`, `.label`, `.underline-emphasis`.

- [ ] **Step 1: Editorial layout** (this surface may use the full marketing rhythm since it's a landing-style dashboard): sticky `.nav` (68px), then a hero — left 61px sans headline "Your brain, remembered." with "remembered" underlined; right ~320px body paragraph. `--page-max` centered on ivory.
- [ ] **Step 2: Alternating bands** — a full-column dark editorial `.card--dark` (24px) with a serif 91px stat ("128k memories") + `.btn--cta` "Open recall inspector"; below, a 3-col `.card--release` grid of "Latest activity" (recall events) each with mono DATE + arrow-link. Strict light→dark→light rhythm, hard edges, `--section-gap` 61px.
- [ ] **Step 3: Verify (Acceptance checklist):**
  - `preview_snapshot` shows nav → hero → dark band → release grid in order.
  - `preview_inspect` hero `<h1>` → 61px sans; the underlined keyword has `text-decoration: underline` (not a color change).
  - Dark card serif stat resolves to a serif family; page body max-width 1200px centered.
  - `preview_resize` mobile (375) → single column, no horizontal scroll.
- [ ] **Step 4: Commit** — `-m "design(claude-clone): web dashboard overview"`

---

## Task 8: Web — Recall Inspector Article (`web/w2-recall.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/web/w2-recall.html`

**Interfaces:**
- Consumes: `.nav`, `.card`, `.label`, `.tag--*`, `.arrow-link`, `.underline-emphasis`.

- [ ] **Step 1: Article layout** — sticky nav + centered `--page-max` column. Title (sans 24px), a metadata row of mono `.label`/value pairs (QUERY, STAGES, LATENCY, RESULTS).
- [ ] **Step 2: Recall timeline** — a horizontal row of stages (keyword → vector → filepath → reranker → judge → graph-expand) rendered as mono labels on a hairline rule with per-stage result counts; wrap the wide timeline in an `overflow-x:auto` container. Below: an evidence list — each recalled memory as a light `.card` with a categorical `.tag` (one family), body text, and mono SOURCE label.
- [ ] **Step 3: Verify (Acceptance checklist):**
  - `preview_snapshot` shows the metadata pairs, the 6-stage timeline, and evidence cards.
  - The timeline container scrolls internally at 375px width; page body does not scroll sideways (`preview_eval` scrollWidth check).
  - `preview_inspect` labels → mono uppercase; cards → no shadow, 8px radius.
- [ ] **Step 4: Commit** — `-m "design(claude-clone): web recall inspector"`

---

## Task 9: Mobile — Chat (`mobile/m1-chat.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/mobile/m1-chat.html`

**Interfaces:**
- Consumes: `.thread`, `.msg*`, `.composer`, `.label`. Follows `brainrouter-mobile/prototypes` conventions: fixed device viewport, links the shared CSS.

- [ ] **Step 1: Device frame** — wrap content in a `390×844` frame (`max-width:390px;margin:0 auto;min-height:844px`), a slim top bar (back chevron + "Claude" mark + overflow), the `.thread` (single column, full-width messages), and a bottom-pinned `.composer`.
- [ ] **Step 2: Real mobile exchange** — one user bubble + one serif assistant answer + one `.tool-row`, sized for the narrow column.
- [ ] **Step 3: Verify (Acceptance checklist):**
  - `preview_resize` preset `mobile` (375×812) → `preview_screenshot` shows the framed chat, composer reachable, no horizontal scroll.
  - `preview_inspect` `.composer` sits at viewport bottom; tap targets ≥ 44px tall (inspect send button height).
- [ ] **Step 4: Commit** — `-m "design(claude-clone): mobile chat"`

---

## Task 10: Mobile — Conversations List (`mobile/m2-conversations.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/mobile/m2-conversations.html`

**Interfaces:**
- Consumes: `.rail__item` (restyled full-width for mobile), `.btn--accent`, `.label`.

- [ ] **Step 1: List screen** — top bar with "Chats" title + `.btn--accent` "New" (icon). A grouped list (TODAY / EARLIER mono `.label` headers) of real session rows: title, one-line preview (`--ink-muted`), mono timestamp, 1px bottom divider (no shadow).
- [ ] **Step 2: Verify (Acceptance checklist):**
  - `preview_resize` mobile → `preview_snapshot` lists grouped rows with mono headers.
  - Rows separated by `1px solid` divider only; no card shadows; `:focus-visible` outline on a row when tabbed.
- [ ] **Step 3: Commit** — `-m "design(claude-clone): mobile conversations list"`

---

## Task 11: Mobile — Skill / Memory Detail Sheet (`mobile/m3-detail.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/mobile/m3-detail.html`

**Interfaces:**
- Consumes: `.panel`, `.card--dark`, `.label`, `.tag--*`, `.btn`, `.btn--cta`.

- [ ] **Step 1: Bottom-sheet detail** — a memory/skill record: title (sans 20px), mono `.label` metadata rows (TYPE, FRESHNESS, LINKS), body, and a small dark `.card--dark` (24px) mini-graph (inline SVG) — the mobile echo of d4. Primary `.btn--cta` "Open in chat", ghost "Dismiss".
- [ ] **Step 2: Verify (Acceptance checklist):**
  - `preview_resize` mobile → `preview_snapshot` shows the sheet with metadata + mini-graph + two buttons.
  - `.btn--cta` asymmetric radius; dark mini-card 24px radius; SVG `max-width:100%`; no sideways scroll.
- [ ] **Step 3: Commit** — `-m "design(claude-clone): mobile detail sheet"`

---

## Task 12: CLI — Claude Code-Style Terminal (`cli/c1-terminal.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/cli/c1-terminal.html`

**Interfaces:**
- Consumes: the dark inversion (`data-theme="dark"` on `<html>`), `--font-mono`, `.label`, `.tag--*`, `--accent`.

- [ ] **Step 1: Terminal frame** — `data-theme="dark"` document; a full-bleed `#1f1e1d` terminal surface, `--font-mono` throughout. A slim window chrome bar ("brainrouter · zsh") and a scrolling session body.
- [ ] **Step 2: Real CLI session** — render a `brainrouter` prompt, a typed `/recall reranker timeout`, a streamed multi-line response, a tool-call block (`recall() → 7 memories`), a `/config` picker mock (rows with a `›` cursor, selected row = accent-underlined text per the underline-emphasis rule, not a fill), and a status line at the bottom (mono, model + effort + token count). Clay `--accent` used once (the active cursor/prompt glyph) — everything else achromatic.
- [ ] **Step 3: Verify (Acceptance checklist):**
  - `preview_snapshot` shows prompt → command → streamed output → tool block → `/config` picker → status line.
  - `preview_inspect` body → warm-slate `#1f1e1d`, mono font; accent appears exactly once (the prompt glyph).
  - The transcript wraps or scrolls inside its own container; page body never scrolls sideways.
- [ ] **Step 4: Commit** — `-m "design(claude-clone): cli terminal session"`

---

## Task 13: Gallery Index (`index.html`)

**Files:**
- Create: `docs/design/prototypes/claude-clone/index.html`

**Interfaces:**
- Consumes: `.nav`, `.card--release`, `.label`, `.arrow-link`.

- [ ] **Step 1: Build the gallery** — sticky `.nav`, an intro line ("Claude, cloned for BrainRouter — static design prototypes"), then four `.label`-headed groups (DESKTOP / WEB / MOBILE / CLI) each a `.card--release` grid linking every prototype with a one-line description + `.arrow-link`. Include a link to `design-system.html`.
- [ ] **Step 2: Verify (Acceptance checklist):**
  - `preview_snapshot` lists all 12 screen links + the style guide, grouped by surface.
  - Every link resolves (click each via `preview_click`, confirm the target loads with a `preview_snapshot`, `preview_console_logs` error-free).
- [ ] **Step 3: Commit** — `-m "design(claude-clone): gallery index"`

---

## Self-Review

**1. Spec coverage.** Surfaces requested (Desktop, Web/Dashboard, Mobile, CLI) → all covered (Tasks 2–6 desktop, 7–8 web, 9–11 mobile, 12 cli). Deliverable requested ("design-system.html + one prototype per surface, no app wiring") → Task 0/1 = system, Tasks 2–12 = per-surface prototypes, zero repo files outside `docs/design/prototypes/claude-clone/` touched. "By functions and skills" → the function/skill mapping table binds each prototype to a real BrainRouter function. "Clone Claude design exactly" → every token/rule copied verbatim from `docs/design/themes/anthorpic.md` into Task 0.

**2. Placeholder scan.** Task 0 ships the complete stylesheet (no TBD). Screen tasks specify exact files, regions, real BrainRouter copy, exact token/class usage, and concrete preview-based acceptance checks — no "add appropriate styling" hand-waving. The one deliberate altitude choice: full final HTML for every screen is not inlined (that would be the implementation, not a plan); instead each screen gives its structure, real content, the shared components it composes, and a measurable checklist — enough to build without guessing.

**3. Consistency.** Class names introduced in Task 0 (`.app`, `.rail`, `.thread`, `.msg--assistant`, `.composer`, `.btn--cta`, `.card--dark`, `.label`, `.tag--*`, `.underline-emphasis`) are the exact names referenced in Tasks 2–13. Dark mode is always `data-theme="dark"` on `<html>`. Radii, palette, and font stacks referenced in checklists match the Task 0 values.

---

## Assumptions (flag before executing if any are wrong)

- **"Clone Claude design as an app"** = build prototype *screens of a Claude-style app* (chat, sidebar, artifacts, settings, terminal) rendered in Anthropic's design language, populated with BrainRouter content — **not** restyling the existing BrainRouter apps. (Confirmed by your answers.)
- **Reference of record** is `docs/design/themes/anthorpic.md` (the repo's Anthropic style spec). It documents Anthropic's *marketing* system; product-shell components (sidebar/composer/message rows) are added in Task 0 **within** that token system, since the app needs them and they aren't in the marketing reference.
- **Fonts** use a system-stack substitute (no CDN, renders offline/identically). Pixel-faithful cloning of Copernicus/Styrene would require licensed `@font-face` data-URIs — out of scope unless you provide the files.
- **Mobile** lives here as standalone prototypes under `claude-clone/mobile/` (not inside the separate `brainrouter-mobile` branch), following that branch's authoring conventions.
