---
name: output-skill
description: Overrides default LLM truncation behavior. Enforces complete code generation, bans placeholder patterns, and handles token-limit splits cleanly. Apply to any task requiring exhaustive, unabridged output.
hints:
  - "Never write placeholders or truncation comments like `// ...` or `// implement here`."
  - "Explicitly count all required deliverables and verify that each is fully rendered in the final output."
  - "When outputting extremely long files, pause at a clean logical breakpoint and provide a structured resume instruction."
  - "Deliver actual, copy-pasteable production code rather than structural summaries or code sketches."
  - "Cross-check the output files against the target specification to ensure no methods or blocks were accidentally omitted."
---

# Full-Output Enforcement

## Baseline

Treat every task as production-critical. A partial output is a broken output. Do not optimize for brevity — optimize for completeness. If the user asks for a full file, deliver the full file. If the user asks for 5 components, deliver 5 components. No exceptions.

## Banned Output Patterns

The following patterns are hard failures. Never produce them:

**In code blocks:** `// ...`, `// rest of code`, `// implement here`, `// TODO`, `/* ... */`, `// similar to above`, `// continue pattern`, `// add more as needed`, bare `...` standing in for omitted code

**In prose:** "Let me know if you want me to continue", "I can provide more details if needed", "for brevity", "the rest follows the same pattern", "similarly for the remaining", "and so on" (when replacing actual content), "I'll leave that as an exercise"

**Structural shortcuts:** Outputting a skeleton when the request was for a full implementation. Showing the first and last section while skipping the middle. Replacing repeated logic with one example and a description. Describing what code should do instead of writing it.

## Execution Process

1. **Scope** — Read the full request. Count how many distinct deliverables are expected (files, functions, sections, answers). Lock that number.
2. **Build** — Generate every deliverable completely. No partial drafts, no "you can extend this later."
3. **Cross-check** — Before output, re-read the original request. Compare your deliverable count against the scope count. If anything is missing, add it before responding.

## Handling Long Outputs

When a response approaches the token limit:

- Do not compress remaining sections to squeeze them in.
- Do not skip ahead to a conclusion.
- Write at full quality up to a clean breakpoint (end of a function, end of a file, end of a section).
- End with:

```
[PAUSED — X of Y complete. Send "continue" to resume from: next section name]
```

On "continue", pick up exactly where you stopped. No recap, no repetition.

## Quick Check

Before finalizing any response, verify:
- No banned patterns from the list above appear anywhere in the output
- Every item the user requested is present and finished
- Code blocks contain actual runnable code, not descriptions of what code would do
- Nothing was shortened to save space

## Overview
This skill enforces absolute completeness in code generation and textual output. It serves as a guardrail against AI-native shortcuts, placeholders, and truncation behaviors, guaranteeing that the delivered assets are fully realized, production-ready, and directly runnable.

## When to Use
- **Use when:** The user requests full file creation or major system rewrites, when implementing complex multiple-file setups, or when writing comprehensive architectural designs.
- **NOT for:** Quick one-off terminal command suggestions, brief yes/no answers, or when explaining a high-level concept where full code isn't required.

## Workflow
1. **Identify Deliverables:** Audit the prompt and list exactly how many files, routines, or structural assets must be produced.
2. **Implement Unabridged Code:** Write every single line of code without skipping boilerplate, repeated fields, or setup configurations.
3. **Establish Token Checkpoints:** If output length nears limits, suspend generation at a clean boundary, and write the standard `[PAUSED — X of Y complete]` marker.
4. **Final Content Sweep:** Scan the drafted response for any commented ellipsis (`// ...`) or filler text, replacing them with complete implementations before finalizing.

## Common Rationalizations
| Rationalization | Reality |
|---|---|
| The user knows how to write the remaining handlers | The user expects complete, working code. Leaving stubs wastes their time and leads to integration bugs. |
| It saves space to show only the changed block | Swapping parts of a file often leads to copy-paste alignment errors. If a full file rewrite is requested, output the entire file. |
| I can write the imports and skip the details | Partial code blocks cannot be verified or compiled. Deliver full imports, variables, and logic. |

## Red Flags
- Comments like `// rest of the code is unchanged` or `/* ... */` in any code segment.
- Outlines or lists of steps instead of complete file contents.
- Direct suggestions to "implement this function as an exercise."

## Verification
After completing the skill, confirm:
- [ ] No placeholder stubs or ellipses exist in any code snippet.
- [ ] Every single file, component, and method listed in the scope has been fully output.
- [ ] The generated output compiles or runs with zero omitted dependencies.
- [ ] Large outputs have been correctly split and resumed with clear, clean instructions.
