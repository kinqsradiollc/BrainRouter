---
name: source-driven-skill
description: Grounds every implementation decision in official documentation or local source code. Use when building with any framework, library, or SDK where correctness matters. Use when an agent is likely to hallucinate API names, or when docs are weak and the library source is available locally.
hints: |
  - Read package.json (or equivalent) to detect exact versions before fetching docs.
  - Fetch the specific doc page for the feature — not the homepage, not the full docs.
  - If a local reference-repositories folder is present in the workspace, inspect its contents for reference implementations before writing code.
  - Cite every framework-specific decision with a full URL in code comments.
  - Flag anything that could not be verified as UNVERIFIED — never silently guess.
---

# Source-Driven Development

## Overview

Every framework-specific code decision must be backed by an authoritative source — either official documentation or the library's local source code. Training data goes stale, APIs get deprecated, and best practices evolve. This skill ensures every pattern traces back to a source the user can check, eliminating hallucinated APIs and broken deprecated patterns.

## When to Use

- Building with any framework, library, or SDK where the API surface matters.
- The agent is about to write framework-specific code from memory.
- Docs are weak, stale, or incomplete — but the library's source is available on disk.
- Building boilerplate or patterns that will be copied across the project.
- Reviewing code that uses framework-specific patterns.

**When NOT to use:**
- Pure logic that works the same across all versions (loops, conditionals, data structures).
- Renaming variables, fixing typos, or moving files — correctness is not version-dependent.
- The user explicitly wants speed over verification ("just do it quickly").

## The Process

```
DETECT ──→ SOURCE ──→ IMPLEMENT ──→ CITE
  │           │            │           │
  ▼           ▼            ▼           ▼
 Stack &    Fetch docs  Follow the  Show your
 versions   or search   documented  sources
            local repo  patterns
```

### Step 1: Detect Stack and Versions

Read the project's dependency file to identify exact versions:

```
package.json            → Node / React / Vue / Angular / Svelte
composer.json           → PHP / Symfony / Laravel
requirements.txt        → Python / Django / Flask
go.mod                  → Go
Cargo.toml              → Rust
Gemfile                 → Ruby / Rails
```

State what you found explicitly before doing anything else:

```
STACK DETECTED:
- React 19.1.0 (from package.json)
- Vite 6.2.0
→ Fetching official docs for the relevant patterns.
```

If versions are missing or ambiguous, **ask the user**. The version determines which patterns are correct.

### Step 2: Get the Source

#### Option A — Official Documentation (default)

Fetch the **specific documentation page** for the feature being implemented. Not the homepage. Not the full docs.

**Source hierarchy (in order of authority):**

| Priority | Source | Example |
|----------|--------|---------|
| 1 | Official documentation | react.dev, docs.djangoproject.com |
| 2 | Official blog / changelog | react.dev/blog, nextjs.org/blog |
| 3 | Web standards references | MDN, web.dev |
| 4 | Browser/runtime compatibility | caniuse.com, node.green |

**Never cite as primary sources:** Stack Overflow, blog posts, tutorials, AI-generated summaries, or training data.

```
BAD:  Fetch the React homepage
GOOD: Fetch react.dev/reference/react/useActionState

BAD:  Search "django authentication best practices"
GOOD: Fetch docs.djangoproject.com/en/6.0/topics/auth/
```

#### Option B — Local Source & Open Source References (when docs are weak or missing)

If reference repositories or libraries are available locally in the workspace (for example, in a `reference/repos/` folder), search them directly. This is the most current and practical source possible to discover working API usage patterns and connection/error-handling structures.

**Setup / Discovery:**
1. Check if a local reference-repositories folder exists at the workspace root. If present, list its directories to see what reference repositories (your local reference repos) are available.
2. Place or look for local reference repos under: `reference/repos/github.com/company/project`
3. Add a note to your `AGENT.md` or `CLAUDE.md`:

```md
When working with <library/tool>, reference the local open-source repos under:
`reference/repos/<repo-name>`.
Do not guess API signatures. Search the source first, then implement.
```

**Feature prompt template / workflow:**

```md
Build <feature>. We use <library/tool>.

Before coding:
1. If available, search the `reference/repos/` folder for reference implementation examples of this library.
2. Identify the specific files/functions/patterns you are using as a model.
3. Implement only the minimal service function and one calling component.
4. Keep the diff small and clean.
5. Explain which reference source files you inspected.
```

### Step 3: Implement Following the Source

- Use the API signatures from the source, not from memory.
- If the source shows a new way to do something, use the new way.
- If the source marks something as deprecated, don't use it.
- If the source doesn't cover something, flag it as unverified.

**When source conflicts with existing project code:**

```
CONFLICT DETECTED:
The existing codebase uses useState for form loading state,
but React 19 docs recommend useActionState for this pattern.
Source: react.dev/reference/react/useActionState

Options:
A) Use the modern pattern (useActionState) — consistent with current docs
B) Match existing code (useState) — consistent with codebase
→ Which approach do you prefer?
```

Surface the conflict. Don't silently pick one.

### Step 4: Cite Your Sources

Every framework-specific decision gets a citation — in code and in conversation.

**In code comments:**

```typescript
// React 19 form handling with useActionState
// Source: https://react.dev/reference/react/useActionState#usage
const [state, formAction, isPending] = useActionState(submitOrder, initialState);
```

**Citation rules:**
- Full URLs — not shortened
- Deep links with anchors preferred (e.g. `/useActionState#usage`)
- Quote the relevant passage for non-obvious decisions
- If you cannot find documentation, say so explicitly:

```
UNVERIFIED: I could not find official documentation for this pattern.
This is based on training data and may be outdated. Verify before using in production.
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'm confident about this API" | Confidence is not evidence. Training data contains outdated patterns that look correct but break against current versions. Verify. |
| "Fetching docs wastes tokens" | Hallucinating an API wastes more. One fetch prevents hours of debugging a wrong function signature. |
| "The docs won't have what I need" | If the docs don't cover it, that's valuable signal — the pattern may not be officially recommended. Check local source next. |
| "I'll just mention it might be outdated" | A disclaimer doesn't help. Either verify and cite, or clearly flag it as UNVERIFIED. Hedging is the worst option. |
| "This is a simple task, no need to check" | Simple tasks with wrong patterns become templates. The user copies your deprecated form handler into ten components before discovering the modern approach. |
| "I can't find the API so I'll add a new dependency" | Search the local source first. The API may exist and simply be undocumented. |

## Red Flags

- Writing framework-specific code without checking docs or local source for that version.
- Using "I believe" or "I think" about an API instead of citing the source.
- Citing Stack Overflow or blog posts as primary sources.
- Using deprecated APIs because they appear in training data.
- Not reading `package.json` (or equivalent) before implementing.
- Delivering code without citations for framework-specific decisions.
- Installing an alternative package because the agent couldn't find the existing API.

## Verification

After implementing with source-driven development, confirm:

- [ ] Framework and library versions were identified from the dependency file.
- [ ] Official documentation or local source was consulted for framework-specific patterns.
- [ ] All citations are official sources — not blog posts or training data.
- [ ] Code follows the patterns shown in the current version's documentation.
- [ ] Non-trivial decisions include source citations with full URLs.
- [ ] No deprecated APIs are used (checked against migration guides).
- [ ] Conflicts between source and existing code were surfaced to the user.
- [ ] Anything that could not be verified is explicitly flagged as UNVERIFIED.
