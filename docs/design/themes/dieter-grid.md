---
version: alpha
name: Concrete Lemon
description: Raw concrete, structural grid, lemon accent.
colors:
  primary: "#1A1A1A"
  secondary: "#6B6B6B"
  tertiary: "#D4E157"
  neutral: "#D9D6D0"
  surface: "#F0EDE6"
  on-primary: "#1A1A1A"
typography:
  display:
    fontFamily: Archivo
    fontSize: 4.5rem
    fontWeight: 800
    letterSpacing: "-0.04em"
  h1:
    fontFamily: Archivo
    fontSize: 2.5rem
    fontWeight: 800
  body:
    fontFamily: Archivo
    fontSize: 0.95rem
    lineHeight: 1.5
  label:
    fontFamily: Archivo Narrow
    fontSize: 0.72rem
    letterSpacing: "0.1em"
rounded:
  sm: 0px
  md: 0px
  lg: 2px
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

Brutalist restraint with a jolt. Concrete greys, hard sans, a single high-visibility lemon for wayfinding.

## Colors

The palette is built around high-contrast neutrals and a single accent that drives interaction.

- **Primary (`#1A1A1A`):** Headlines and core text.
- **Secondary (`#6B6B6B`):** Borders, captions, and metadata.
- **Tertiary (`#D4E157`):** The sole driver for interaction. Reserve it.
- **Neutral (`#D9D6D0`):** The page foundation.

## Typography

- **display:** Archivo 4.5rem
- **h1:** Archivo 2.5rem
- **body:** Archivo 0.95rem
- **label:** Archivo Narrow 0.72rem

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
   - `DESIGN_VARIANCE`: 1 (Strict, mathematical grid layouts; brutalist restraint).
   - `MOTION_INTENSITY`: 1 (Mechanical, near-instant transitions; zero fluff).
   - `VISUAL_DENSITY`: 8 (High information density, structural hierarchy, and functional clarity).

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
