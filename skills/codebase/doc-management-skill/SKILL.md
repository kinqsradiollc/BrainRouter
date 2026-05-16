---
name: doc-management-skill
category: codebase
description: Guidelines for reading living project documentation using MCP tools.
---

# Doc Management Skill

## Overview
This skill defines the workflow for interacting with project documentation. The Global BrainRouter `docs/` folder contains universal templates. However, the actual living documentation for a user's project resides strictly in their **local project's** `docs/` directory (e.g., `projects/<project_name>/docs/`). The MCP tools (`list_docs` and `get_doc`) only load the local project documents. Documentation via MCP is entirely read-only to prevent unexpected modifications to the user's local architectural blueprints or the server's templates.

## When to Use
Use this skill whenever you need to understand existing architectural decisions, read API endpoint specifications, check database schemas, load persistent project context from the living documentation, or consult project reference checklists/patterns.

## Workflow

1. **Discover Docs**: Run `list_docs` to see the current living documents available for the local project.
2. **Read Docs**: Run `get_doc` to read existing documentation sections to gain important context before working on tasks.
3. **Read References**: Run `get_reference` to load specific checklists and patterns (e.g., `security-checklist`, `accessibility-checklist`, `orchestration-patterns`) from the `references/` directory.

## Usage

When you are asked to read documentation or reference constraints for the current project:
1. Always prioritize using the MCP tools (`list_docs`, `get_doc`, `get_reference`) to locate and load information. 
   - `get_doc` expects the doc name (e.g. `api`, `design`, `schema`, `hooks`, `strategy`, `deployment`).
   - Use the `section` parameter with `get_doc` to target specific headings for larger documents.
   - `get_reference` expects the name of the reference file without extension (e.g., `security-checklist`, `testing-patterns`).
2. Do not attempt to update or create documents via standard file writes or non-existent MCP tools.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll just try to use a generic write tool to create docs/API.md" | Modifying or creating docs is intentionally restricted in the MCP context. Read only. |

## Red Flags
- Attempting to edit docs instead of reading them.
- Assuming you can update the docs based on outdated context.

## Verification
- [ ] Did you properly locate the needed documentation using `list_docs`?
- [ ] Did you read the existing documentation section using `get_doc` to gain context?
