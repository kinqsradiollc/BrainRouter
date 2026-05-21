---
name: skill-authoring
description: Defines the canonical structure, format, and writing principles for BrainRouter SKILL.md files. Use when creating a new skill, reviewing an existing skill for compliance, or understanding what sections a skill must contain.
hints:
  - Keep skills project-agnostic, professional, and targeted at engineers or VibeCoders.
  - Standardize frontmatter name to match folder basename exactly.
  - Exclude custom branding, metadata keys, or trailing placeholders (like [trigger condition]).
  - Write high-rebuttal anti-rationalizations and actionable verification checklists.
  - Structure all supporting reference or template files under subfolders (e.g. templates/, scripts/).
---

# Skill Anatomy

This document describes the structure and format of agent-skills skill files. Use this as a guide when contributing new skills or understanding existing ones.

## File Location

Skills live in the following directory structure depending on their scope:

- **Universal Skills**: `skills/<category>/<skill-name>/SKILL.md`
- **Project-Specific Skills**: `projects/<project-name>/skills/<category>/<skill-name>/SKILL.md`

In the global MCP repository (BrainRouter), both folders are used to organize universal and project-level knowledge. In a local project repository, skills are typically stored in the `skills/` directory.

```
[root]/
  skills/
    api/
      auth-skill/
        SKILL.md
  projects/
    YourProject/
      skills/
        api/
          storage-skill/
            SKILL.md
```

`SKILL.md` is the only required file. You can also include a `scripts/` directory for runnable helpers or additional supporting markdown files.

## SKILL.md Format

### Frontmatter (Required)

```yaml
---
name: skill-name-with-hyphens
description: Guides agents through [task/workflow]. Use when [specific trigger conditions].
hints: |
  - Always execute step A before step B.
  - Assert that all tests pass before completing.
---
```

**Rules:**
- `name`: Lowercase, hyphen-separated. Must match the directory name.
- `description`: Start with what the skill does in third person, then include one or more clear "Use when" trigger conditions. Include both *what* and *when*. Maximum 1024 characters.
- `hints`: (Recommended for L2 Pre-warming) A concise, bulleted list of essential instructions that should be injected into the LLM system prompt context when this skill is pre-warmed. Keep this under 5-6 bullet points (approx. 300 characters) to optimize token consumption.

**Why this matters:** Agents discover skills by reading descriptions. The description is injected into the system prompt, so it must tell the agent both what the skill provides and when to activate it. Do not summarize the workflow — if the description contains process steps, the agent may follow the summary instead of reading the full skill.

The `hints` field is parsed by BrainRouter's L2 pre-warming engine. When the skill's activation potential is spiked, these hints are automatically injected into the LLM prompt context to keep the model primed with core rules.

### Standard Sections (Recommended Pattern)

The frontmatter contract above is required. The section layout below is a recommended pattern, not a rigid template: equivalent headings are acceptable when they serve the same purpose clearly.

```markdown
# Skill Title

## Overview
One-two sentences explaining what this skill does and why it matters.

## When to Use
- Bullet list of triggering conditions (symptoms, task types)
- When NOT to use (exclusions)

## [Core Process / The Workflow / Steps]
The main workflow, broken into numbered steps or phases.
Include code examples where they help.
Use flowcharts (ASCII) where decision points exist.

## [Specific Techniques / Patterns]
Detailed guidance for specific scenarios.
Code examples, templates, configuration.

## Common Rationalizations
| Rationalization | Reality |
|---|---|
| Excuse agents use to skip steps | Why the excuse is wrong |

## Red Flags
- Behavioral patterns indicating the skill is being violated
- Things to watch for during review

## Verification
After completing the skill's process, confirm:
- [ ] Checklist of exit criteria
- [ ] Evidence requirements
```

## Section Purposes

### Overview
The "elevator pitch" for the skill. Should answer: What does this skill do, and why should an agent follow it?

### When to Use
Helps agents and humans decide if this skill applies to the current task. Include both positive triggers ("Use when X") and negative exclusions ("NOT for Y").

### Core Process
The heart of the skill. This is the step-by-step workflow the agent follows. Must be specific and actionable — not vague advice.

**Good:** "Run `npm test` and verify all tests pass"
**Bad:** "Make sure the tests work"

### Common Rationalizations
The most distinctive feature of well-crafted skills. These are excuses agents use to skip important steps, paired with rebuttals. They prevent the agent from rationalizing its way out of following the process.

Think of every time an agent has said "I'll add tests later" or "This is simple enough to skip the spec" — those go here with a factual counter-argument.

### Red Flags
Observable signs that the skill is being violated. Useful during code review and self-monitoring.

### Verification
The exit criteria. A checklist the agent uses to confirm the skill's process is complete. Every checkbox should be verifiable with evidence (test output, build result, screenshot, etc.).

## Supporting Files

Create supporting files only when:
- Reference material exceeds 100 lines (keep the main SKILL.md focused)
- Code tools or scripts are needed
- Checklists are long enough to justify separate files

Keep patterns and principles inline when under 50 lines.

If a skill does not need runnable helpers, do not create an empty `scripts/` directory just to mirror other skills. Empty directories add noise without changing how the skill works.

## Writing Principles

1. **Process over knowledge.** Skills are workflows, not reference docs. Steps, not facts.
2. **Specific over general.** "Run `npm test`" beats "verify the tests".
3. **Evidence over assumption.** Every verification checkbox requires proof.
4. **Anti-rationalization.** Every skip-worthy step needs a counter-argument in the rationalizations table.
5. **Progressive disclosure.** Main SKILL.md is the entry point. Supporting files are loaded only when needed.
6. **Token-conscious.** Every section must justify its inclusion. If removing it wouldn't change agent behavior, remove it.

## L2 Skill Pre-Warming & SNN Routing

BrainRouter implements a Spiking Neural Network (SNN) model to dynamically pre-warm skills. This mechanism keeps relevant skills active in the agent's prompt context without blowing up the token window:
1. **Spikes**: Invoking a skill or querying memories related to it spikes its activation potential by `+1.0` (up to a maximum cap of `4.0`).
2. **Decay**: The potential decays exponentially over idle turns and time ($Potential_{new} = Potential_{old} \times e^{-\lambda \Delta t}$).
3. **Threshold Gate**: If a skill's potential is `>= 0.3`, it crosses the gate and is considered "active."
4. **Context Injection**: Active skills automatically have their `hints` frontmatter or registered memory hints injected into the LLM system prompt context under the `<skill-prewarm>` block.

When writing or updating skills, authors should:
- Ensure that the frontmatter `hints` are present, concise, and target specific error prevention or structural patterns.
- Register newly-added dynamic skill hints by invoking `mcp_brainrouter_memory_register_skill_hints` if the skill relies on user-customized memory overrides.

## Naming Conventions

- Skill directories: `lowercase-hyphen-separated`
- Skill files: `SKILL.md` (always uppercase)
- Supporting files: `lowercase-hyphen-separated.md`
- References: stored in `references/` at the project root, not inside skill directories

## Cross-Skill References

Reference other skills by name:

```markdown
Follow the `test-driven-development` skill for writing tests.
If the build breaks, use the `debugging-and-error-recovery` skill.
```

Don't duplicate content between skills — reference and link instead.

## Required vs Recommended

Required:

- A `skills/<skill-name>/SKILL.md` file
- Valid YAML frontmatter with `name` and `description`
- A description that includes both what the skill does and when to use it

Recommended:

- The standard section flow shown above
- Equivalent headings such as `How It Works`, `Core Process`, or `Workflow` when they read more naturally for the skill
- Supporting files only when they keep the main `SKILL.md` focused
