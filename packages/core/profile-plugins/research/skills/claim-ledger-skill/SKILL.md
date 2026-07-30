---
name: claim-ledger-skill
description: Normalize collected observations into auditable claims with support, contradiction, provenance, limitations, and confidence.
allowed-tools: [read_file, list_dir, grep_search, glob_files, research_note, research_brief]
---

# Claim ledger

## Overview

The claim ledger is the boundary between collection and synthesis. It prevents
source excerpts, analyst interpretation, and final conclusions from being
blurred together and makes conflicts and evidence gaps inspectable.

## When to Use

Use after collecting evidence, during long investigations, or whenever multiple
sources may support, qualify, or contradict the same material claim.

## Workflow

1. Convert each material observation into the smallest independently testable
   claim. Keep observed source content separate from analyst inference.
2. Attach stable source identity, location, date, relation to the claim
   (supports, refutes, qualifies, or unclear), and relevant limitations.
3. Deduplicate equivalent claims while preserving independent provenance.
   Related passages from one underlying source count as one evidence lineage.
4. Assign confidence from evidence quality, relevance, independence, and
   agreement. Do not infer confidence from source count alone.
5. Link each claim to its sub-question and mark unsupported, single-source,
   stale, or conflicting claims for follow-up.
6. Freeze a reviewable ledger snapshot before synthesis. New evidence after
   that point creates an explicit revision rather than silently changing claims.

## Verification

- [ ] Every material claim is atomic and linked to a sub-question.
- [ ] Source fact, interpretation, and inference are visibly distinct.
- [ ] Evidence lineages are deduplicated and their relationships are labelled.
- [ ] Confidence and open conflicts have an inspectable basis.

## Red Flags

- Copying whole documents into the ledger instead of extracting claims.
- Counting syndicated or repeated material as independent corroboration.
- Raising confidence because a claim sounds plausible.
