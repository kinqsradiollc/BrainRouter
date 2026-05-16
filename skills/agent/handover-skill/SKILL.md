---
name: project-handover-and-walkthrough
description: Summarizes completed work and provides a walkthrough. Use when a project, feature, or task is finished and needs to be reviewed or handed over to a human or another agent.
---

# Project Handover and Walkthrough

## Overview

A good handover ensures that the work you've done is understandable, verifiable, and maintainable. The walkthrough is the final "sales pitch" and "instruction manual" for your changes. It should explain what was done, why it was done that way, and how the human can verify the results.

## When to Use

- You have completed all tasks in the implementation plan.
- You are finishing a session and want to leave a clear state for the next one.
- You need a human to review and sign off on a significant change.
- You want to document the technical decisions made during implementation.

## The Handover Process

### Step 1: Final Verification

Before writing the walkthrough, confirm that everything works as expected:
- Run the full test suite.
- Perform manual verification of the main user flows.
- Ensure the code follows project conventions and linting rules.
- Check that all tasks in `task.md` are marked as completed.

### Step 2: Create the Walkthrough File

Create a `walkthrough.md` file in the project root. This is your primary artifact for the handover.

### Step 3: Summarize Key Changes

Don't just list files. Explain the *logic* of the changes.
- What were the main architectural decisions?
- What new components or modules were added?
- Were there any significant refactors?

### Step 4: Evidence of Success

Provide proof that the work is correct.
- Include test results (e.g., "15 tests passed, 0 failed").
- If applicable, include screenshots or recordings (if the tool supports it).
- Link to relevant documentation or updated files.

## Walkthrough Template

```markdown
# Walkthrough: [Feature/Project Name]

## Overview
[A brief summary of what was accomplished and why.]

## Key Changes
[Bullet points of the most important changes, grouped logically.]

- **Core Logic**: Description of changes to business logic.
- **UI/UX**: Description of changes to the interface.
- **Infrastructure**: Changes to databases, APIs, or configuration.

## Technical Decisions
[Explain any non-obvious choices made during implementation.]

- **Decision 1**: Rationale and trade-offs.
- **Decision 2**: Rationale and trade-offs.

## Verification Results

### Automated Tests
- [ ] Unit tests pass: `npm test`
- [ ] Integration tests pass: `npm run test:integration`
- [ ] Coverage: 95% line coverage on new modules.

### Manual Verification
1. [Step 1 of manual check]
2. [Step 2 of manual check]
- [ ] Results: [Description of observed behavior]

## Future Work / Remaining Debt
- [ ] [Unsolved edge case]
- [ ] [Performance optimization for later]
- [ ] [Feature extension ideas]

## Sign-off
- [ ] Ready for production
- [ ] Human review required for [specific area]
```

## Red Flags

- Creating a walkthrough before finishing all tasks.
- Listing file changes without explaining the "why."
- No verification results included.
- Leaving `task.md` with uncompleted items.
- Vague summaries like "Implemented the feature."

## Required Checks

Before finalizing the handover, confirm:

- [ ] `walkthrough.md` is saved in the repository.
- [ ] All verification steps have been run and documented.
- [ ] Technical decisions are clearly explained.
- [ ] `task.md` is updated to reflect the final state.
- [ ] Any "Future Work" or "Known Issues" are noted.

## Workflow
1. **Verify:** Run all tests and manual checks one last time.
2. **Review:** Compare the final state against the original `SPEC.md` and `IMPLEMENTATION_PLAN.md`.
3. **Write:** Create the `walkthrough.md` using the template.
4. **Clean up:** Delete any temporary scratch files or debug logs.
5. **Update:** Mark the final task in `task.md` as done.
6. **Submit:** Inform the human that the walkthrough is ready for review.

## Verification
After completing the skill, confirm:
- [ ] The walkthrough accurately reflects the work done.
- [ ] All verification data is accurate and current.
- [ ] The human can follow the walkthrough to understand the changes.
