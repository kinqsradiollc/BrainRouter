# `/design product` — who it is for, what it must do

**Edits the target:** yes · **Runs `design_detect` first:** no · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Write or refresh `product.md`: who the product serves, what it must let them do, what it must never do, the vocabulary it uses, and how it wants to feel. Every other verb reads it; `critique` judges fit against it.

## Inputs

- the codebase, README, and any brief
- the existing `product.md` if any
- one round of questions to the user where the code cannot answer

## Steps

1. Draft the five sections: audience, jobs to be done (ranked), non-goals, vocabulary, feel. Keep each to a screen.
2. Fill from evidence first (routes, features, copy already in the product); mark anything inferred with `(inferred)`.
3. Ask the user once, in a single message, for the gaps that matter most; do not block on the rest.
4. Write the file; keep it free of metrics you cannot source.
5. If `design.md` exists, check that its tone line agrees with `feel`; note any disagreement for the user.

## Output contract

The `product.md` file and the list of `(inferred)` items still to confirm.

## Do not

- Do not invent users, quotes, or numbers.
- Do not turn it into a roadmap.
- Do not write it for BrainRouter itself — this skill governs the user's project.

## Related

- `document` for the design counterpart
- `shape` uses both
