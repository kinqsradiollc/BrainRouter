---
name: concerns-skill
description: Framework for surfacing and tracking tech debt, known bugs, and security gaps in.
---

# Codebase Concerns Skill

## Overview

This skill governs how known risks, tech debt, and codebase health issues are surfaced and maintained. Load this before making changes to high-risk areas, during phase planning, or when onboarding a new agent context.

## Workflow

- **[CONCERN-001] Always Check Before Changing**
  - Before modifying a flagged area, read its concern entry to understand risk, workarounds, and safe modification paths.
  - If no concern entry exists for an area you're about to change, check for fragility signals (complex chains, missing tests, shared mutable state).

- **[CONCERN-002] Concern Entry Format**
  - Every concern must include: area/component, issue description, why it exists, impact, and fix approach.
  - Always include **file paths** — concerns without locations are not actionable.
  - Use specific measurements for performance issues (`500ms p95`, not "slow").
  - Include reproduction steps for bugs.

- **[CONCERN-003] Categories**
  - **Tech Debt**: Shortcuts with known impact and a fix path.
  - **Known Bugs**: Reproducible defects with symptoms, trigger, and workaround.
  - **Security Considerations**: Risks with current mitigation and recommendations.
  - **Performance Bottlenecks**: Measured slow paths with root cause and improvement plan.
  - **Fragile Areas**: Components that break easily — document safe modification steps.
  - **Scaling Limits**: Capacity numbers and what happens at the limit.
  - **Dependencies at Risk**: Deprecated, unmaintained, or breaking-change packages.
  - **Test Coverage Gaps**: Untested paths and the risk they carry.

- **[CONCERN-004] Tone & Accuracy**
  - Professional, not emotional (`"N+1 query pattern"` not `"terrible queries"`)
  - Solution-oriented — always suggest a fix approach, not just a problem
  - Factual — use real numbers, not vague qualifiers
  - No opinions without evidence; no complaints without solutions

- **[CONCERN-005] Maintenance**
  - Mark concerns as resolved when the underlying issue is fixed.
  - Add new concerns as they are discovered — during audits, debugging, or code review.
  - Include the analysis date on each update.
  - This is a living document, not a complaint list.

## When to Load This Skill

| Scenario | Action |
|---|---|
| About to change auth, middleware, or DB layer | Read **Fragile Areas** and **Security Considerations** |
| Planning a new feature phase | Read **Tech Debt** and **Scaling Limits** |
| Debugging an unexpected failure | Read **Known Bugs** |
| Writing or reviewing tests | Read **Test Coverage Gaps** |
| Evaluating dependencies | Read **Dependencies at Risk** |

## Required Checks

- [ ] Concern entry has a file path — no location-less concerns.
- [ ] Performance numbers are actual measurements, not estimates.
- [ ] Bugs include a reproduction trigger.
- [ ] Resolved concerns are removed or marked fixed with a date.
- [ ] New concerns added after any audit or incident.

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
