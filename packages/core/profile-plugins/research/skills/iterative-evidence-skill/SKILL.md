---
name: iterative-evidence-skill
description: Continue a bounded research task from prior findings, ground it in available project context, and issue only non-duplicate probes for material evidence gaps.
allowed-tools: [read_file, grep_search, glob_files, knowledge_list, knowledge_search, fetch_url, web_search, research_note, research_brief]
---

# Iterative evidence

## Overview

Iterative evidence work continues from what is already known instead of
restarting search on every turn. It keeps a task-local question, query, source,
and claim ledger; grounds first in user-provided, workspace, and available
Project Knowledge material; and expands only unresolved, decision-changing gaps.

This workflow does not create a new memory store. Use existing research notes
and briefs for continuity, and treat every retrieved passage as evidence that
still requires provenance and claim review.

## When to Use

Use after the research question is bounded, when evidence must be gathered or
continued across several source classes, or before assigning independent
external evidence questions to explorer children.

## Workflow

1. Restore the current task state: original question, reviewed sub-questions,
   prior queries, retained sources and claims, contradictions, unresolved gaps,
   evidence threshold, and remaining budget. If no prior state exists, create a
   compact task-local ledger without inventing findings.
2. Inspect user-provided and workspace material first. When `knowledge_list`
   and `knowledge_search` are both available under effective tool policy and
   the current project is linked, search Project Knowledge for the unresolved
   gaps. Missing, signed-out, unlinked, empty, or unavailable Project Knowledge
   is non-fatal; never ingest content implicitly.
3. Rank gaps by their ability to change the answer or confidence. For one
   cycle, create at most three focused probes that do not duplicate a prior
   query, source lookup, or semantically equivalent question. Add an explicit
   no-repeat instruction to every probe.
4. Route each probe to the best available source class: project or local
   material, primary or academic sources, official technical documentation, or
   broader web material. Prefer direct support and source fit over popularity
   or citation count. Unknown source quality remains unknown.
5. Record useful and contrary observations with source identity, location,
   dates, scope, limitations, and whether the statement is observed or inferred.
   Update claims, conflicts, confidence, the prior-query ledger, and remaining
   gaps without silently replacing earlier evidence.
6. Run no more than three cycles in one task. Stop earlier when the evidence
   threshold is met, no remaining gap could materially change the answer, the
   next probe would repeat prior work, access is blocked, or the user or budget
   limit is reached. Return the smallest unresolved gap and suitable independent
   assignments; do not grant Project Knowledge access to explorer children.

## Verification

- [ ] Prior findings and queries were restored before issuing new probes.
- [ ] Each cycle used no more than three non-duplicate, gap-driven probes.
- [ ] Available project/local evidence was checked before external expansion.
- [ ] Project Knowledge absence remained non-fatal and no ingestion was implied.
- [ ] Provenance, contradictions, unknown quality, and inference stay visible.
- [ ] A concrete evidence, repetition, access, user, or budget stop was applied.

## Red Flags

- Repeating a query with superficial wording changes.
- Treating project retrieval as verification or as permission to ingest.
- Giving a reusable child role broader project knowledge access.
- Expanding scope because a source is interesting rather than decision-relevant.
- Continuing after the evidence threshold or iteration ceiling is reached.
