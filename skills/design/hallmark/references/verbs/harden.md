# `/design harden` — the page survives reality

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Make the interface hold up when the data is not what the mock assumed: nothing, one item, ten thousand items, a 300-character title, right-to-left text, a slow network, an error, a keyboard-only user, a 320px viewport, a 200% zoom.

## Inputs

- the target
- any data shape the code reveals (types, fixtures, API responses)
- a `design_detect` baseline

## Steps

1. List the states each view can be in: empty, loading, partial, error, success, overflow. Find which have no design at all.
2. For each missing state, add the smallest honest treatment in the system's idiom: an empty state that says what to do next, a skeleton that matches the final layout, an error that names the recovery.
3. Stress the layout with long and short content: truncate with intent (`text-overflow`, line clamps with a full-text affordance), never let a label overflow its control.
4. Confirm keyboard reachability and visible focus for every interactive element; add `aria-*` only where semantics are missing, never as decoration.
5. Check `prefers-reduced-motion`, 200% zoom, and the narrowest breakpoint the product supports.
6. Re-run `design_detect`; the count is equal or lower.

## Output contract

A state matrix (view × state → present/added/left) and the list of files changed. Anything you could not add without product input is listed as a question, not guessed.

## Do not

- Do not fabricate empty-state copy that promises a feature; use the product's real next action.
- Do not add loading spinners where a skeleton or nothing is the right answer.
- Do not silently change data handling — flag it if the fix needs code outside the UI.

## Related

- `onboard` for the first-run path specifically
- `adapt` for breakpoints and platform fit
