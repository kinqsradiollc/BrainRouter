---
name: code-review-and-quality
description: Conducts multi-axis code review across correctness, readability, architecture, security, and performance. Use before merging any change. Use when reviewing code written by yourself, another agent, or a human. Use when running an agentic review-fix loop until tests pass and the PR is clean.
hints: |
  - Review tests first — they reveal intent before you read the implementation.
  - Evaluate across all five axes: correctness, readability, architecture, security, performance.
  - PRs over ~300 lines should be split before review — accuracy degrades on large diffs.
  - In the review-fix loop: fix only issues that are real and relevant — never over-fix.
  - Approve when the change improves overall code health, even if it isn't perfect.
memory_hints: |
  - Capture recurring review failures the user encounters (e.g. always missing error handling, recurring N+1 patterns).
  - Note if user consistently skips specific review axes (e.g. tends to skip security review).
  - Extract project-specific quality standards the user has set (e.g. "all PRs must be under 200 lines").
  - Remember when user requests review on AI-generated code — note what types of issues are found.
---

# Code Review and Quality

## Overview

Multi-dimensional code review with quality gates. Every change gets reviewed before merge — no exceptions. Review covers five axes: correctness, readability, architecture, security, and performance.

**The approval standard:** Approve a change when it definitely improves overall code health, even if it isn't perfect. Perfect code doesn't exist — the goal is continuous improvement. Don't block a change because it isn't exactly how you would have written it. If it improves the codebase and follows the project's conventions, approve it.

## When to Use

- Before merging any PR or change
- After completing a feature implementation
- When another agent or model produced code you need to evaluate
- When refactoring existing code
- After any bug fix (review both the fix and the regression test)

## Workflow

Read the diff and task context first, review tests before implementation details, evaluate the five quality axes, list concrete findings with severity and file references, then verify fixes with the relevant build and test commands.

## The Five-Axis Review

Every review evaluates code across these dimensions:

### 1. Correctness

Does the code do what it claims to do?

- Does it match the spec or task requirements?
- Are edge cases handled (null, empty, boundary values)?
- Are error paths handled (not just the happy path)?
- Does it pass all tests? Are the tests actually testing the right things?
- Are there off-by-one errors, race conditions, or state inconsistencies?

### 2. Readability & Simplicity

Can another engineer (or agent) understand this code without the author explaining it?

- Are names descriptive and consistent with project conventions? (No `temp`, `data`, `result` without context)
- Is the control flow straightforward (avoid nested ternaries, deep callbacks)?
- Is the code organized logically (related code grouped, clear module boundaries)?
- Are there any "clever" tricks that should be simplified?
- **Could this be done in fewer lines?** (1000 lines where 100 suffice is a failure)
- **Are abstractions earning their complexity?** (Don't generalize until the third use case)
- Would comments help clarify non-obvious intent? (But don't comment obvious code.)
- Are there dead code artifacts: no-op variables (`_unused`), backwards-compat shims, or `// removed` comments?

### 3. Architecture

Does the change fit the system's design?

- Does it follow existing patterns or introduce a new one? If new, is it justified?
- Does it maintain clean module boundaries?
- Is there code duplication that should be shared?
- Are dependencies flowing in the right direction (no circular dependencies)?
- Is the abstraction level appropriate (not over-engineered, not too coupled)?

### 4. Security

For detailed security guidance, see `security-and-hardening`. Does the change introduce vulnerabilities?

- Is user input validated and sanitized?
- Are secrets kept out of code, logs, and version control?
- Is authentication/authorization checked where needed?
- Are SQL queries parameterized (no string concatenation)?
- Are outputs encoded to prevent XSS?
- Are dependencies from trusted sources with no known vulnerabilities?
- Is data from external sources (APIs, logs, user content, config files) treated as untrusted?
- Are external data flows validated at system boundaries before use in logic or rendering?

### 5. Performance

For detailed profiling and optimization, see `performance-optimization`. Does the change introduce performance problems?

- Any N+1 query patterns?
- Any unbounded loops or unconstrained data fetching?
- Any synchronous operations that should be async?
- Any unnecessary re-renders in UI components?
- Any missing pagination on list endpoints?
- Any large objects created in hot paths?

## Change Sizing

Small, focused changes are easier to review, faster to merge, and safer to deploy. Target these sizes:

```
~100 lines changed   → Good. Reviewable in one sitting.
~300 lines changed   → Acceptable if it's a single logical change.
~1000 lines changed  → Too large. Split it.
```

**What counts as "one change":** A single self-contained modification that addresses one thing, includes related tests, and keeps the system functional after submission. One part of a feature — not the whole feature.

## Change Descriptions

Every change needs a description that stands alone in version control history.

**First line:** Short, imperative, standalone. "Delete the FizzBuzz RPC" not "Deleting the FizzBuzz RPC."
**Body:** What is changing and why. Include context, decisions, and reasoning not visible in the code itself.

## Agentic Review-Fix Loop (Grep Loop)

This is an auto-research-style loop for code review, specifically useful when a PR is small and you want an agent to repeatedly fix review feedback until tests pass and the PR is merge-ready.

1. Create a small PR.
2. Let a review tool, AI reviewer, or human inspect it.
3. Feed the review back to the coding agent.
4. Agent fixes the feedback.
5. Review again.
6. Repeat until the PR is clean and tests pass.

### Review-Fix Prompt

```md
Run a review-fix loop for this PR.

Inputs:
- Current branch: <branch-name>
- Review feedback: <paste feedback or point to reviewer output>
- Required end state: tests pass, reviewer issues resolved, no unrelated rewrites.

Rules:
1. Read the PR diff first.
2. Read the review feedback.
3. Fix only issues that are real and relevant to this PR.
4. Add or update tests for each bug fix when possible.
5. Run the relevant tests/typechecks.
6. Commit/push the fix if this workflow is allowed to push.
7. Stop only when the PR is clean or when blocked by a decision that needs a human.
```

### Pre-Flight Check

Before starting the loop, ask: "Is this PR too large for a reliable review loop? If yes, suggest how to split it." If the answer is yes, split the PR first.

### Human Guardrails & Pitfalls

- **Thousands of lines in one PR:** The reviewer and coding agent both lose accuracy. Split it.
- **No tests:** The loop needs objective checks, not just vibes.
- **Blindly accepting every comment:** Some comments are wrong or irrelevant.
- **Over-fixing:** Agents can rewrite unrelated code. Fix only what was reviewed.
- **False security:** A clean review is not proof the product is valuable; it only means this diff looks clean.

## The Review Checklist

```markdown
## Review: [PR/Change title]

### Context
- [ ] I understand what this change does and why

### Correctness
- [ ] Change matches spec/task requirements
- [ ] Edge cases handled
- [ ] Error paths handled
- [ ] Tests cover the change adequately

### Readability
- [ ] Names are clear and consistent
- [ ] Logic is straightforward
- [ ] No unnecessary complexity

### Architecture
- [ ] Follows existing patterns
- [ ] No unnecessary coupling or dependencies
- [ ] Appropriate abstraction level

### Security
- [ ] No secrets in code
- [ ] Input validated at boundaries
- [ ] No injection vulnerabilities
- [ ] Auth checks in place
- [ ] External data sources treated as untrusted

### Performance
- [ ] No N+1 patterns
- [ ] No unbounded operations
- [ ] Pagination on list endpoints

### Verification
- [ ] Tests pass
- [ ] Build succeeds
- [ ] Manual verification done (if applicable)

### Verdict
- [ ] **Approve** — Ready to merge
- [ ] **Request changes** — Issues must be addressed
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It works, that's good enough" | Working code that's unreadable, insecure, or architecturally wrong creates debt that compounds. |
| "I wrote it, so I know it's correct" | Authors are blind to their own assumptions. Every change benefits from another set of eyes. |
| "We'll clean it up later" | Later never comes. The review is the quality gate — use it. |
| "AI-generated code is probably fine" | AI code needs more scrutiny, not less. It's confident and plausible, even when wrong. |

## Red Flags

- PRs merged without any review.
- "LGTM" without evidence of actual review.
- Security-sensitive changes without security-focused review.
- Large PRs that are "too big to review properly" (split them).
- Review comments without severity labels.

## Verification

After completing the skill, confirm:
- [ ] All Critical issues are identified and addressed.
- [ ] The review follows the five-axis framework.
- [ ] The output follows the standard checklist template.
