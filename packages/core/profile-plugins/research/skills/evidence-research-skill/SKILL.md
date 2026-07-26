---
name: evidence-research-skill
description: Collect bounded, relevant evidence for an approved research question and source strategy without drafting conclusions.
allowed-tools: [read_file, grep_search, glob_files, fetch_url, web_search, research_note]
---

# Evidence research

## Overview

Evidence collection turns an approved question and source strategy into
traceable observations. It preserves source identity, scope, dates, and
limitations without prematurely drafting the final answer.

## When to Use

Use after the question and search plan are clear, when the task is to retrieve,
inspect, and record material that may support or refute candidate claims.

## Workflow

1. Confirm the approved question, sub-question, source scope, and stopping
   condition. Return to planning if any of these are missing.
2. Retrieve small result sets with short semantic questions or precise literal
   queries. Use the retrieval mode that matches the information need.
3. Deduplicate overlapping results, expand context around promising passages,
   and prefer direct source material over generated summaries.
4. Record each useful observation with its source identifier or URL, location,
   publication and event dates when relevant, and the exact scope it supports.
5. Record contradictory, null, and low-confidence evidence as deliberately as
   supporting evidence. Mark inference separately from observed source content.
6. Stop at the agreed evidence threshold or report the exact access or evidence
   gap. Hand the observations to claim tracking; do not synthesize conclusions.

## Verification

- [ ] Every retained observation has stable provenance and enough local context.
- [ ] Retrieval queries match semantic versus literal lookup needs.
- [ ] Duplicates, weak matches, and generated summaries are not counted as independent evidence.
- [ ] Contrary evidence, dates, limitations, and access gaps are preserved.

## Red Flags

- Writing the conclusion while evidence is still being collected.
- Treating a rerank score as proof that a passage supports the claim.
- Recording a result without enough source identity to inspect it again.
