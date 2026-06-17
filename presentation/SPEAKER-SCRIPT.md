# BrainRouter — Investor Pitch · Speaker Script

**Presenter:** Anh Dang
**Deck:** `BrainRouter-Investor-Deck.pptx` (13 slides) — clean, **no numbers on screen**
**Audience:** investors / business · **Target:** ~12 min + Q&A

### One thing to fill in
- Slide 1: `[ Event ]` (your name and contact are already in the deck).

### Why there are no numbers on the slides
You asked to keep numbers off for now. The slides stay clean and story-driven. **The hard benchmark figures live in the "Optional proof points" appendix at the bottom** — say them out loud if an investor pushes for proof, or drop them onto Slides 8/10 later when you're ready.

### Delivery rules
- One idea per slide. Say the line — let them read the slide.
- Pause after each big claim. Silence makes it land.
- **Bold lines** are near-verbatim. The rest is a guide.
- `✂` marks slides you can drop to hit a tight 10 minutes.

---

## Slide 1 — Title · *"Agents that remember."*  ⏱ ~0:45

**On screen:** Wordmark, "Agents that remember.", Live on npm · Open source, memory-graph motif.

**Say:**
> "Hi, I'm **Anh Dang**. Every AI agent today is missing one thing — and it's not a smarter model. It's **memory**.
>
> This is **BrainRouter** — **the memory layer for AI agents.** It's live, it's open source, and I'll show you why it's becoming infrastructure."

**Transition:** "Let me start with the problem — you've probably felt it."

---

## Slide 2 — The problem · *"Starts from zero."*  ⏱ ~1:00

**On screen:** "Every session, your agent starts from zero." + First chat / A week later / A month later, each "context rebuilt from scratch."

**Say:**
> "AI agents have no memory between conversations. **Every session, they start from zero.**
>
> First chat, a week later, a month later — your agent re-learns the same facts, re-reads the same files, re-asks the same questions. Every time. You can have the smartest model on earth, and it **still has amnesia.**
>
> That's a cost problem and a trust problem — the agent never gets to know your business."

**Read aloud:** *"The smartest model in the world still has amnesia."*

**Transition:** "The industry has workarounds. They don't hold up."

---

## Slide 3 — Why it's hard · *"Today's fixes don't scale."*  ⏱ ~1:00

**On screen:** Three cards — Dump the history / Flat vector DB / Static prompts — + bottom banner.

**Say:**
> "Three common fixes, and each one breaks.
>
> **Dump the history** into the prompt — that blows the context window and burns tokens. Every conversation costs more than the last.
>
> **A flat vector database** returns what's mathematically close, not what's actually useful. Noise in, noise out.
>
> **Static, hand-written prompts** have no feedback loop. The agent never learns what worked.
>
> Put them together and you get agents that are **expensive, forgetful, and never improving.**"

**Transition:** "We took a different approach — we copied the one memory system that works."

---

## Slide 4 — The insight · *"Model memory like the brain."*  ⏱ ~0:50  ✂

**On screen:** Flow: Dialogue → Short-term buffer → Long-term store → Identity + active task. Decay / Reinforcement / Graph.

**Say:**
> "Human memory. Short-term feeds long-term. What you stop using **fades.** What you use again **gets stronger.** And memories are **connected** — one reminds you of another.
>
> Three principles: **decay, reinforcement, and a graph.** That's the whole model — and it's what a flat database can't do."

**✂ If tight:** say the bold line and move on.

**Transition:** "Here's how we built it."

---

## Slide 5 — What we built · *"A cognitive memory engine."*  ⏱ ~0:55

**On screen:** Four layers — SensoryStream / CognitiveRecord / ContextualFocus / CoreIdentity — with lifetime tags.

**Say:**
> "BrainRouter is a **cognitive memory engine** with four layers, each with its own lifetime.
>
> Raw conversation lands in a **short-term buffer.** The important facts get classified and stored **long-term, and they decay** if they go unused. Active work clusters into **focus scenes.** And who you are — your profile and your hard rules — becomes a **permanent core identity** that's always in the prompt.
>
> The system decides what's worth keeping."

**Transition:** "The real magic is retrieval — getting the right memory back at the right moment."

---

## Slide 6 — How recall works · *"The right memories, on every prompt."*  ⏱ ~1:00

**On screen:** Pipeline: Query → Retrieve → Fuse & rank → Judge → Graph walk → Prompt. Callout banner.

**Say:**
> "Every prompt runs a pipeline. **Three retrievers** in parallel — keyword, vector, and file-path — get **fused and ranked** by how fresh and how-often-used each memory is.
>
> Then an **LLM judge** throws out the things that matched a keyword but aren't actually about the question. And a **graph walk** pulls in related facts the search alone would've missed.
>
> What reaches the prompt is **only what's relevant — a sliver of the context, never the whole history.**"

*(Proof point if asked: it's roughly a few hundred tokens instead of millions — see appendix.)*

**Transition:** "And the part that makes it a moat: it learns."

---

## Slide 7 — Why it's different · *"It doesn't just store — it learns."*  ⏱ ~1:00

**On screen:** Four rows — It forgets / It reinforces / It judges / It connects.

**Say:**
> "Four things separate this from a vector DB.
>
> **It forgets** — memories fade on a half-life. Instructions stay forever; code facts fade faster than who you are. The index stays clean.
>
> **It reinforces** — when the agent actually uses a memory, that memory gets stronger and its clock resets. Useful facts rise to the top.
>
> **It judges** — an LLM relevance check drops the off-topic stuff before it pollutes the prompt.
>
> **It connects** — the graph surfaces related facts nothing else would find.
>
> A flat database just returns. **BrainRouter learns which records matter.**"

**Transition:** "So what does all that buy you?"

---

## Slide 8 — The payoff · *"What that buys you."*  ⏱ ~0:55  ★

**On screen:** Four cards — Fewer tokens / Faster replies / Sharper recall / Flat cost at scale. Proof line below.

**Say:**
> "Four things. **Fewer tokens** — you send a sliver of the context, not the whole history. **Faster replies** — less for the model to read. **Sharper recall** — the right memory surfaces nearly every time. And the one I love: **flat cost as the agent remembers more** — your spend doesn't balloon as memory grows.
>
> This is all **benchmarked, reproducible, and open.** The proof is ready when you are."

> *(If an investor wants hard numbers, give them — see appendix. Otherwise leave the door open: "happy to walk you through the benchmarks after.")*

**Read aloud:** *"The cost stays flat no matter how much your agent remembers."*

**Transition:** "And it's not a demo — it's a shipping product, on four surfaces."

---

## Slide 9 — The product · *"One store. Four ways to plug in."*  ⏱ ~1:00

**On screen:** 2×2 — MCP Server · Terminal CLI · Desktop App · Web Dashboard. "All four share the same brain."

**Say:**
> "One memory store, four front doors.
>
> The **MCP server** drops memory into any compatible client — Claude Desktop, Cursor, your own agent. The **terminal CLI** is a full memory-native coding agent. The **desktop app** is a native Mac and Windows shell over the same engine. And the **web dashboard** lets you actually see the memory — what was recalled, what contradicts what.
>
> **All four share the same brain.** Sign in once; every surface sees the same memory."

**Transition:** "And we're moving fast."

---

## Slide 10 — Traction · *"Shipping, in the open."*  ⏱ ~0:50  ✂

**On screen:** Live on npm / Weekly releases / Public benchmarks / MIT licensed. Milestone strip: Parity → Desktop.

**Say:**
> "The engine and CLI are **live on npm today.** We ship on a **weekly cadence** — every release adds a capability you've seen here. Our **benchmarks are public** and anyone can re-run them. And it's **MIT-licensed, open end to end.**
>
> The strip at the bottom is the path so far — parity, workflows, the dashboard, the build loop, the accuracy work, and now desktop. This is a team that ships."

**✂ If tight:** "Live on npm, weekly releases, public benchmarks, fully open source — we ship every week." Move on.

**Transition:** "So why does this matter now?"

---

## Slide 11 — Why now · *"Memory is becoming its own layer."*  ⏱ ~1:05  ★

**On screen:** Three cards — Agents are everywhere · A foundational layer · Cross-vendor by design. Bottom banner.

**Say:**
> "**Agents are everywhere** now — coding, support, ops, research — and every one hits the same wall: no memory.
>
> History rhymes. **The database was to apps what memory is to agents** — a foundational layer, not a feature you bolt on. That layer is forming right now, and it's up for grabs.
>
> And we built it **cross-vendor on purpose.** Federation lets agents on any vendor share one brain. We're not betting on one model winning — we're the neutral memory standard underneath all of them.
>
> **We're not building a better chatbot. We're building the memory infrastructure underneath all of them.**"

**Read aloud:** the bottom banner, verbatim.

**Transition:** "Here's where it goes."

---

## Slide 12 — Roadmap · *"Where it's going."*  ⏱ ~0:50  ✂

**On screen:** NOW · NEXT · SOON · VISION.

**Say:**
> "**Now**, the engine and the multi-agent CLI are solid, with a live view of the running fleet. **Next** is full agent-runtime parity and the desktop app in alpha. **Soon**, a plugin and skill **marketplace**, and live sync with Git and GitHub so the agent stays current on your real work.
>
> And the **vision** is simple: the memory standard every agent — on any vendor — plugs into."

**Transition:** "So — let's talk."

---

## Slide 13 — Close · *"Agents that remember."*  ⏱ ~0:40

**On screen:** Wordmark, "Agents that remember.", GitHub + npm, "Let's talk. Anh Dang · anhdang@kinqsradio.com".

**Say:**
> "BrainRouter — **the cognitive memory layer for AI agents.** It's open, it's on npm, and it works today.
>
> [If raising:] "**We're raising [amount] to [hire / scale the brain / land design partners].** If you back the infrastructure layer of the agent era, let's talk."
>
> [If showcase:] "Try it tonight — one npm install. If memory for agents is a space you care about, let's talk."
>
> Thank you."

**Then:** stop. Let the contact line sit on screen for Q&A.

---

## Q&A — likely questions + crisp answers

**"How is this different from a vector DB / from [memory product X]?"**
> "A vector DB only returns nearest neighbors. We add three things: decay so the index stays clean, reinforcement so used facts win, and an LLM judge plus a graph walk so we return what's *relevant*, not just what's close. And it's cross-vendor — one brain, any model."

**"What's the moat — couldn't a foundation-model company add this?"**
> "Three things. One, the learning loop and the benchmarks are a real engineering lead, and we ship weekly. Two, we're deliberately neutral — we work across every vendor, which a model company won't. Three, the data flywheel: the more an agent is used, the better its memory gets, and that memory is sticky."

**"How do you make money?"**
> "Open-core. The engine and CLI are MIT and drive adoption. Revenue is the hosted brain — managed, multi-agent, team memory — plus enterprise: self-hosted, governance, audit, SSO. [Adjust to your plan.]"

**"Who's using it?"**
> "[Fill in honestly: design partners / community / your own usage.] It's live on npm with a weekly cadence; the next phase is landing named design partners." *(Don't invent users.)*

**"Privacy — where does memory live?"**
> "In a local store you control; the hosted option is opt-in. Nothing leaves the box unless you connect it. There's a governance layer — audit log, verify, archive — built in."

---

## Optional proof points  (★ verbal only — NOT on the slides yet)

Use these if an investor asks for hard evidence, or paste them onto Slides 8/10 when you're ready to show numbers. All are from the committed, reproducible benchmark suite in the repo.

| Claim | Number | Source |
|---|---|---|
| Fewer prompt tokens vs. full-context dump (end-to-end) | **~95% fewer** | END-TO-END suite |
| Faster responses, same task | **~73% faster** | END-TO-END suite |
| Recall@10 on LongMemEval-S (500 questions) | **0.99** | retrieval suite |
| Token budget at any corpus size | **~450 tokens** (vs. 2.2M at 50k facts) | scale suite |
| Code-symbol isolation | **100%** | code-recall suite |
| Releases shipped (cadence) | **10 in ~6 weeks** | changelog |

**How to use verbally:** "We've benchmarked this — about 95% fewer tokens and 73% faster than dumping the full context, with near-perfect recall, and the cost stays flat as memory grows. It's all reproducible in the repo; happy to walk you through it."

---

## Live demo (optional, 60–90s — strong if the room is technical)
1. **`brainrouter` → ask a question → the recall briefing appears before the answer** ("watch it pull the right memories, then answer").
2. **`/where`** — one screen: workspace, goal, plan, recalled memories, child agents.
3. **`/agents tree`** mid-run — live parallel explorers/reviewers.
Rehearse once offline; the CLI still boots in offline mode if wifi is bad.

---

## Timing
| # | Slide | Time | Cut? |
|---|---|---|---|
| 1 | Title | 0:45 | |
| 2 | Problem | 1:00 | |
| 3 | Workarounds | 1:00 | |
| 4 | Insight | 0:50 | ✂ |
| 5 | Engine | 0:55 | |
| 6 | Recall | 1:00 | |
| 7 | Moat | 1:00 | |
| 8 | Payoff | 0:55 | ★ |
| 9 | Product | 1:00 | |
| 10 | Traction | 0:50 | ✂ |
| 11 | Why now | 1:05 | ★ |
| 12 | Roadmap | 0:50 | ✂ |
| 13 | Close | 0:40 | |
| | **Total** | **~12:10** | drop the ✂ for a tight ~10:00 |
