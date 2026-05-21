---
name: code-structure-cleanup
description: Guides a service-layer extraction pass after an AI-built feature ships. Use when feature code works but contains duplicated mechanics, repeated API calls, or copy-pasted logic across multiple callers. Use when deciding what belongs in shared services vs. domain-specific actions.
hints: |
  - Run cleanup AFTER the feature works, never during feature development.
  - Extract only logic repeated across 2+ callers — never abstract singletons.
  - Keep domain rules (auth, error classification, status transitions) in actions.
  - Replace one caller first, verify, then migrate the rest.
  - Keep the diff small and focused on the feature area only.
---

# Code Structure Cleanup & Service Layer Architecture

## Overview

AI agents often take the easiest path: they create new functions instead of reusing existing ones. A feature can work while still leaving behind duplicated logic, inconsistent validation, and repeated API calls that future agents will struggle to debug.

The fix is a two-layer architecture: **actions orchestrate domain rules** (the "why/when"), while a **service layer centralizes reusable mechanics** (the "how"). Run the cleanup pass after the feature works — not before, and not during.

## When to Use

- A feature works but the code has duplicated mechanics across multiple files.
- Multiple callers perform the same low-level operation (email sending, sandbox creation, API calls, data parsing).
- The agent created similar helper functions in different files.
- A bug fix in one flow was not propagated to other flows doing the same thing.

**When NOT to use:** Logic used by only one caller — extracting it is over-abstraction. Do not use this as permission to redesign the whole app.

## The Service Layer Pattern

```
Orchestration Layer (Actions)          Service Layer (Shared Mechanics)
├── owns business rules                ├── owns reusable operations
├── owns state transitions             ├── owns provider/SDK interactions
├── owns auth/ownership checks         ├── owns command execution details
├── owns failure classification        ├── owns health checks / readiness
├── owns retries / user-facing errors  └── returns structured results
└── calls service functions
```

**Decision rule:**
- "What this product flow means" → keep in actions
- "How to do this operation reliably" → move to service layer

### Designing Service Functions

Design as **capability blocks**, not monoliths. Each function should:
- Accept all required data as **explicit parameters** (no hidden global state)
- Return **structured outputs** — e.g., `{ ready, previewUrl, proxyPort }`
- Never reach into the database or domain state directly
- Make failure explicit (structured results, not swallowed errors)

```ts
// Good: composable blocks — each caller picks what it needs
createManagedSandbox(...)
prepareRepo(...)
detectPackageManager(...)
installDependencies(...)
runBuildCommand(...)

// Bad: one god function that hides all control flow
doEverythingForSandbox(...)
```

## Cleanup Process

### Step 1: Run the Cleanup Prompt

```md
The feature is working. Now do a code-structure cleanup pass.

Goal:
- Find duplicated runtime mechanics, repeated API calls, repeated parsing, repeated validation.
- Move repeated mechanics into reusable service-layer functions/modules.
- Keep domain policy (auth, status transitions, error classification) in the calling route/action.
- Do not change user-facing behavior.
- Keep the diff small.

Process:
1. Inspect the files touched by the feature.
2. Identify repeated logic and name the duplication clearly.
3. Propose the smallest service-layer extraction.
4. Implement it.
5. Run the relevant tests/typechecks.
6. Summarize exactly what got simpler.
```

### Step 2: Migrate Incrementally

1. Write the flow in action code first — establish clear behavior.
2. Mark repeated operational chunks across callers.
3. Extract **only** repeated, non-domain chunks to a service function.
4. Replace **one caller first** → verify tests pass → replace remaining callers.
5. Run typecheck, lint, and confirm all flows still work.

### Example: Email Service

```ts
// emailService.ts — shared mechanics (the "how")
export async function sendWelcomeEmail(params: { to: string; name: string }) {
  const html = `<h1>Welcome ${params.name}</h1>`;
  await emailProvider.send(params.to, "Welcome", html);
}

// userSignup.ts — orchestration (the "when" — different business rule)
if (user.marketingOptIn) {
  await sendWelcomeEmail({ to: user.email, name: user.name });
}

// adminInvite.ts — orchestration (same mechanic, different domain rule)
await sendWelcomeEmail({ to: invitee.email, name: invitee.name });
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll clean it up later" | Later never comes. AI agents copy existing patterns — duplicated code compounds with every new feature. |
| "It's only in two places" | Two callers is exactly when to extract. Three callers means the window for clean extraction is closing. |
| "Cleanup will change behavior" | It should not. Behavior-changing cleanup is a bug fix or refactor — do it separately. |
| "I'll just refactor the whole module while I'm here" | Unscoped cleanup creates risky diffs and noisy PRs. Stay focused on the feature area. |
| "The service should handle business logic too" | Services own mechanics, not decisions. Auth, error classification, and policy stay in actions. |

## Red Flags

- A bug fix applied in one flow was not applied to other flows doing the same thing.
- Helper functions with the same logic scattered across action files.
- Service functions that directly mutate database tables or domain state.
- A single "do-everything" service function hiding all control flow.
- Cleanup and feature development mixed in the same PR.
- Extracting logic used by only one caller (premature abstraction).

## Verification

After completing the cleanup pass, confirm:

- [ ] User-facing behavior is unchanged (existing tests still pass).
- [ ] Duplicated mechanics were reduced — callers now share the extracted function.
- [ ] Calling files became simpler, not more complex.
- [ ] Domain policy (auth, transitions, error classification) remained in actions.
- [ ] Typecheck and lint passed.
- [ ] Diff is focused on the feature area — no unrelated changes mixed in.
