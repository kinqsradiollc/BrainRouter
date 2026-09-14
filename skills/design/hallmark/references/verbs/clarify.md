# `/design clarify` — the next action is obvious

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Fix words, labels, hierarchy, and affordances until a first-time reader knows what the page is, what they can do, and what happens next. Clarify is copy and hierarchy; it does not restyle.

## Inputs

- the target
- `product.md` for vocabulary the product already uses
- any glossary or existing microcopy

## Steps

1. Read the page as a stranger: write down the first three questions it leaves open.
2. Fix heading hierarchy so it answers those questions in order (one h1, real h2s, no styled paragraphs as headings).
3. Rewrite labels as verbs for actions and nouns for things; remove marketing filler and buzzwords from UI copy.
4. Make affordances honest: links look like links, buttons like buttons, disabled means disabled.
5. Add the missing sentence where a control's consequence is not obvious; delete the sentence that repeats the label.
6. Re-run `design_detect`; the count is equal or lower.

## Output contract

Every copy change as a before → after table, plus the heading outline after the change. Reviewers should be able to approve the words without opening the code.

## Do not

- Do not invent claims, numbers, or names.
- Do not change visual style; that is `polish` or the default build.
- Do not rename product concepts without checking `product.md`.

## Related

- `distill` when the problem is too much rather than unclear
- `document` to record the vocabulary you settled
