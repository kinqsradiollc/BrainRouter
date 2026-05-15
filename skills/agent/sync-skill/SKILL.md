---
name: documentation-sync
description: Synchronizes documentation with the actual codebase. Use when code has changed but docs are outdated, before shipping a feature, or when you notice a mismatch between docs (API, Schema, Design) and reality. Triggers on "sync docs", "update API.md", or "align documentation".
---

# Documentation Sync Skill

This skill ensures that your project's "Source of Truth" documents accurately reflect the current state of the codebase.

## Workflow

1.  **Analyze & Detect**:
    - Identify which document needs syncing (`API.md`, `Schema.md`, `Design.md`, etc.).
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

## Usage

```bash
# Sync all core documents
sync documentation

# Focus on a specific area
update API.md to match the latest routes
```

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

## Required Checks

After syncing:
- [ ] Documentation accurately reflects the current state of the code.
- [ ] No placeholder values remain in the synchronized sections.
- [ ] The human has reviewed and approved the documentation changes.
- [ ] Related files (e.g., `README.md`) were checked for consistency.
