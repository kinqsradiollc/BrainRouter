# `/design document` — design.md from what the code does

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Write or update `design.md` so it describes the system the code actually implements — tokens, type roles, colour roles, spacing scale, components, rules — in the frontmatter shape the detector reads. Document records; it does not redesign.

## Inputs

- the target codebase
- the existing `design.md` if any
- `product.md` for the tone the system serves

## Steps

1. Extract the tokens the code uses (custom properties, theme files, config) and reconcile them with any existing `design.md`; differences are listed, not silently resolved.
2. Write the YAML frontmatter the detector consumes (`fonts`, `colors`, `spacing`, `radii`, `world`) from the reconciled values.
3. Write the prose: principles in five lines, then one section per role group with examples that exist in the code.
4. Add the rules the team already follows implicitly (one accent, no gradients, measure) as explicit sentences.
5. Run `design_detect` with the new file present; every finding it now raises is either a real drift to fix or a token to correct — resolve each.

## Output contract

The `design.md` file, a list of drifts found between code and document, and the detector count before/after the document existed.

## Do not

- Do not describe a system the code does not have; write the drift down instead.
- Do not copy another project's design.md.
- Do not put secrets, vendor names, or planning-doc references in it.

## Related

- `product` for the sibling file
- `../custom-theme.md`, `../design-md-emit.md` if present
