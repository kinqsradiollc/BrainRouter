---
name: bootstrap
description: Initializes a new project from the template. Use when starting a fresh repository, defining a new project vision, or setting up the initial codebase structure. Triggers on "bootstrap this project", "start a new app", or "initialize repository".
---

# Bootstrap Skill

This skill guides you through the process of transforming this template into a specific project.

## Workflow

1.  **Detection & Context Gathering**:
    - Scan the current directory for existing code, folders, and documentation.
    - Ask the user: "Is this a brand new project or are we retrofitting an existing one?"

2.  **Path A: Brand New Project**:
    - Define Project Name, Vision, and Target Audience.
    - Create the initial folder structure (e.g., `web`, `api`, `shared`).
    - Initialize `package.json` and basic boilerplate.

3.  **Path B: Existing Project (Retrofit)**:
    - **Analyze**: Scan routes, components, and logic to understand the current architecture.
    - **Align**: Update `docs/api/API.md` and `docs/schema/Schema.md` to reflect the actual code.
    - **Sanitize**: Replace any legacy project names with `the project` or the new name.

4.  **Theme Selection (Common)**:
    - List available themes in `docs/design/themes/`.
    - Apply the selected theme tokens to `docs/design/Design.md`.
    - For existing projects, create a "Theme Migration Plan."

5.  **Core Initialization**:
    - Update `AGENT.md` and `README.md` with the final project name.
    - Set up `docker-compose.yml` if infrastructure is required.
    - Invoke the `Interview Skill` for deep requirement gathering.

## Usage

```bash
# Start the bootstrap process
bootstrap the project
```

## Detailed Instructions

You are the "Architect" responsible for laying the foundation. Your goal is to move from a generic template to a defined project as quickly as possible.

### Phase 1: The Vision
Start by asking:
- "What is the name of this project?"
- "What is its primary mission?"
- "Who are the users?"
- "What is the design aesthetic? (Minimalist, Brutalist, Pinterest-style, etc.)"

### Phase 3: Retrofitting Existing Projects
If dropping this template into an existing project:
1.  **Scan & Align**: Scan the existing codebase (components, routes, logic).
2.  **Map Reality**: Update `docs/api/API.md` and `docs/schema/Schema.md` to reflect the actual state of the project.
3.  **Sanitize**: Search and replace any leftover placeholders or legacy naming conventions to align with the new skill standards.
4.  **Adopt Theme**: Choose a theme from `docs/design/themes/` and create a "Migration Plan" to update existing UI to the new standard incrementally.

### Phase 4: Sanitization
Scan the repository and replace all instances of `the project` and `the project domain` with the actual values.

### Phase 5: Next Steps
Once the foundation is laid, direct the user to the `Spec-Driven Skill` or `Planning Skill` to start building features.

## Overview
Brief description of what this skill does and why it matters.

## When to Use
- Use when: [trigger condition]
- NOT for: [exclusion]

## Common Rationalizations
| Rationalization | Reality |
|---|---|
| I can skip this | Following the defined process prevents regressions |

## Red Flags
- Observable signs that this skill is being violated.

## Verification
After completing the skill, confirm:
- [ ] The process was followed correctly.
- [ ] Required outcomes are met.
