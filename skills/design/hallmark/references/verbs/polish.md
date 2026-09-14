# `/design polish` — the last five percent

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Finish an interface that already works: spacing, alignment, optical balance, type detail, hover/focus/active states, icon weight, corner radii, border and shadow consistency. Polish changes how the page feels, never what it does.

## Inputs

- the target files
- `design.md` tokens if present — polish moves values *toward* tokens, never away
- a `design_detect` baseline

## Steps

1. Run `design_detect` and note the count; polish must not raise it.
2. Walk the page top to bottom at the real breakpoints and list every inconsistency you can point at: a 12px gap next to a 16px one, a heading that hugs its paragraph, a button whose focus ring is missing, mismatched radii, a divider one shade off.
3. Fix each in place with the existing scale or token. Where a value has no token and the same value appears three or more times, introduce one token rather than three literals.
4. Give every interactive element its four states (default, hover, focus-visible, active/disabled) using the system's own idiom.
5. Re-run `design_detect`; the count is equal or lower. Re-check contrast on anything you recoloured.

## Output contract

A short list of what was touched, grouped by kind (spacing / type / states / surfaces), plus the before→after detector counts. If a stamp exists, leave it; append `polished` to it.

## Do not

- Do not restructure sections, change copy, or add components — that is `layout`, `clarify`, or the default build.
- Do not introduce a new colour, font, or shadow style; polish uses what the system already has.
- Do not touch behaviour or data.

## Related

- `harden` for edge cases
- `typeset` when the type scale itself is the problem
