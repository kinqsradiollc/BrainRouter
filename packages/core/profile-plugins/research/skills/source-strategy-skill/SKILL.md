---
name: source-strategy-skill
description: Design a bounded source and retrieval strategy that matches each sub-question to source types, query modes, freshness, and fallback paths.
allowed-tools: [read_file, grep_search, glob_files, fetch_url, web_search]
---

# Source strategy

## Overview

Source strategy decides where and how to look before collecting evidence. It
matches the information need to local, indexed, primary, official, or
independent sources and prevents high-volume search from substituting for fit.

## When to Use

Use after question decomposition and before evidence collection, especially
when sources span workspace material, knowledge indexes, websites, papers, or
time-sensitive data.

## Workflow

1. Map each sub-question to the source type most capable of answering it.
   Prefer workspace and user-provided material first, then primary or official
   sources, then credible independent analysis.
2. Decide whether each lookup needs semantic retrieval, literal keyword search,
   entity lookup, or direct document inspection. Keep queries short and focused.
3. Set scope filters, freshness windows, language or jurisdiction constraints,
   result limits, and minimum source identity needed for later verification.
4. Plan query variants for terminology, competing hypotheses, disagreement,
   null results, and changed conditions. Avoid near-duplicate query flooding.
5. Define fallback paths for unavailable sources, low recall, low precision,
   or contradictory results. Never loosen scope invisibly.
6. Record the ordered search plan and stop criteria, then hand it to evidence
   collection. The plan may adapt, but every material expansion stays visible.

## Verification

- [ ] Each sub-question has a source type and retrieval mode.
- [ ] Primary, local, and official sources are prioritized where appropriate.
- [ ] Scope, freshness, result limits, and fallback paths are explicit.
- [ ] The strategy includes disagreement and disconfirming searches.

## Red Flags

- Using semantic retrieval for exact strings, identifiers, or error codes.
- Using generated answers when raw source passages are required.
- Expanding to every available source because early results are inconvenient.
