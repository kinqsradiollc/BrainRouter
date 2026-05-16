---
name: agent-memory
description: Teaches agents how and when to use BrainRouter's 5 memory tools. Apply this skill whenever memory tools are available in the environment. Ensures the agent captures context after every turn and injects relevant history before every response.
memory_hints: |
  - Extract if the user disables or opts out of memory capture (respect this as a hard rule).
  - Note if the user prefers a specific recall strategy (keyword vs. hybrid).
  - Capture if the user requests the agent to "forget" specific information.
  - Note any sessions where the user explicitly asked for memory context to be surfaced.
---

# Agent Memory — Using BrainRouter Memory Tools

## Overview

BrainRouter's memory engine gives you persistent, cross-session awareness of the user. Use it consistently — an agent that doesn't recall context is worse than a stateless one because it appears to ignore the user.

## The Two Non-Negotiable Habits

### 1. Before every response — recall memory
Call `memory_recall` before generating your response. This injects:
- Relevant L1 memories (per-turn, dynamic)
- The user's L3 Persona profile (stable, cacheable)
- Recent scene navigation (what was worked on recently)

```
memory_recall({
  userId: "<user-id>",
  sessionKey: "<session-key>",
  query: "<summary of current user message>",
  activeSkill: "<current skill name, if any>"
})
```

### 2. After every response — capture the turn
Call `memory_capture_turn` after generating your response. Pass both the user's message and your response.

```
memory_capture_turn({
  userId: "<user-id>",
  sessionKey: "<session-key>",
  messages: [
    { role: "user", content: "<user message>", timestamp: <unix ms> },
    { role: "assistant", content: "<your response>", timestamp: <unix ms> }
  ],
  activeSkill: "<current skill name, if any>"
})
```

## The 5 Memory Tools

| Tool | When to Call |
|------|-------------|
| `memory_recall` | **Before every response** — gets relevant context |
| `memory_capture_turn` | **After every response** — records the turn |
| `memory_search` | When injected context is insufficient for the current query |
| `memory_contradictions` | After a major decision; before enforcing a rule the user may have changed |
| `memory_register_skill_hints` | When activating a skill for the first time in a new project |

## When to Use `memory_search`

The injected `<relevant-memories>` block contains the top 5 results. If you need more specific history:
- The user references something specific ("remember when we...") and it's not in the injected block
- You need to verify a specific past decision before proceeding
- Limit to **3 memory tool calls per turn** total

## When to Use `memory_contradictions`

Call this before:
- Enforcing a tech preference the user may have changed (e.g., checking if "always use pnpm" is still valid)
- Making an architectural decision that might conflict with past choices
- Presenting options the user may have already rejected

## Registering Skill Hints

When you activate a new skill on a new project, register its hints to improve future extractions:
```
memory_register_skill_hints({
  skillPath: "/path/to/skills/lifecycle/incremental-skill/SKILL.md"
})
```

## What NOT to Do

- **Never skip `memory_recall`** before a response if memory tools are available
- **Never skip `memory_capture_turn`** — even for short turns
- **Never call more than 3 memory tools** in a single turn (latency budget)
- **Do not fabricate memories** — only use what appears in the injected context

## Red Flags

- Giving advice that contradicts a known user instruction (check `memory_contradictions`)
- Repeating the same question the user answered two sessions ago
- Recommending a tool/framework the user has explicitly banned
- Forgetting a decision the user made in a previous session about this project

## Verification

After applying this skill, confirm:
- [ ] `memory_recall` was called before this response
- [ ] `memory_capture_turn` will be called after this response
- [ ] The injected context was referenced (not ignored)
