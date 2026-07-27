---
name: academic-paper-review-skill
description: Adversarially review an academic paper for reject-level defects, material weaknesses, and advisory improvements without silently rewriting it.
allowed-tools: [read_file, list_dir, grep_search, glob_files, fetch_url, web_search, research_note, research_brief]
---

# Academic paper review

## Overview

Paper review is an independent, bounded quality gate. It tests whether a
skeptical reader can trace the contribution, method, and conclusions to the
paper's actual evidence and whether the presentation permits fair evaluation.
It reports findings; it does not manufacture missing work or silently rewrite
the artifact.

## When to Use

Use after a complete draft or material revision and before submission or
delivery. Run citation verification alongside it when the paper contains
external or numerical claims.

## Workflow

1. Restate the claimed contribution, evaluation scope, and strongest conclusion
   solely from the draft. Flag ambiguity when these cannot be recovered
   consistently from the title, abstract, introduction, and conclusion.
2. Trace every contribution and material claim through method assumptions,
   experiments, tables or figures, limitations, and cited evidence. Distinguish
   missing evidence from weak communication and avoid demanding out-of-scope
   experiments without explaining which claim they test.
3. Inspect novelty positioning, related-work fairness, technical soundness,
   reproducibility, baseline and metric fitness, ablation coverage,
   uncertainty, robustness, leakage or confounding risks, and threats to
   validity.
4. Reverse-outline the paper and check terminology, symbols, quantities,
   datasets, populations, and claims for cross-section drift. Inspect every
   figure and table for a single message, readable encodings, units, caption
   sufficiency, and agreement with the prose.
5. Classify at most ten findings:
   - Blocking: invalidates a central claim, prevents technical evaluation, or
     creates a serious integrity or reproducibility problem.
   - Material: could change confidence, interpretation, or acceptance but has a
     bounded correction.
   - Advisory: improves clarity or presentation without changing validity.
   Include location, evidence, impact, and smallest acceptable correction.
6. End with a verdict of ready, ready after bounded corrections, or not ready.
   List unresolved evidence needs separately and do not convert preferences
   about style into blocking findings.

## Verification

- [ ] Central claims were traced through method, experiments, and limitations.
- [ ] Novelty, comparison fairness, reproducibility, and validity were tested.
- [ ] Cross-section language and figure/table claims were checked.
- [ ] Findings are deduplicated, prioritized, evidenced, and capped at ten.
- [ ] The verdict follows from the classified findings.

## Red Flags

- Rejecting a paper for not performing an experiment unrelated to its claims.
- Calling a stylistic preference blocking.
- Reporting the same root cause as many separate findings.
- Approving because the prose is polished while evidence is missing.
- Rewriting text without preserving an auditable finding and disposition.
