---
version: alpha
name: Gallery White
description: Contemporary gallery: nothing on the walls but art.
colors:
  primary: "#1C1C1B"
  secondary: "#8F8F8D"
  tertiary: "#595957"
  neutral: "#F9F9F7"
  surface: "#FFFFFF"
  on-primary: "#FFFFFF"
typography:
  display:
    fontFamily: Cormorant Garamond
    fontSize: 5.5rem
    fontWeight: 300
    letterSpacing: "-0.02em"
  h1:
    fontFamily: Cormorant Garamond
    fontSize: 3rem
    fontWeight: 300
  body:
    fontFamily: Inter
    fontSize: 0.95rem
    lineHeight: 1.65
  label:
    fontFamily: Inter
    fontSize: 0.7rem
    letterSpacing: "0.14em"
rounded:
  sm: 0px
  md: 0px
  lg: 0px
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

Maximum whitespace. Near-white surface, thin rules, a single charcoal for typography. Built for portfolios.

## Colors

The palette is built around high-contrast neutrals and a single accent that drives interaction.

- **Primary (`#1C1C1B`):** Headlines and core text.
- **Secondary (`#8F8F8D`):** Borders, captions, and metadata.
- **Tertiary (`#595957`):** The sole driver for interaction. Reserve it.
- **Neutral (`#F9F9F7`):** The page foundation.

## Typography

- **display:** Cormorant Garamond 5.5rem
- **h1:** Cormorant Garamond 3rem
- **body:** Inter 0.95rem
- **label:** Inter 0.7rem

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
   - `DESIGN_VARIANCE`: 9 (Artistic, unexpected layouts with varying scales and asymmetric compositions).
   - `MOTION_INTENSITY`: 4 (Smooth, elegant fades and subtle transitions).
   - `VISUAL_DENSITY`: 1 (Maximum whitespace, focus on one element at a time; contemporary gallery feel).

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
