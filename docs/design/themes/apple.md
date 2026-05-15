---
version: alpha
name: Apple
description: Premium white space. SF Pro. Cinematic imagery.
colors:
  primary: "#1D1D1F"
  secondary: "#6E6E73"
  tertiary: "#0071E3"
  neutral: "#F5F5F7"
  surface: "#FFFFFF"
  on-primary: "#FFFFFF"
typography:
  display:
    fontFamily: Inter
    fontSize: 5rem
    fontWeight: 600
    letterSpacing: "-0.035em"
  h1:
    fontFamily: Inter
    fontSize: 2.6rem
    fontWeight: 600
  body:
    fontFamily: Inter
    fontSize: 1rem
    lineHeight: 1.5
  label:
    fontFamily: Inter
    fontSize: 0.82rem
    fontWeight: 500
    letterSpacing: "0"
rounded:
  sm: 8px
  md: 12px
  lg: 20px
spacing:
  sm: 8px
  md: 16px
  lg: 32px
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: 12px 20px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.lg}"
    padding: 24px
---
## Overview

Apple: premium white space, SF-Pro-style tight sans, cinematic full-bleed imagery, near-zero chrome.

## Colors

The palette is built around high-contrast neutrals and a single accent that drives interaction.

- **Primary (`#1D1D1F`):** Headlines and core text.
- **Secondary (`#6E6E73`):** Borders, captions, and metadata.
- **Tertiary (`#0071E3`):** The sole driver for interaction. Reserve it.
- **Neutral (`#F5F5F7`):** The page foundation.

## Typography

- **display:** Inter 5rem
- **h1:** Inter 2.6rem
- **body:** Inter 1rem
- **label:** Inter 0.82rem

## Do's and Don'ts

- **Do** use Tertiary for exactly one action per screen.
- **Do** let Neutral carry the composition — negative space is a feature.
- **Don't** introduce gradients. This system is flat on purpose.
- **Don't** mix Tertiary with alternate accents; the single-accent rule is load-bearing.

## AI Agent Instructions: Taste Skill Integration

When generating code or designing interfaces based on this system, the AI Agent **MUST** also apply the advanced frontend engineering principles defined in the Taste Skill framework.

1. **Apply the Skill:** Read and follow the directives outlined in `../../skills/design/taste-skill/SKILL.md` (or the equivalent `design-taste-frontend` skill).
2. **Merge Logic:**
   - Use the **Colors**, **Typography**, and **Spacing** defined in this `Design.md` document as your absolute source of truth for all design tokens.
   - Use the **Taste Skill** directives for layout engineering, motion (e.g., Framer Motion), anti-slop bias correction, and modern component architecture.
3. **Active Baseline Configuration for this Design:**
   - `DESIGN_VARIANCE`: 2 (Enforce strict, symmetrical Apple-style grids and cinematic full-bleed imagery).
   - `MOTION_INTENSITY`: 3 (Slow, cinematic spring physics with high-quality eases).
   - `VISUAL_DENSITY`: 2 (Extremely airy and spacious, maximum negative space).

### Available Taste Skill Modules
The following modules are available in `../../skills/design/`. The AI should refer to the corresponding `SKILL.md` files when specific stylistic variations or task optimizations are needed:
- **`taste-skill`**: The main design skill for premium frontend code. Covers layout, typography, colors, spacing, and motion.
- **`gpt-taste`**: Elite Awwwards-level frontend design and GSAP motion skill for premium, deterministic, anti-slop UI generation.
- **`soft-skill`**: Focuses on an expensive, soft UI look with premium fonts, whitespace, depth, and smooth animations.
- **`minimalist-skill`**: Enforces clean, editorial-style interfaces (Notion/Linear style) with strict monochrome palettes.
- **`brutalist-skill`**: Raw mechanical interfaces, Swiss typography, extreme scale contrast.
- **`redesign-skill`**: For upgrading existing projects by auditing and fixing design problems.
- **`output-skill`**: Prevents AI from being lazy, skipping code blocks, or using placeholder comments.
- **`stitch-skill`**: Google Stitch-compatible semantic design rules for premium AI UI generation.
- **`concept-diagrams`**: Unified visual language for creating minimal, SVG-based architecture and concept diagrams.
