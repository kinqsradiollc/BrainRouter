# `/design layout` — the skeleton, not the skin

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Fix the macrostructure: the grid, the section order and rhythm, alignment across the page, what goes above the fold. Layout moves and resizes; it does not recolour or rewrite.

## Inputs

- the target
- the mode (a `persuade` page and an `operate` screen have different skeletons)
- `design.md` macrostructure family if present

## Steps

1. Name the current macrostructure honestly (including 'centered hero + three cards + CTA' if that is what it is).
2. Choose the structure the mode and content call for from the skill's macrostructure list; if the page is on a `design.md` project, stay in the declared family.
3. Define the grid (columns, gutters, max width) once and align every section to it.
4. Order sections by the reader's questions; give each a consistent internal rhythm (eyebrow → heading → body → action).
5. Put the first action above the fold at the primary breakpoint.
6. Re-run `design_detect`; the count is equal or lower.

## Output contract

Before/after section outline, the grid definition, and the stamp updated with the macrostructure name.

## Do not

- Do not change copy beyond moving it.
- Do not add sections the brief did not supply.
- Do not use the AI-template structure as the 'safe' choice.

## Related

- `adapt` for breakpoints
- `shape` to decide the concept before laying it out
