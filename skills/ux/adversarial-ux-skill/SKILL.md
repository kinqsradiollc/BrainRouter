---
name: adversarial-ux-skill
description: Roleplay the most difficult, tech-resistant user for your product. Find every UX pain point, filter complaints pragmatically, and create actionable tickets.
hints: |
  - Define a highly specific, low-tech, and easily frustrated user persona to guide the review.
  - Browse and interact with the application strictly in character to uncover friction.
  - Assess critical user paths, onboarding steps, error messaging, and terminology clarity.
  - Apply the Pragmatism Filter to separate valid UX bugs/improvements from persona-specific noise.
  - Translate verified friction points into precise, highly actionable development tickets.
---

# Adversarial UX Test

## Overview

Roleplay the worst-case user for your product — the person who hates technology, doesn't want your software, and will find every reason to complain. Then filter their feedback through a pragmatism layer to separate real UX problems from "I hate computers" noise.

Think of it as an automated "mom test" — but angry.

## Why This Works

Most QA finds bugs. This finds **friction**. A technically correct app can still be unusable for real humans. The adversarial persona catches:
- Confusing terminology that makes sense to developers but not users.
- Too many steps to accomplish basic tasks.
- Missing onboarding or "aha moments."
- Accessibility issues (font size, contrast, click targets).
- Cold-start problems (empty states, no demo content).
- Paywall/signup friction that kills conversion.

The **pragmatism filter** (Phase 4) is what makes this useful instead of just entertaining. Without it, you'd add a "print this page" button to every screen because a user can't figure out PDFs.

---

## The Workflow

### Step 1: Define the Persona

If no persona is provided, generate one by answering:
1. **Who is the HARDEST user for this product?** (age 50+, non-technical role, decades of experience doing it "the old way")
2. **What is their tech comfort level?** (the lower the better — messaging apps only, paper notebooks, others set up their email)
3. **What is the ONE thing they need to accomplish?** (their core job, not your feature list)
4. **What would make them give up?** (too many clicks, jargon, slow, confusing)
5. **How do they talk when frustrated?** (blunt, dismissive, sighing)

#### Good Persona Example
> **"Big Mick" McAllister** — 58-year-old strength coach. Uses messaging apps and that's it. His "spreadsheet" is a paper notebook. "If I can't figure it out in 10 seconds I'm going back to my notebook." Needs to log session results for 25 players. Hates small text, jargon, and passwords.

#### Bad Persona Example
> "A user who doesn't like the app" — too vague, no constraints, no voice.

The persona must be **specific enough to stay in character** for the duration of testing.

### Step 2: Become the Adversary (Browse in Character)

1. Read any available project docs for app context and URLs.
2. **Fully inhabit the persona** — their frustrations, limitations, and core goals.
3. Navigate to the app using browser testing tools.
4. **Attempt the persona's ACTUAL TASKS** (not a feature tour):
   - Can they do what they came to do?
   - How many clicks/screens to accomplish it?
   - What confuses them?
   - What makes them angry?
   - Where do they get lost?
   - What would make them give up and go back to their old way?

5. Test these friction categories:
   - **First impression** — would they even bother past the landing page?
   - **Core workflow** — the ONE thing they need to do most often.
   - **Error recovery** — what happens when they do something wrong?
   - **Readability** — text size, contrast, information density.
   - **Speed** — does it feel faster than their current paper/manual method?
   - **Terminology** — any jargon they wouldn't understand?
   - **Navigation** — can they find their way back? Do they know where they are?

6. Document every pain point with clear details.
7. Check browser console for JS errors on every page.

### Step 3: The Rant (Write Feedback in Character)

Write the feedback AS THE PERSONA — in their voice, with their frustrations. This is not a formal bug report. This is a real human venting.

```
[PERSONA NAME]'s Review of [PRODUCT]

Overall: [Would they keep using it? Yes/No/Maybe with conditions]

THE GOOD (grudging admission):
- [things even they have to admit work]

THE BAD (legitimate UX issues):
- [real problems that would stop them from using the product]

THE UGLY (showstoppers):
- [things that would make them uninstall/cancel immediately]

SPECIFIC COMPLAINTS:
1. [Page/feature]: "[quote in persona voice]" — [what happened, expected]
2. ...

VERDICT: "[one-line persona quote summarizing their experience]"
```

### Step 4: The Pragmatism Filter (Mandatory)

Step OUT of the persona. Evaluate each complaint as a product-focused engineer:

- <span style="color:red">**RED**</span>: **REAL UX BUG** — Any user would have this problem, not just grumpy ones. Fix it immediately.
- <span style="color:yellow">**YELLOW**</span>: **VALID BUT LOW PRIORITY** — Real issue but only for extreme, low-tech users. Note it.
- <span style="color:gray">**WHITE**</span>: **PERSONA NOISE** — "I hate computers" resistance talking, not a product problem. Skip it.
- <span style="color:green">**GREEN**</span>: **FEATURE REQUEST** — Good idea hidden in the complaint. Consider it.

#### Filter Criteria
1. Would a 35-year-old competent-but-busy user have the same complaint? → **RED**
2. Is this a genuine accessibility issue (font size, contrast, click targets)? → **RED**
3. Is this "I want it to work like paper" resistance to digital? → **WHITE**
4. Is this a real workflow inefficiency the persona stumbled on? → **YELLOW** or **RED**
5. Would fixing this add complexity for the 80% who are fine? → **WHITE**
6. Does the complaint reveal a missing onboarding moment? → **GREEN**

**This filter is MANDATORY.** Never ship raw persona complaints directly as tickets.

### Step 5: Create Tickets

For **RED** and **GREEN** items only:
- Clear, actionable title.
- Include the persona's verbatim quote (memorable and grounding).
- The real UX issue underneath (objective).
- A suggested fix (actionable).
- Tag/label: `ux-review`.

For **YELLOW** items, create one catch-all ticket with all notes. Skip **WHITE** items.

---

## When to Use

- Before major releases, public launches, or client demonstrations to audit visual and functional friction.
- After implementing major workflows, complex forms, or core onboarding steps.
- When conversion rates drop or user drop-off is detected at key interface funnels.
- Conducting accessibility and readability sweeps of user-facing screens.

**When NOT to use:**
- Reviewing backend microservice algorithms, database transactions, or system infrastructure that lacks visual UI components.
- Initial API design phases where endpoints are completely headless and have no consumer UI built.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Users will just read the documentation if they get confused." | Users do not read manuals. If a workflow requires reading documentation to complete, the user interface design is fundamentally flawed. |
| "Our target audience is young and tech-savvy, so they won't struggle." | Even tech-savvy users suffer from cognitive fatigue, distractions, and interface clutter. High usability benefits every demographic. |
| "This bug is trivial; only a very impatient user would complain." | Small points of friction multiply. When a user experiences three consecutive minor frustrations, they abandon the app entirely. |

## Red Flags

- Roleplaying a highly knowledgeable, tech-support developer persona rather than an impatient, non-technical everyday user.
- Forwarding raw, angry persona complaints directly as tickets without running the mandatory Pragmatism Filter.
- Skipping critical first-impression onboarding flows and testing only with pre-authenticated admin user accounts.
- Testing on highly specialized administrative setup pages rather than the primary core workflow paths.

## Verification

After completing the UX audit, verify:
- [ ] Grumpy, non-technical persona is defined with clear, challenging constraints before testing begins.
- [ ] User task flows (e.g. sign-up, create item, complete flow) are completed in-character.
- [ ] Visceral, authentic user review document is composed capturing usability pain points.
- [ ] Pragmatism Filter is applied and categorizes complaints into Red, Yellow, White, or Green buckets.
- [ ] Actionable development tickets are created for all Red (bugs) and Green (onboarding/features) issues.
