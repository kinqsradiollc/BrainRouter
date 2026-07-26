---
name: source-synthesis-skill
description: Turn a reviewed claim ledger into a provenance-preserving synthesis that exposes agreement, conflict, inference, and gaps.
allowed-tools: [read_file, grep_search, glob_files, research_note, research_brief, write_file, edit_file]
---

# Source synthesis

## Overview

Synthesis is not concatenated summaries. It groups evidence around the question,
weighs source strength, and makes consensus, disagreement, and missing evidence
easy to inspect.

## When to Use

Use only after evidence has been normalized into a claim ledger, when preparing
a briefing, comparison, report, or decision-ready answer.

## Workflow

1. Confirm the ledger covers the approved question and that material claims
   identify support, contradiction, uncertainty, and source provenance.
2. Cluster claims by sub-question or decision criterion, never by source order.
3. Within each cluster, distinguish agreement, direct contradiction, different
   assumptions, complementary evidence, and analyst inference.
4. Weight conclusions by relevance and evidence quality. Preserve credible
   minority evidence and do not convert missing evidence into consensus.
5. Draft from the ledger, placing citation anchors beside the claims they
   support and keeping source fact separate from analysis.
6. Close with conclusion-level confidence, unresolved conflicts, and the
   smallest next evidence probe that could materially change the answer.

## Verification

- [ ] The structure follows themes or decisions, not a source-by-source list.
- [ ] Every material conclusion preserves provenance.
- [ ] Disagreement and incompatible assumptions are visible.
- [ ] Gaps and inference are clearly labelled.

## Red Flags

- One paragraph per source with no cross-source reasoning.
- Removing a credible outlier because it complicates the conclusion.
- A confident recommendation built on unmarked inference.
