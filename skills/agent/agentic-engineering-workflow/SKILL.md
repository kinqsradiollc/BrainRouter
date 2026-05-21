---
name: agentic-engineering-workflow
description: Provides an end-to-end operating system for building software with AI agents. Use when starting any non-trivial feature, MVP, or tool build with an AI coding agent. Use when you want a repeatable workflow instead of ad-hoc prompting.
hints: |
  - Keep each task small and PR-sized — one feature or fix at a time.
  - Build the minimal working version first, then run a cleanup pass.
  - Never guess APIs — reference official docs or the openSrc/ folder (if present) before coding.
  - Run a review-fix loop after every PR until tests pass and review is clean.
  - Launch earlier than feels comfortable. Feedback beats perfection.
---

# Agentic Engineering Workflow

## Overview

A repeatable operating system for building software with AI coding agents. The human decides the outcome, the agent does the mechanical work, and tight feedback loops keep the result honest. This is not "ask the AI to build everything and hope" — it is a disciplined process where every step is small, verifiable, and reversible.

## When to Use

- You are building an MVP, feature, internal tool, or AI-assisted product.
- You want a repeatable AI coding workflow instead of random prompting.
- You are using Cursor, Claude Code, Codex, Hermes, or another coding harness.

**When NOT to use:** One-off tiny edits where a normal direct prompt is sufficient.

## Workflow

```
HARNESS → SMALL TASK → SOURCE CONTEXT → BUILD MINIMAL → CLEANUP → REVIEW LOOP → LAUNCH → SECURITY
```

1. **Pick the strongest harness/model you can access.** The harness is the wrapper around the model: file search, terminal, browser, tools, system prompt, and project memory. The model matters, but the harness determines what the model can actually do.

2. **Keep the task small.** Ask for one feature, one fix, or one reviewable unit at a time. If a plan is too large, ask the agent to split it into smaller PR-sized chunks.

3. **Give source code as context when docs are not enough.** If you are using a package, SDK, framework, or open-source tool, tell the agent to search it before coding. If an `openSrc/` folder is present in the workspace, check its reference repositories for high-quality implementation examples. See `source-driven-skill` for the full pattern.

4. **Build the minimal feature first.** Do not refactor the whole app while building the feature. Get the smallest working version running.

5. **Run a cleanup pass.** After the feature works, ask the agent to find duplicated runtime mechanics and move them into reusable service-layer modules. See `code-structure-cleanup`.

6. **Run a review-fix loop.** Use tests, typechecks, and AI/human review. Feed review feedback back into the coding agent. Keep fixing until the PR is clean or a human decision is needed. See `code-review-and-quality`.

7. **Launch earlier than feels comfortable.** A semi-functional MVP with real user feedback beats a perfect private project every time.

8. **Apply security guardrails.** Never install a package less than 14 days old without human approval. Use 2FA via authenticator app, not SMS. Never paste secrets into prompts. When a package breach trends, ask the agent to scan your local projects for that package/version.

## Copy-Paste Starter Prompt

```md
We are going to build this using an agentic engineering workflow.

Rules:
1. Keep the change small and reviewable.
2. Search the existing code before creating new abstractions.
3. If using a package/framework, reference its local source or official repo before guessing APIs.
4. Build the minimal working version first.
5. After it works, run a code-structure cleanup pass.
6. Run relevant tests/typechecks.
7. Summarize what changed, what was tested, and what still needs human judgment.

Task:
<describe the feature or fix here>
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Let the agent decide the approach" | The agent is a worker, not the product owner. You decide the outcome — the agent executes it. |
| "More context is always better" | Context overload degrades output quality. Give only the files and specs relevant to the current task. |
| "One big PR is faster" | Review loops break down on large diffs. Split into small, reviewable units. |
| "I'll do the cleanup later" | Working code with duplicated mechanics is technical debt that slows every future agent working in that area. |
| "It just needs one more feature before launch" | Waiting for perfect is how competitors ship before you. Ship now, improve with feedback. |

## Red Flags

- Starting a task without defining what "done" means.
- Asking the agent to build multiple features in a single session without a plan.
- PRs with thousands of changed lines — the review loop will break down.
- Agent inventing API names instead of referencing source or docs.
- No cleanup pass after a feature ships.
- Secrets in prompts, screenshots, or code comments.

## Verification

After completing a feature using this workflow, confirm:

- [ ] Task was scoped to a single small, reviewable unit.
- [ ] Agent searched relevant existing code before editing.
- [ ] External package/framework behavior was checked against source or official docs.
- [ ] Feature works locally.
- [ ] Cleanup pass was run and obvious duplication was removed.
- [ ] Tests/typechecks ran, or the reason they could not is stated.
- [ ] Security-sensitive changes were explicitly reviewed by a human.
