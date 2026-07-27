---
name: research-review-skill
description: Review a completed research artifact for question coverage, evidence quality, citation integrity, uncertainty, and decision usefulness.
allowed-tools: [read_file, list_dir, grep_search, glob_files, fetch_url, web_search, research_note, research_brief]
---

# Research review

## Overview

Research review evaluates the whole chain from the approved question through
the claim ledger to the delivered synthesis. It is a release gate, not another
round of unbounded investigation.

## When to Use

Use before delivering a consequential report, after material evidence changes,
or when deciding whether the current evidence is sufficient to stop.

## Workflow

1. Compare the artifact with the approved primary question, sub-questions,
   decision target, exclusions, and output contract. Identify scope drift.
2. Trace every material conclusion back to the claim ledger and verified
   citations. Sample lower-impact claims and inspect all high-impact claims.
3. Assess source fit, independence, freshness, contradictions, missing
   perspectives, and whether confidence language matches the evidence.
4. Check that facts, source interpretations, and analyst inferences are labelled
   and that uncertainty is specific enough to affect the user's decision.
5. Classify findings as blocking, material but non-blocking, or optional. Do not
   reopen research for stylistic preferences or low-value completeness.
6. Approve delivery, request a bounded correction, or name the exact evidence
   gap and access needed. Preserve the stopping condition.

## Verification

- [ ] The approved question and output contract are fully addressed.
- [ ] Material conclusions trace to reviewed claims and verified citations.
- [ ] Confidence, conflicts, limitations, and gaps are decision-relevant.
- [ ] Any requested follow-up is bounded and prioritized.

## Red Flags

- Treating length or citation count as research quality.
- Reopening collection without naming the decision-changing gap.
- Hiding a blocking evidence problem inside general editorial feedback.
