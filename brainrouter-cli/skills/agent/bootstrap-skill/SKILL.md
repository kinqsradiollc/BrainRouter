---
name: bootstrap-skill
description: Initializes a new project from the template. Use when starting a fresh repository, defining a new project vision, or setting up the initial codebase structure.
hints: |
  - Scan the workspace root immediately to determine if this is a fresh setup or a retrofit of an existing repository.
  - Establish a crisp naming standard and project vision before writing structural boilerplate.
  - Map out the exact directory structure (e.g. source, test, docker config, and docs directories) clearly.
  - Review theme options and initialize design tokens inside Design.md to define the visual system.
  - Ensure standard configuration files (.gitignore, README.md, AGENT.md) are personalized to the project.
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

## When to Use

- Initiating a brand new repository or folder structure from scratch.
- Retrofitting a templates/standards folder structure into an existing repository that lacks defined patterns.
- Defining a fresh project's styling boundaries, API foundations, and deployment setup.

**When NOT to use:**
- Adding new features, routes, or database schemas inside an already established codebase.
- Bug fixing or incremental updates on existing project setups.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll organize the folder structure later when we grow." | Starting with a chaotic layout ensures structural debt. Refactoring folder layouts later is extremely time-consuming and breaks import paths. |
| "We don't need a design token system or themes yet." | Defining a styling baseline at day zero prevents visual inconsistency and styling sprawl across components. |
| "I can skip retrofitting documentation on existing projects." | Dropping tooling into a legacy project without matching reality with `API.md` or `Schema.md` makes downstream agent tools fail. |

## Red Flags

- Initializing a repository without configuring a standard `.gitignore` or `package.json`.
- Creating folder names that are inconsistent with existing language conventions.
- Failing to replace template boilerplate names with the actual project name.

## Verification

After completing the bootstrap, verify:
- [ ] Direct directories (e.g., source, tests, docs) are established and clean.
- [ ] No residual placeholder names remain in configuration or core documents.
- [ ] Basic project setup is verified via standard package manager install/run commands.
- [ ] Setup documentation is placed in `README.md` or `AGENT.md`.
