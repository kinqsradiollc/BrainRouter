---
name: programming-lab-skill
description: Teach and assess programming through bounded hands-on exercises, executable feedback, progressive hints, debugging, tests, and learner reflection.
allowed-tools: [read_file, list_dir, grep_search, glob_files, write_file, edit_file, apply_patch, notebook_edit, lsp, run_command, artifact_write]
---

# Programming lab

## Overview

Turn a programming objective into a safe, runnable learning loop. Preserve the
learner's ownership of the solution, use execution and tests as evidence, and
adapt hints and difficulty to demonstrated understanding rather than merely
producing finished code.

## When to Use

Use for coding lessons, programming exercises, guided labs, katas, debugging
practice, test-driven learning, or assessment of a learner's implementation.

## Workflow

1. Establish the target concept, language, environment, prerequisites, current
   understanding, time box, and observable success criteria. Inspect the
   workspace before changing files or assuming dependencies.
2. Create or select the smallest exercise that isolates the objective. Preserve
   existing learner work, provide bounded fixtures and tests, and avoid hidden
   complexity unrelated to the lesson.
3. Ask the learner to predict behavior or outline an approach before exposing a
   solution. Start with a conceptual cue, then a localized hint, then a partial
   scaffold; provide a complete example only when requested or pedagogically
   necessary.
4. Run the narrowest relevant command or test after each meaningful attempt.
   Interpret the output, separate syntax, environment, logic, and conceptual
   errors, and connect the evidence to the learner's mental model.
5. Remediate one misconception at a time with a contrasting example or smaller
   subproblem. Do not silently replace the learner's implementation or optimize
   beyond the objective.
6. Verify normal, boundary, and failure cases. Explain why the tests establish
   the objective and where they remain incomplete.
7. Ask for a brief explanation, prediction, or transfer task without the same
   scaffold. Record what is mastered, what remains uncertain, and the next
   appropriately difficult exercise.
8. Deliver runnable artifacts, commands, expected outcomes, hints already used,
   and a concise learning summary without exposing credentials or host paths.

## Verification

- [ ] The exercise isolates a stated learning objective and prerequisite level.
- [ ] Learner work is preserved and hints escalate progressively.
- [ ] Commands and tests produce evidence for normal and boundary behavior.
- [ ] Feedback distinguishes environmental, syntactic, logical, and conceptual errors.
- [ ] A transfer or explanation check demonstrates understanding beyond copying.

## Red Flags

- Completing the whole solution before the learner attempts the objective.
- Treating a green test as proof that the learner understands the concept.
- Adding frameworks, dependencies, or abstractions unrelated to the lesson.
- Repeatedly editing code without explaining the observed error and correction.
- Running broad or destructive commands when a bounded check is sufficient.
