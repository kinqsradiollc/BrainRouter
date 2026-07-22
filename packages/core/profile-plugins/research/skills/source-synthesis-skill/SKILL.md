---
name: source-synthesis-skill
description: Combine a set of sources into a concise, provenance-preserving synthesis that exposes agreement, conflict, and gaps.
allowed-tools: [read_file, grep_search, glob_files, fetch_url, research_note, research_brief, write_file, edit_file]
---

# Source synthesis

## Overview

Synthesis is not concatenated summaries. It groups evidence around the question,
weighs source strength, and makes consensus, disagreement, and missing evidence
easy to inspect.

## When to Use

Use after evidence gathering, when consolidating documents, comparing proposals,
preparing a briefing, or turning research notes into a decision-ready artifact.

## Workflow

1. Normalize each source into its scope, method, date, claims, evidence, and
   limitations. Exclude material that cannot support the target question.
2. Cluster claims by theme or decision criterion rather than by source order.
3. Within each cluster, identify agreement, direct contradiction, different
   assumptions, and evidence that is merely complementary.
4. Weight claims by relevance and source quality. Preserve minority evidence
   when it is credible; do not manufacture consensus.
5. Draft the synthesis with citations beside each supported claim and label any
   cross-source inference as analysis.
6. Close with confidence by conclusion, unresolved gaps, and what evidence
   would most efficiently change the result.

## Verification

- [ ] The structure follows themes or decisions, not a source-by-source list.
- [ ] Every material conclusion preserves provenance.
- [ ] Disagreement and incompatible assumptions are visible.
- [ ] Gaps and inference are clearly labelled.

## Red Flags

- One paragraph per source with no cross-source reasoning.
- Removing a credible outlier because it complicates the conclusion.
- A confident recommendation built on unmarked inference.
