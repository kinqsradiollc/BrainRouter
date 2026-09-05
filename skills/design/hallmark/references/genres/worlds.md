# Worlds — the one skill's routing table

Hallmark is the single visual-craft skill. It does not carry every aesthetic
inside its own body; it *routes* to a world when a brief, a `design.md`, or an
explicit `--world` names one. A world is a bounded ruleset for look and feel
(type, colour, density, motion, ornament). The verbs, the modes, the slop
test, and the output contract are Hallmark's and apply in every world.

## Native genres (in this folder)

| World | File | Use when |
| --- | --- | --- |
| `editorial` (default) | `editorial.md` | long-form, marketing that reads like a magazine, most briefs |
| `modern-minimal` | `modern-minimal.md` | products, tools, anything operating |
| `atmospheric` | `atmospheric.md` | launches, showcases, `experience` mode |
| `playful` | `playful.md` | consumer, education, community |

## Library worlds (skills that were once picked by hand)

These live under `skills/design/<id>/SKILL.md` and remain readable on their
own, but a user no longer has to choose between them: Hallmark loads one as a
world when it fits, and says so in the stamp (`world: <id>`).

| World id | Character | Route to it when |
| --- | --- | --- |
| `brutalist-skill` | raw grid, mono type, terminal cues, hard edges | the brief says brutalist, raw, industrial, or the product is a developer tool that wants an edge |
| `minimalist-skill` | warm monochrome, flat bento, typographic contrast | the brief says minimal, calm, editorial-product; `quieter` on a loud page |
| `soft-skill` | agency polish — soft shadows, layered cards, generous radius | consumer SaaS, marketing for a friendly product |
| `gpt-tasteskill` | motion-forward, randomised layout variance, GSAP-grade sequencing | `animate` in `experience` mode; a showcase that lives on motion |
| `taste-skill` | metric-driven senior-engineer defaults that override model habits | a default build with no brief on aesthetics; `polish` when nothing else is named |
| `stitch-skill` | emits a semantic `DESIGN.md` for other tools to consume | `document` when the output must be handed to an external design tool |
| `redesign-skill` | audit-then-upgrade of an existing site toward premium | `hallmark redesign` on a site that already exists; never on a blank page |

## Routing rules

1. `design.md` wins. If it names a world (`world:` in its frontmatter or a
   stamp on an existing page), use it and do not rotate.
2. An explicit `--world <id>` wins over inference.
3. Otherwise infer from the mode: `operate` → `modern-minimal`, `read` →
   `editorial`, `experience` → `atmospheric`, `persuade` → rotate per the
   diversification rule.
4. Load exactly one world per run. Two worlds in one page is the tell the
   audit calls `mixed worlds`.
5. A world never overrides a discipline: honest copy, contrast, focus,
   reduced motion, and the no-deletion rail hold in all of them.
