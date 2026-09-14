# `/design adapt` — fit the device it is on

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Make the interface right for each viewport and platform it actually ships on: breakpoints that follow the content, touch targets on touch, density that matches the input, safe areas respected.

## Inputs

- the target
- the breakpoints and platforms the product supports (from the code or `design.md`; ask once if absent)

## Steps

1. Establish the supported range and the primary device per mode (`operate` is usually desktop-first, `persuade` mobile-first).
2. Let content set breakpoints: reflow where a line or a grid breaks, not at a device list.
3. On touch: ≥ 44px targets, no hover-only affordances, gestures with visible alternatives.
4. On desktop: keyboard paths, pointer precision, denser tables allowed.
5. Respect platform conventions (safe-area insets, system fonts where the product uses them, native scroll).
6. Re-run `design_detect`; the count is equal or lower.

## Output contract

A breakpoint map (range → layout) and the changes per range. Screenshots or a described walk-through at the narrowest and widest supported sizes.

## Do not

- Do not add a mobile 'version' — one layout that reflows.
- Do not hide primary actions behind a hamburger when they fit.
- Do not change the type scale per breakpoint more than one step.

## Related

- `layout` for the grid itself
- `harden` for overflow and zoom
