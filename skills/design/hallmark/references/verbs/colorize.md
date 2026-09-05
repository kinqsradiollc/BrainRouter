# `/design colorize` — roles, not swatches

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Set colour as a system of roles — paper, ink, muted, one accent, semantic status colours — with contrast that passes, dark mode where the product has one, and tokens instead of hex literals scattered through the code.

## Inputs

- the target
- `design.md` colour roles if present
- brand constraints the user supplies

## Steps

1. Inventory every colour literal in the target; map each to a role or mark it as stray.
2. Define the roles (paper, ink, muted ink, surface, border, accent, accent-ink, success/warning/danger) with values that pass AA for their use.
3. Replace literals with role tokens; delete strays.
4. Use the accent for one job (the primary action, or status in `operate`) and neutrals for everything else.
5. If dark mode exists, derive it from the same roles — never a second unrelated palette.
6. Re-run `design_detect`; the count is equal or lower; check every text/background pair you changed.

## Output contract

The role table with values and contrast ratios, the count of literals replaced, and the files changed.

## Do not

- Do not introduce gradients or glows.
- Do not use pure black on pure white for long text.
- Do not add a colour per feature.

## Related

- `quieter` when there are too many accents
- `../custom-theme.md` § paper and accent
