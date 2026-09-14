# `/design quieter` — lower the volume

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Calm a page that shouts: fewer accents, more air, smaller and fewer emphasised elements, gentler surfaces, less motion. The hierarchy survives; the noise goes.

## Inputs

- the target
- `design.md` if present

## Steps

1. Count the accents on screen; reduce to one per view (status colours excepted in `operate`).
2. Replace decorative gradients, glows, and heavy shadows with flat surfaces and hairline borders in the system's neutrals.
3. Add space before adding anything else: section rhythm, paragraph measure, card padding.
4. Reduce motion to entrances and state changes; remove ambient animation.
5. Lower type contrast one step where headings are oversized for their content.
6. Re-run `design_detect`; the count is equal or lower.

## Output contract

Counts before and after (accents, animated elements, shadow styles), and the spacing scale you settled on.

## Do not

- Do not remove hierarchy — quieter is not flat.
- Do not lower text contrast below AA.
- Do not delete content; that is `distill`.

## Related

- `bolder` is its inverse
- `../genres/modern-minimal.md`
