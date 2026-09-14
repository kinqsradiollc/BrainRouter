# `/design onboard` — first run teaches by doing

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Design the zero-data and first-run path: what a new user sees before anything exists, and how the interface leads them to their first success without a tour overlay.

## Inputs

- the target
- `product.md` — the first success it names is the goal of onboarding
- existing empty states

## Steps

1. Name the first success in one sentence (from `product.md` or ask once). Everything on the first run points at it.
2. Design the empty state of each primary view as a *doing* state: the primary action is in the empty space, with one line of why.
3. Replace tours, coach marks, and modal walkthroughs with inline affordances that disappear once used.
4. Provide a sample or template path only if the product has one; never seed fake data that looks real.
5. Make the first action reversible and the result visible immediately.
6. Re-run `design_detect`; the count is equal or lower.

## Output contract

The first-run path as a numbered sequence (screen → action → result), the files changed, and the copy you added — all copy is listed so it can be reviewed as words.

## Do not

- Do not add a tooltip tour.
- Do not invent metrics or testimonials on a welcome screen.
- Do not gate the first success behind account setup unless the product requires it.

## Related

- `harden` for the other states
- `clarify` for copy across the whole product
