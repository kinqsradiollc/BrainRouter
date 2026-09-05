# `/design critique` — two verdicts, no edits

**Edits the target:** no · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Assess a finished or half-finished interface on two separate axes and keep them separate: **fit** — does it do what its purpose says, for the people it names — and **craft** — is it well made. A page can be beautifully built for the wrong job; a critique that blends the two hides that.

## Inputs

- the target (files, a route, or a screenshot)
- `product.md` if present — the fit axis is judged against it, not against taste
- `design.md` if present — the craft axis is judged against the declared system
- the `design_detect` findings for the target, run first

## Steps

1. Read `product.md` and `design.md` when they exist; if neither exists, state the purpose you inferred in one line and judge against that.
2. Run `design_detect` on the target. Its findings are the deterministic half; verify each in context and drop false positives with a reason.
3. Look at the target as a user would: first screen, first action, what a keyboard-only reader meets, what an empty state looks like.
4. Write the **fit** verdict: 3–6 bullets, each anchored to a file and line range or a screen region, each naming the purpose it serves or fails.
5. Write the **craft** verdict: hierarchy, rhythm, type, colour roles, states, tells from `anti-patterns.md` — again anchored.
6. Rank the top three fixes by user impact, one line each. Say what you would leave alone and why.

## Output contract

`Critique · fit: strong|adequate|weak · craft: strong|adequate|weak` on the first line, then the two verdicts, then the ranked fixes. Nothing is edited.

## Do not

- Do not edit, rename, or 'quickly fix' anything — hand the fixes to `polish`, `harden`, or `clarify`.
- Do not invent user research; if fit cannot be judged without knowing the audience, say so and ask once.
- Do not count style preferences as craft defects.

## Related

- `audit` for the anti-pattern punch list alone
- `../anti-patterns.md`, `../slop-test.md`
