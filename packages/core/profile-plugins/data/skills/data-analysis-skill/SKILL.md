---
name: data-analysis-skill
description: Produce a reproducible analysis from a measurable question through data-quality checks, methods, results, and limitations.
allowed-tools: [read_file, list_dir, grep_search, glob_files, write_file, edit_file, apply_patch, notebook_edit, lsp, run_command, artifact_write]
---

# Data analysis

## Overview

Turn a decision question into a reproducible analysis. Inspect provenance and
quality before modeling, make transformations explicit, and report uncertainty
and limitations alongside results.

## When to Use

Use for datasets, notebooks, metrics, exploratory analysis, statistical models,
visual reports, or debugging a surprising quantitative result.

## Workflow

1. Define the population, unit of analysis, outcome, comparison, and decision
   threshold. Separate exploratory questions from confirmatory ones.
2. Inventory source, schema, time range, joins, missingness, duplicates,
   impossible values, selection effects, and target leakage before analysis.
3. Create a reproducible preparation path that preserves raw inputs and records
   filters, transformations, seeds, software assumptions, and derived fields.
4. Start with simple descriptive checks and a baseline. Choose a method whose
   assumptions match the data and test those assumptions explicitly.
5. Validate the result with sensitivity checks, held-out data when appropriate,
   and inspection of errors or important subgroups.
6. Report the question, data lineage, method, metrics with uncertainty, artifacts,
   limitations, and the decision the evidence does or does not support.

## Verification

- [ ] Another practitioner can reproduce inputs, transformations, and outputs.
- [ ] Missingness, leakage, duplicates, and selection effects were examined.
- [ ] Results are compared with an appropriate baseline.
- [ ] Claims do not exceed the data or method.

## Red Flags

- Modeling before inspecting data quality and provenance.
- Reporting only aggregate performance when important subgroups differ.
- Treating correlation or a visualization as causal evidence.
