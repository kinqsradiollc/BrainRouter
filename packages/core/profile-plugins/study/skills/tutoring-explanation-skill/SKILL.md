---
name: tutoring-explanation-skill
description: Explain one learning objective using prior knowledge, source-grounded models, worked examples, checks for understanding, and fading support.
allowed-tools: [read_file, list_dir, grep_search, glob_files, fetch_url, research_note, artifact_write, write_file, edit_file]
---

# Tutoring explanation

## Overview

An explanation creates a usable mental model for one objective. It connects to
what the learner already knows, makes reasoning visible, uses examples and
non-examples, then checks understanding before adding more detail.

## When to Use

Use when diagnosis or assessment identifies an objective that needs teaching,
or when the learner asks for a different representation of taught material.

## Workflow

1. Confirm the current objective, prerequisite state, learner context, and what
   successful understanding should let the learner do.
2. Activate only the relevant prior knowledge. Name the central idea in plain
   language before introducing formal notation or domain terminology.
3. Present one coherent model or procedure from the supplied source material.
   Separate definitions, mechanism, assumptions, and limitations.
4. Work one example while making each decision visible, then contrast a
   near-miss or non-example that exposes the objective's boundary.
5. Ask the learner to predict a step, explain the idea in their own words, or
   apply it to a nearby case. Do not ask only whether the explanation makes sense.
6. Adapt from the response: change representation or reduce the step size when
   needed, then fade hints and hand off to assessment or retrieval practice.

## Verification

- [ ] The explanation addresses one objective and its actual prerequisite gap.
- [ ] The model, example, and non-example agree with the source material.
- [ ] The learner produces observable reasoning before the workflow ends.
- [ ] Support is reduced rather than permanently solving the task for the learner.

## Red Flags

- Adding more words when the learner needs a different representation.
- Giving a worked solution with no learner prediction or reconstruction.
- Asking "do you understand?" as the only check.
