<!-- GENERATED FILE — do not edit by hand.
     Source: packages/core/src/design/detect/rules.ts (DESIGN_RULES).
     Regenerate: REGEN_CATALOG=1 npm --workspace packages/core test -- design-rules-drift
     Drift-checked by packages/core/src/tests/design-rules-drift.test.ts (ADR-056 D-B1). -->

# BrainRouter design rule catalog

Version 1.0.0. 35 deterministic rules run by `design_detect` / `/design detect` with no model. Advisory rules are reported, never counted as failures.

## `slop` (17)

| Rule | Severity | Name | Guideline |
|------|----------|------|-----------|
| `side-stripe-border` | warning | Side-stripe accent border | Colour belongs to meaning, not to a stripe; remove the accent or make the whole surface carry it. |
| `gradient-text` | warning | Gradient text | Emphasis comes from weight or size; text is solid. |
| `ai-palette` | warning | Default AI palette | Choose a palette the product owns; the violet gradient and cyan-on-black are the defaults every generator reaches for. |
| `nested-cards` | warning | Cards inside cards | One container per idea; a card inside a card is structure standing in for hierarchy. |
| `identical-card-grid` | info (advisory) | Identical card grid | A grid of identical cards is the lazy section; vary the structure or drop the cards. |
| `hero-metric` | info (advisory) | Hero-metric template | Numbers earn size when they carry a decision; a row of decorated metrics is a template. |
| `overused-font` | info | Overused typeface | Pick a face that gives the interface a voice; the default sans is invisible. |
| `flat-type-hierarchy` | warning | Flat type hierarchy | Give the scale at least one decisive step so the page has a hierarchy. |
| `glow-halo` | warning | Glow halo | Depth has an offset and a soft blur; a coloured halo is ornament. |
| `bounce-easing` | info | Bounce / elastic easing | Motion eases out from an already-visible state; bouncing reads dated. |
| `pulsing-dot` | info | Infinite pulse | One authored moment, finite, reader-controlled; nothing pulses forever. |
| `marquee` | warning | Marquee | Content that moves cannot be read; remove the marquee. |
| `eyebrow-label` | info | Eyebrow above heading | The heading carries its own weight; delete the label above it. |
| `numbered-sections` | info (advisory) | Numbered section labels | Number sections only when the order itself is information. |
| `icon-tile-stack` | info (advisory) | Icon tile above heading | The icon-tile-plus-heading stack is the most recognisable generated pattern; let the heading lead. |
| `buzzword-copy` | info | Marketing buzzwords | Say what the product does in the product's own words. |
| `em-dash-overuse` | info (advisory) | Em-dash cadence | The em-dash cadence is a generator tell; use full stops. |

## `quality` (15)

| Rule | Severity | Name | Guideline |
|------|----------|------|-----------|
| `gray-on-color` | warning | Gray text on a coloured surface | On a coloured surface, tint secondary text from the hue or the foreground; never gray. |
| `low-contrast` | error | Low contrast | Body text ≥ 4.5:1, large text ≥ 3:1 (WCAG AA). |
| `tiny-text` | warning | Tiny text | Body text is at least 12px; 14–16px reads. |
| `tight-leading` | warning | Tight leading | Body line-height 1.4–1.6. |
| `justified-text` | warning | Justified text | Ragged-right; justified text rivers on screens. |
| `all-caps-body` | warning | All-caps body copy | Uppercase is for short labels; body copy keeps its case. |
| `wide-tracking` | info | Wide letter-spacing on body | Tracking opens small caps and labels; body copy runs tight. |
| `skipped-heading` | warning | Skipped heading level | Headings step one level at a time; the outline is the document. |
| `missing-alt` | error | Image without alt | Every image has alt text (empty for decoration). |
| `unlabelled-control` | error | Unlabelled form control | Every control has a visible label or an accessible name. |
| `focus-outline-removed` | error | Focus outline removed | Keyboard focus is always visible; replace the outline, never remove it. |
| `reduced-motion-ignored` | warning | Motion without a reduced-motion path | Every animation has a prefers-reduced-motion alternative that keeps the state change. |
| `small-touch-target` | warning | Small touch target | Interactive targets are at least 44×44 CSS px. |
| `fixed-width-layout` | warning | Fixed pixel width | Layouts flow; use max-width and let the container shrink. |
| `inline-color-literal` | info (advisory) | Colour literal in markup | Colours come from tokens, not from the element. |

## `design-system` (3)

| Rule | Severity | Name | Guideline |
|------|----------|------|-----------|
| `design-system-font` | warning | Font outside the design system | The typefaces in design.md are the typefaces; add a token or use one. |
| `design-system-color` | warning | Colour outside the design system | The palette in design.md is the palette; add a token or use one. |
| `design-system-radius` | info | Radius outside the design system | Radii come from the rounded scale in design.md. |
