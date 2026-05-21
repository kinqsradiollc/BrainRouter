---
name: sync-skill
description: Synchronizes documentation with the actual codebase. Use when code has changed but docs are outdated, before shipping a feature, or when you notice a mismatch between docs (API, Schema, Design) and reality.
hints: |
  - Always identify which documentation file (e.g., API.md, Schema.md, README.md) is the primary target for changes.
  - Review route validation logic (like Zod or Joi schemas) to accurately document constraints.
  - Parse ORM models or database migrations to capture relationships and field limits in Schema.md.
  - Scan CSS variables and tailwind/theme configurations to align Design.md design tokens.
  - Double check if related auxiliary files (like .env.example or package.json) require matching updates.
---

# Documentation Sync Skill

This skill ensures that your project's "Source of Truth" documents accurately reflect the current state of the codebase.

## Overview

Documentation rot is one of the most common issues in fast-moving engineering projects. When code and documentation diverge, developers build integrations on false assumptions, leading to runtime failures and wasted hours. This skill establishes high-fidelity documentation syncing as a standard part of the implementation flow.

## When to Use

- A route, controller, or public interface signature has been added, modified, or deleted.
- Database schema changes (migrations, ORM models, or raw SQL structures) have occurred.
- Environment variables or initialization requirements have been introduced or altered.
- Styling system design tokens (colors, margins, font hierarchies) have been updated in code.

**When NOT to use:**
- Internal refactorings or small bug fixes that do not alter the public API, database schemas, or project setup.
- Writing temporary scripts or local scratch files.

## Workflow

1.  **Analyze & Detect**:
    - Identify which document needs syncing (`API.md`, `Schema.md`, `Design.md`, `README.md`, etc.).
    - Scan the relevant source files (e.g., routes files for API, prisma/sql for Schema, CSS/React for Design).
    - Identify specific discrepancies (missing fields, changed endpoints, new colors).

2.  **Propose Changes**:
    - Show the user the detected changes and the proposed updates to the documentation.
    - Ask: "I've detected new endpoints in `routes/user.ts`. Should I add them to `API.md`?"

3.  **Execute Sync**:
    - Update the documentation files using `replace_file_content` or `multi_replace_file_content`.
    - Ensure formatting remains consistent with the project's standards.

4.  **Verify**:
    - Do a final cross-check to ensure no information was missed.
    - Check if related documents also need updates (e.g., changing a DB field in `Schema.md` might require an update to `API.md`).

## Detailed Instructions

You are the "Chronicler." Your goal is to eliminate "Documentation Rot."

### High-Fidelity API Syncing
When updating `API.md`:
- Don't just list the route. Include the required headers, request body structure, and successful/error response examples.
- Read the validation logic (e.g., Zod, Joi) to ensure the docs list the correct field constraints.

### High-Fidelity Schema Syncing
When updating `Schema.md`:
- Read the ORM files (Prisma, TypeORM) or raw SQL migrations.
- Capture relationships (1:1, 1:N, N:M) accurately in the documentation.
- Note any default values or constraints (e.g., `isUnique`, `isNullable`).

### High-Fidelity Design Syncing
When updating `Design.md`:
- Scan the root CSS or Theme configuration files.
- If a new color or spacing token was added to the code but isn't in `Design.md`, add it.
- Ensure the `Active Baseline Configuration` (Variance, Intensity, Density) still reflects the current vibe of the app.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The code is self-documenting, so docs are optional." | Self-documenting code explains *how* it works, but not *why*. External developers, AI agents, and non-technical stakeholders cannot read raw code efficiently. |
| "I will update the documentation in a subsequent pull request." | Stale documentation starts immediately. By separating documentation from implementation, it is highly likely to be forgotten or postponed indefinitely. |
| "It takes too long to document schemas manually." | Manual correctness prevents hours of downstream integration issues. Always sync API/DB changes alongside the code that introduces them. |

## Red Flags

- Modifying route signatures or request payloads without checking if `API.md` requires updates.
- Running database migrations or changing ORM schemas without matching updates to `Schema.md` or dependency docs.
- Introducing new environment variables without adding them to `.env.example` or updating setup instructions in `README.md`.
- Leaving standard template placeholder comments or empty sections inside updated documentation.

## Verification

After completing the sync, verify:
- [ ] Documentation accurately reflects the current state of the codebase.
- [ ] No placeholder values or boilerplate remains in the synchronized sections.
- [ ] All request/response payloads, headers, and schemas are complete.
- [ ] Auxiliary files (e.g., `README.md`, `.env.example`) have been reviewed for consistency.
