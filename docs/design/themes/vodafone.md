---
version: alpha
name: Vodafone
description: Monumental uppercase display. Vodafone-red chapter bands.
colors:
  primary: "#0D0D0D"
  secondary: "#6D6D6D"
  tertiary: "#E60000"
  neutral: "#F4F4F4"
  surface: "#FFFFFF"
  on-primary: "#FFFFFF"
typography:
  display:
    fontFamily: Archivo Black
    fontSize: 6rem
    fontWeight: 900
    letterSpacing: "-0.025em"
  h1:
    fontFamily: Archivo Black
    fontSize: 2.8rem
    fontWeight: 900
  body:
    fontFamily: Inter
    fontSize: 1rem
    lineHeight: 1.6
  label:
    fontFamily: Inter
    fontSize: 0.74rem
    fontWeight: 700
    letterSpacing: "0.1em"
rounded:
  sm: 2px
  md: 4px
  lg: 6px
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

Vodafone: monumental all-caps display, saturated red chapter bands on white, uncompromising sans.

## Colors

The palette is built around high-contrast neutrals and a single accent that drives interaction.

- **Primary (`#0D0D0D`):** Headlines and core text.
- **Secondary (`#6D6D6D`):** Borders, captions, and metadata.
- **Tertiary (`#E60000`):** The sole driver for interaction. Reserve it.
- **Neutral (`#F4F4F4`):** The page foundation.

## Typography

- **display:** Archivo Black 6rem
- **h1:** Archivo Black 2.8rem
- **body:** Inter 1rem
- **label:** Inter 0.74rem

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
   - `DESIGN_VARIANCE`: 4 (Structured, monumental layouts with bold chapter bands).
   - `MOTION_INTENSITY`: 7 (Snappy, fast transitions to match the bold, high-energy brand).
   - `VISUAL_DENSITY`: 6 (High impact, large typography, and moderate information density).

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
