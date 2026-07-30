---
name: academic-paper-drafting-skill
description: Draft or revise an academic paper from a reviewed evidence set with a coherent contribution story, explicit section contracts, and claim-evidence alignment.
allowed-tools: [read_file, list_dir, grep_search, glob_files, research_note, research_brief, artifact_write, write_file, edit_file]
---

# Academic paper drafting

## Overview

Academic drafting turns a bounded research question, frozen claim ledger, and
verified evidence into a paper whose novelty, reasoning, experiments, and
limitations remain consistent from title through conclusion. It may reorganize
or narrow claims, but it must not invent citations, results, methods, or
experimental details.

## When to Use

Use when outlining, drafting, or revising a paper or substantial paper section
after the intended contribution and available evidence are known. Use the
separate paper-review and citation-verification skills as release gates.

## Workflow

1. Establish the paper contract: audience and venue constraints, research
   question, thesis, contribution list, evidence boundary, terminology map,
   required sections, and unresolved inputs. Stop if the central contribution
   cannot be stated without unsupported novelty or result claims.
2. Create a claim-evidence map. Link every material novelty, comparative,
   causal, numerical, and generalization claim to ledger evidence; label
   inference and planned-but-unavailable evidence. Narrow or remove claims that
   exceed their support.
3. Give each section a contract:
   - Abstract: problem, specific gap, contribution, strongest supported result,
     and scope.
   - Introduction: context, decision-relevant gap, contribution story, and
     paper map.
   - Related work: comparison dimensions and the precise distinction, without
     straw-manning.
   - Method: assumptions, inputs, mechanism, design rationale, and enough
     detail to inspect or reproduce.
   - Experiments: questions, baselines, datasets, metrics, controls, ablations,
     uncertainty, and threats to validity.
   - Conclusion: supported takeaway, boundary conditions, limitations, and
     bounded future work.
4. Draft around one contribution story. Keep terms, symbols, populations,
   baselines, metrics, and confidence language stable across prose, equations,
   captions, figures, and tables.
5. Treat each figure or table as an evidence-bearing artifact. Give it one
   message, readable labels and units, a self-contained caption, and an
   explicit callout from the prose. Never describe a result absent from the
   underlying data.
6. Reverse-outline the draft by recording each paragraph's single job and its
   dependency on the preceding paragraph. Split mixed-purpose paragraphs,
   repair unsupported transitions, and remove sections that do not advance the
   question or contribution.
7. Produce the draft together with its contribution list, terminology map,
   claim-evidence map, figure/table inventory, experiment coverage matrix, and
   explicit limitations. Preserve unresolved placeholders rather than filling
   them speculatively.

## Verification

- [ ] The same bounded contribution story appears throughout the paper.
- [ ] Every material claim maps to evidence, inference, or an explicit gap.
- [ ] Every section and paragraph has one inspectable purpose.
- [ ] Terminology, symbols, metrics, and scope remain consistent.
- [ ] Figures, tables, experiments, and limitations support the stated claims.

## Red Flags

- Declaring novelty from absence of a remembered citation.
- Writing an abstract result that the experiment section does not establish.
- Treating visual polish as evidence quality.
- Hiding a technical defect as vague future work.
- Filling missing values, citations, or method details with plausible text.
