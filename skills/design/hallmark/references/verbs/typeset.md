# `/design typeset` — a type system, not one-offs

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Set the typography as a system: pairing, scale, measure, leading, rhythm, tabular numerals where numbers align, and tokens instead of ad-hoc sizes. Typeset changes only type and the spacing that serves it.

## Inputs

- the target
- `design.md` type roles if present — typeset conforms to them or proposes the amendment explicitly

## Steps

1. Inventory every font-size / line-height / weight in use; collapse to a scale of five to seven steps.
2. Choose (or keep) one display and one body family; add mono only where code or tabular data needs it.
3. Set measure to 60–75 characters for reading text; allow narrower in `operate`.
4. Set leading by role (tighter display, looser body), and a vertical rhythm the spacing scale shares.
5. Enable `font-variant-numeric: tabular-nums` where numbers stack; `text-wrap: balance` on headings where supported.
6. Express the result as tokens (CSS custom properties or the project's equivalent) and replace literals with them.
7. Re-run `design_detect`; the count is equal or lower.

## Output contract

The scale as a table (role → size / leading / weight / family), the families with fallbacks, and the files changed. If `design.md` exists and you changed a role, the amendment is written there too.

## Do not

- Do not pick a font from the overused list unless `design.md` already names it.
- Do not exceed two families plus mono.
- Do not restyle colour or layout.

## Related

- `document` to write the tokens into `design.md`
- `../custom-theme.md` for type pairing rules
