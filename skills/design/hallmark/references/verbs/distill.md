# `/design distill` — fewer elements, same meaning

**Edits the target:** yes · **Runs `design_detect` first:** yes · **Mode:** from `--mode` or inferred (see [`../modes.md`](../modes.md))

## Purpose

Remove what does not earn its place: redundant sections, decorative dividers, duplicate calls to action, icons that repeat their label, wrappers that exist only to be styled. The page ends up saying the same thing with less.

## Inputs

- the target
- `product.md` — what must remain is defined there, not by what is easiest to delete

## Steps

1. List every element on the page with the job it does. Anything with no job, or the same job as a neighbour, is a candidate.
2. Remove candidates in order of visual weight; after each removal, check that nothing lost its meaning.
3. Merge near-duplicate components into one; collapse three-card rows that carry one message into one paragraph.
4. Simplify the DOM where it was structure for styling's sake.
5. Re-run `design_detect`; the count is equal or lower.

## Output contract

A list of removals and merges with the reason for each, and a note of anything you kept despite doubting it (with the reason).

## Do not

- Never delete routes, components other pages use, or data — the implementation rail applies; propose file-level deletions and wait.
- Do not remove states (`harden` added them for a reason).
- Do not distill accessibility affordances.

## Related

- `quieter` when the volume, not the count, is the problem
