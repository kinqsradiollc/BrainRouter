---
name: citation-verification-skill
description: Verify that every material citation resolves, supports its adjacent claim, preserves scope, and is not stale or misleading.
allowed-tools: [read_file, grep_search, glob_files, fetch_url, web_search, research_note]
---

# Citation verification

## Overview

Citation verification is a separate quality gate. A citation is valid only when
it resolves to the intended source and the cited passage actually supports the
nearby claim at the stated scope, date, and confidence.

## When to Use

Use after drafting a sourced answer or report and before delivery, especially
for consequential, quoted, numerical, comparative, or time-sensitive claims.

## Workflow

1. Enumerate every citation anchor and the exact claim it is meant to support.
   Flag material uncited claims before checking source links.
2. Resolve each anchor to a stable source and inspect the original passage,
   table, or data rather than a search snippet or second-hand summary.
3. Check entailment: the source must support the claim's subject, magnitude,
   population, time range, and certainty. Split or narrow claims that overreach.
4. Check provenance and independence. Detect citations that point to the same
   underlying source, circular references, or generated material presented as
   primary evidence.
5. Check freshness and accessibility. Record missing, moved, paywalled, stale,
   or partially available evidence without fabricating a replacement.
6. Produce a citation audit with verified, corrected, unsupported, and
   unresolved items. Return unsupported claims to the ledger or remove them.

## Verification

- [ ] Every material claim has an adjacent, resolvable citation or is labelled inference.
- [ ] Each cited passage entails the claim at its actual scope and date.
- [ ] Independent support is genuinely independent.
- [ ] Broken, stale, inaccessible, or weak citations are visible.

## Red Flags

- A valid URL treated as proof of claim support.
- A citation placed at paragraph end with no clear claim mapping.
- Repairing an unsupported claim by searching only for agreement.
