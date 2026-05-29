---
name: conventions-skill
description: Naming patterns, formatting rules, import order, and module design standards for modern software codebases.
hints:
  - Inspect project root configuration files (e.g. .prettierrc, eslint.config.js) to align with existing styling tools.
  - Check existing project files for naming patterns and module architecture styles.
  - Follow kebab-case for system files and PascalCase for UI components (e.g. React components).
  - Keep functions focused and under 50 lines; extract complex logic into small, reusable helpers.
  - Eliminate console.log statements before committing, substituting appropriate logging utilities.
---

# Coding Conventions Skill

## Overview

This skill ensures all new code written in the codebase matches existing style and patterns. Load this before writing new files, adding features, or conducting code reviews.

## Workflow

- **[CONV-001] Naming**
  - Files: `kebab-case` for all files (`user-service.ts`, `location-controller.ts`)
  - React components: `PascalCase.tsx` (`SpotCard.tsx`, `AuthGuard.tsx`)
  - Functions & variables: `camelCase`
  - Constants: `UPPER_SNAKE_CASE`
  - Types & Interfaces: `PascalCase`, no `I` prefix (`User`, not `IUser`)
  - Event handlers: `handleEventName` pattern (`handleSubmit`, `handleDelete`)

- **[CONV-002] Code Style**
  - Formatter: Prettier (check `.prettierrc`)
  - Linter: ESLint (check `eslint.config.js`)
  - Quotes: single quotes for strings
  - Semicolons: required
  - Line length: 100 characters max
  - Indentation: 2 spaces
  - No `console.log` in committed code — use the project logger

- **[CONV-003] Import Order**
  1. External packages (`react`, `express`, `zod`)
  2. Internal modules (`@/lib`, `@/services`, `@/components`)
  3. Relative imports (`./utils`, `../types`)
  4. Type imports (`import type {}`) — always last
  - Blank line between each group; alphabetical within groups

- **[CONV-004] Error Handling**
  - Throw errors, catch at route/boundary level — not deep in utilities
  - Custom errors extend `Error` class, named `*Error` (`ValidationError`, `NotFoundError`)
  - Async functions use `try/catch` — no `.catch()` chains
  - Always log error context before re-throwing

- **[CONV-005] Function Design**
  - Keep functions under 50 lines; extract helpers for complex logic
  - Max 3 parameters — use an options object for 4+
  - Destructure object parameters in the signature: `function fn({ id, name }: Params)`
  - Use explicit `return` statements; return early for guard clauses

- **[CONV-006] Module Design**
  - Named exports preferred; default exports only for React components
  - Barrel files (`index.ts`) re-export the public API only
  - Do not export internal helpers from barrel files
  - Avoid circular dependencies — import from specific files if needed

- **[CONV-007] Comments**
  - Explain *why*, not *what*
  - Document business rules and non-obvious algorithms
  - JSDoc required for public API functions (`@param`, `@returns`, `@throws`)
  - TODOs: `// TODO: description` — link to issue number if available

## Required Checks

- [ ] File and function names match `CONV-001` patterns.
- [ ] No `console.log` left in committed code.
- [ ] Imports are ordered and grouped per `CONV-003`.
- [ ] All async code uses `try/catch`.
- [ ] Functions stay under 50 lines.

## When to Use
- Use when creating new modules, adding endpoints, writing frontend components, or conducting local codebase cleanups and refactoring.
- NOT for simple documentation-only changes or config modifications.

## Common Rationalizations
| Rationalization | Reality |
|---|---|
| I'll format the code manually later. | Automated formatting ensures clean git diffs and prevents formatting noise. |
| It's just a single console.log for quick debugging. | Forgotten debug logs clutter runtime output in production and create noise. |

## Red Flags
- Committing code with generic `console.log` statements instead of proper logging mechanisms.
- Functions exceeding 50-60 lines without being split into cohesive helpers.
- Inconsistent file naming conventions (e.g. mixing `camelCase` and `kebab-case` filenames in the same folder).

## Verification
After completing the skill, confirm:
- [ ] Prettier/ESLint rules have been run and all styling warnings are cleared.
- [ ] All imported modules are ordered according to standard grouping.
- [ ] Functions are short, clean, well-scoped, and documented where necessary.
