---
name: technical-documentation-skill
description: Create and verify repository-grounded API references, developer guides, tutorials, runbooks, and technical explanations with runnable examples and explicit source provenance.
allowed-tools: [read_file, list_dir, grep_search, glob_files, write_file, edit_file, apply_patch, run_command, fetch_url, web_search, artifact_write]
---

# Technical documentation

## Overview

Turn implemented behavior and reviewed sources into documentation a defined
audience can successfully use. Treat code, schemas, tests, configuration, and
runtime evidence as the authority; distinguish current behavior from proposals
and verify examples instead of inferring convenient details.

## When to Use

Use for API references, developer guides, tutorials, READMEs, architecture
explanations, operational runbooks, integration instructions, migration notes,
or audits of documentation against implementation.

## Workflow

1. Define the audience, job, prerequisites, supported versions, scope, and
   document type. Identify the authoritative code, schema, configuration,
   tests, runtime behavior, and external primary sources before outlining.
2. Build a compact source map from each material claim, command, option,
   response shape, default, limitation, and failure mode to its authority.
   Mark uncertainty and proposed behavior rather than filling gaps.
3. Choose a task-oriented structure: concept only where needed, prerequisites,
   smallest successful path, explanation, alternatives, failure recovery,
   reference details, limitations, and next steps.
4. Write examples with safe placeholders and realistic inputs. Never include
   credentials, private host paths, unverifiable output, or an option that the
   current implementation does not accept.
5. Run or otherwise verify the narrowest representative commands, snippets,
   links, request/response samples, and setup sequence. Record platform,
   version, environment assumptions, and any step that cannot be executed.
6. Keep names, terminology, capitalization, paths, and cross-references
   consistent with the product. Explain defaults, side effects, permissions,
   idempotency, rollback, and error recovery where they affect safe use.
7. Review from a fresh-reader perspective for missing prerequisites, skipped
   state transitions, ambiguous pronouns, unexplained jargon, inaccessible
   structure, stale links, and divergence between narrative and examples.
8. Deliver the updated documentation with verified evidence, unresolved gaps,
   and a concise list of claims that require a future implementation change.

## Verification

- [ ] Material claims map to current code, schema, tests, runtime evidence, or primary sources.
- [ ] The intended audience can complete the stated job from the documented prerequisites.
- [ ] Commands, snippets, links, and response examples were verified or explicitly marked unverified.
- [ ] Permissions, side effects, defaults, failure recovery, and version limits are visible.
- [ ] Terminology and examples remain consistent across the document set.

## Red Flags

- Documenting the intended design as though it is already implemented.
- Copying a type or endpoint name without checking its exported/public contract.
- Hiding setup state, authorization, destructive effects, or recovery steps.
- Using fabricated command output or examples that were never exercised.
- Rewriting unrelated documentation while fixing one bounded user journey.
