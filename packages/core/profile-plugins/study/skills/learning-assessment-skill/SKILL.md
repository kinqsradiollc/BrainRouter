---
name: learning-assessment-skill
description: Evaluate one objective against its declared mastery gate using observable, objective-type evidence and a deterministic advance-or-remediate decision.
allowed-tools: [read_file, list_dir, grep_search, glob_files, research_note, artifact_write, write_file, edit_file]
---

# Learning assessment

## Overview

Assessment is the gate between instruction and progression. It tests the
declared objective without answer leakage, records the learner's evidence, and
advances only when the objective-specific threshold is met.

## When to Use

Use after explanation or practice, when testing prior knowledge, or whenever a
mastery status must be updated. Do not use casual practice results as an
automatic mastery decision.

## Workflow

1. Read the current objective, type, prerequisites, mastery evidence, prior
   attempts, and help already given. Assess one gate at a time.
2. Choose evidence appropriate to type: accurate recall for memory, unaided
   execution plus transfer for procedure, own-words explanation for concept,
   and a justified trade-off decision for design judgment.
3. State the scoring criteria before grading. Ask the learner to commit to an
   answer and preserve their response verbatim enough to audit.
4. Evaluate correctness, reasoning, transfer, and assistance used. A lucky
   answer, prompted reconstruction, or confidence claim does not clear the gate.
5. Record pass or not-yet, supporting evidence, confidence in the assessment,
   and the exact missing element. Keep the learner on the objective when the
   gate is not met.
6. If passed, schedule review and select the next prerequisite-valid objective.
   If not, route the diagnosed error to remediation and reassess with a changed task.

## Verification

- [ ] The task measures the declared objective and matches its type.
- [ ] Criteria, learner response, assistance, and decision are auditable.
- [ ] Advancement occurs only after the mastery gate clears.
- [ ] Failed evidence leads to a specific remediation target.

## Red Flags

- Grading against a criterion invented after seeing the answer.
- Clearing mastery because the learner recognized the correct option.
- Moving on to maintain pace when prerequisite evidence is weak.
