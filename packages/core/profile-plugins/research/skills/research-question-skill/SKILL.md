---
name: research-question-skill
description: Refine an ambiguous research request into a bounded question, decision target, sub-questions, evidence threshold, and stopping condition.
allowed-tools: [read_file, grep_search, glob_files]
---

# Research question

## Overview

A good research workflow starts with a question that can be answered or shown
to remain uncertain. This skill separates clarification and decomposition from
search so the user can inspect the intended scope before evidence work begins.

## When to Use

Use when a request is broad, ambiguous, compound, or missing the decision,
audience, time horizon, evidence threshold, or required output.

## Workflow

1. Restate the user's request and the decision or action the answer should
   support. Preserve explicit constraints and distinguish facts from preferences.
2. Identify the target population, system, geography, time range, comparison,
   and output format that materially affect the answer.
3. Ask only for missing information that would change the research direction.
   If clarification is unavailable, state the narrow assumption you will use.
4. Express one primary question and a small set of non-overlapping
   sub-questions. Include at least one disconfirming or alternative hypothesis
   when the conclusion could be consequential.
5. Define acceptable evidence, freshness requirements, exclusions, and a
   stopping condition. Mark optional branches so they cannot silently expand
   scope.
6. Present the question map for confirmation before a costly or broad search.

## Verification

- [ ] The primary question is answerable and tied to a user decision.
- [ ] Sub-questions are bounded, non-duplicative, and collectively sufficient.
- [ ] Assumptions, exclusions, evidence threshold, and stopping condition are explicit.
- [ ] Search has not begun before scope-changing ambiguity is resolved.

## Red Flags

- Turning every interesting tangent into a required sub-question.
- Asking the user questions whose answers would not change the plan.
- Treating the requested conclusion as a fact to prove.
