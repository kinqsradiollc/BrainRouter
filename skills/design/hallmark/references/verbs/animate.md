# `/design animate` — motion with a job

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Add or fix motion so that every animation explains a change: entrance, exit, state, or spatial relation. Nothing loops for decoration; everything respects reduced motion.

## Inputs

- the target
- the mode (`experience` allows atmosphere; `operate` allows almost none)

## Steps

1. List every animated element and the change it explains; remove the ones that explain nothing.
2. Standardise durations and easings as tokens (fast/normal/slow; enter/exit curves).
3. Animate transform and opacity only; never layout properties.
4. Add `@media (prefers-reduced-motion: reduce)` that removes or shortens every motion.
5. In `experience` mode, one signature moment is allowed; it must degrade to a static composition.
6. Re-run `design_detect`; the count is equal or lower.

## Output contract

The motion inventory (element → change explained → duration/easing) and the reduced-motion fallback per item.

## Do not

- Do not add scroll-jacking, parallax on content, or ambient loops.
- Do not animate text into place letter by letter.
- Do not exceed 300ms for interface transitions.

## Related

- `optimize` for the cost side of motion
- `../genres/atmospheric.md`
