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

The critique is **two assessments that cannot see each other** (ADR-056 D-B4). BrainRouter's
`/design critique` runs them for you: the design review below runs first as an isolated
subagent; the detector evidence pass runs only after the review has ended; both reach a
synthesis step. If you are running without that orchestration, the first line of your output
must say `Degraded critique:` and you write the review BEFORE you run the detector.

**Review half** (no detector output in sight):

1. Read `product.md` and `design.md` when they exist; if neither exists, state the purpose you inferred in one line and judge against that.
2. Look at the target as a user would: first screen, first action, what a keyboard-only reader meets, what an empty state looks like.
3. Write the **fit** verdict: 3–6 bullets, each anchored to a file and line range or a screen region, each naming the purpose it serves or fails.
4. Write the **craft** verdict — hierarchy, clarity, emotional resonance, rhythm, type, colour roles, states — again anchored.
5. End the review with exactly one JSON line of heuristic scores, 1–10 each: `{"hierarchy": n, "clarity": n, "resonance": n}`.

**Evidence half** (deterministic, run after the review ends): `design_detect` over the target; every finding is verified in context and false positives are dropped with a reason.

**Synthesis**: rank the top three fixes by user impact, one line each, say what you would leave alone and why, show the trend against the previous critique of the same target when one exists, and **end with the targeted questions for the owner — nothing after them**.

## Output contract

`Critique · fit: strong|adequate|weak · craft: strong|adequate|weak` on the first line (after the degraded banner if there is one), then the two verdicts, the evidence, the ranked fixes, the trend line, and the targeted questions last. Nothing is edited. Each run is snapshotted under `.brainrouter/design/critiques/<slug>/` so the next one can show the trend.

## Do not

- Do not edit, rename, or 'quickly fix' anything — hand the fixes to `polish`, `harden`, or `clarify`.
- Do not invent user research; if fit cannot be judged without knowing the audience, say so and ask once.
- Do not count style preferences as craft defects.

## Related

- `audit` for the anti-pattern punch list alone
- `../anti-patterns.md`, `../slop-test.md`
