# `/design optimize` — perceived performance

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Make the interface feel fast: no layout shift, skeletons that match the final layout, images and fonts that load without flashing, motion that costs nothing on the main thread.

## Inputs

- the target
- the asset pipeline as the code shows it

## Steps

1. Reserve space for everything that loads later (aspect ratios, min-heights on dynamic regions) so nothing shifts.
2. Give every image explicit dimensions, `loading="lazy"` below the fold, and a modern format where the pipeline allows.
3. Load fonts with `font-display: swap` or `optional` and a metric-compatible fallback; subset if the pipeline supports it.
4. Replace layout-affecting animations with transform/opacity; honour `prefers-reduced-motion`.
5. Defer non-critical UI (below-the-fold sections, heavy widgets) with a matching skeleton.
6. Re-run `design_detect`; the count is equal or lower.

## Output contract

A before/after list of shift sources removed, assets given dimensions, fonts given fallbacks, animations moved off layout. Numbers only where you measured them.

## Do not

- Do not quote performance figures you did not measure.
- Do not remove content to 'speed it up'.
- Do not swap the font stack for a system stack unless the design allows it.

## Related

- `animate` for motion design
- `adapt` for viewport-specific loading
