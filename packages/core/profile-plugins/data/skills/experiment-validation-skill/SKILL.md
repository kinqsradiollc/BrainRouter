---
name: experiment-validation-skill
description: Design or audit an experiment with explicit hypotheses, assignment, metrics, power, stopping rules, and reproducible checks.
allowed-tools: [read_file, grep_search, glob_files, write_file, edit_file, apply_patch, run_command]
---

# Experiment validation

## Overview

Make experiment conclusions trustworthy by defining the decision and analysis
before results are known, then checking assignment, instrumentation, statistical
assumptions, and practical significance.

## When to Use

Use for A/B tests, model evaluations, benchmarks, simulations, causal claims,
or reviewing an experiment plan or reported result.

## Workflow

1. Specify the hypothesis, experimental unit, eligibility, assignment method,
   primary metric, guardrails, minimum meaningful effect, and decision rule.
2. Estimate required sample size or precision and define duration, exclusions,
   multiple-comparison policy, and stopping criteria before observing outcomes.
3. Validate instrumentation and assignment with sample-ratio, balance, exposure,
   missing-data, novelty, and interference checks.
4. Run the predeclared analysis first. Report effect sizes and uncertainty, not
   only thresholded significance.
5. Treat subgroup and post-hoc findings as exploratory unless independently
   powered and predeclared. Check robustness to reasonable analysis choices.
6. Record protocol deviations, limitations, reproducible artifacts, and whether
   the evidence supports ship, iterate, stop, or gather more data.

## Verification

- [ ] Primary metrics and stopping rules were set before outcome inspection.
- [ ] Assignment, exposure, balance, and instrumentation checks pass.
- [ ] Effect size and uncertainty are reported with practical significance.
- [ ] Exploratory findings are not presented as confirmatory.

## Red Flags

- Repeatedly checking significance and stopping at the first favorable result.
- Changing the primary metric after seeing outcomes.
- Claiming general causality from a biased or underpowered sample.
