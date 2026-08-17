# ADR status tracker

A single view of where each decision stands. Updated 2026-08-17. Foundational
ADRs 001–016 (async store, core extraction, service decomposition, tenancy,
providers-DB, GitHub linking, connectors) are implemented and long-shipped; the
active era is tracked below. Status lives authoritatively in each ADR's own
`**Status:**` line — this table is the index.

| ADR | Title | Status | Where |
|----|-------|--------|-------|
| 017 | Production flows: org/team + PR-security bot | ✅ Implemented | 0.4.20 |
| 018 | Meetings: local capture, server transcription | ✅ Implemented (via ADR-035) | 0.4.20 |
| 019 | Org/workspace switcher + Overview parity | ✅ Implemented | 0.4.17 |
| 020 | Memory self-improvement loop | ✅ Implemented (P0–P3) | 0.4.18 |
| 021 | Workspace onboarding + typed profiles | ✅ Implemented | 0.4.17 |
| 022 | Persona orchestration + context contracts | ✅ Implemented | 0.4.17 |
| 023 | Profile-specific orchestration plans | ✅ Implemented | 0.4.17 |
| 024 | Agent-work assurance + browser reliability | ✅ Implemented (phased) | 0.4.17 |
| 025 | Repository assurance + runtime-boundary modernization | ✅ Implemented (phased) | 0.4.17–0.4.18 |
| 026 | Desktop native visual system | ✅ Implemented (publication paused) | 0.4.18 |
| 027 | Compounding-debt graph execution + workbench | ✅ Implemented (P0–P2) | 0.4.19 |
| 028 | Surfaces that tell the truth | ✅ Implemented | 0.4.20 |
| 029 | One workspace, many surfaces | ✅ Implemented (A–F) | 0.4.20 |
| 030 | Documents the agent can actually read | ✅ Implemented | 0.4.20 |
| 031 | A design skill + the capability it belongs to | ✅ Implemented | 0.4.20 |
| 032 | An agent that gets better and cannot get worse | 🟡 Partial | 0.4.20 |
| 033 | Review that finds things, and says where | 🟡 Partial | 0.4.20 |
| 034 | Messages that arrive | ✅ Implemented (3 exports to wire/delete) | 0.4.20 |
| 035 | A meeting you cannot lose | ✅ Implemented | 0.4.20 |
| 036 | The finding carries its code | ✅ Implemented | 0.4.20 |
| **037** | **Credentials the page cannot read** | **✅ Implemented (live-QA the §5 test)** | **0.4.21** |
| 038 | A planner worth opening | ✅ Implemented | main |
| 039 | The half of security a model cannot see (taint) | 🟡 6 concrete vulns fixed (#1413/#1414/#1416); scanner already RUNS (CodeQL default setup, 243 alerts); engine track = **consume** its SARIF via the already-wired D1/D2/D6 seam (not build-from-scratch) | 0.4.21 |
| **040** | **One runtime, graphs of bounded loops** | **✅ Implemented** | **0.4.20** |
| 041 | Plug-and-play runtime | 🟡 A41-6 + D1 COMPLETE (registry + extension-unify); D4/D8/D10 in dedicated session | 0.4.21 |
| **042** | **Worktrees the agent can enter** | **✅ Implemented** | **0.4.21** |
| 043 | Egress at the user's edge | 🟡 S1 + S1b + S2 foundation (EdgeDialer seam) shipped; S3–S5 = tunnel/relay track | 0.4.21 |

## In flight / next

- **ADR-037** — the credentials-hardening program is **complete** (all 8 slices shipped to `release/0.4.21`): B1 revocable sessions, B2 boot-guard, B3 cookie+CSRF, D-1 identity, D-2 cookie transport (+ readable `br_csrf` double-submit cookie that survives reload), D-3 API key + tokens out of localStorage into memory, B4 cookie-path `/refresh` returns no body token. The dashboard now persists no credential to storage. Owner step: run §5's live acceptance test on the running stack.
- **Partial → finish:** ADR-032 and ADR-033 shipped partial to 0.4.20 and have room to complete.
- **ADR-041 (plug-and-play runtime):** two safe, behaviour-neutral foundations shipped to `release/0.4.21` — **A41-6** (`IMemoryStoreComposite`, removed 15 `as unknown as *Store` casts) and **D1 foundation** (#1418: the `ProviderRegistry` class replacing the `ReadonlyMap`, with `register`/`replace`/`dispose` + `hasBuiltin` — identical reads, the seam ADR-043 S2's `ProviderDialer` attaches to). **D1 is now complete** (#1418 foundation + #1423 extension-unify — extension providers are live to routing). The remaining architecture — D4 (`IAgent` + phase hooks), D8 (tool pipeline), D10 (execution worlds) — is being built in a **dedicated session** the owner dispatched (with 043 S3–S5); each is a hot-path refactor whose API shapes are the author's to define. Seams in place: `ProviderRegistry`, `EdgeDialer`.
- **ADR-043 (edge egress):** **S1 + S1b + the S2 EdgeDialer-seam foundation** shipped to `release/0.4.21` (#1420: `EdgeDialer` type + `directDialer` default over the existing dispatcher-factory seam, byte-identical). S3 (tunnel dialer over the relay), S4 (consent/telemetry/fallback), S5 (vendable-token path) are the behaviour-bearing egress track and remain — the gateway rate-shaper now does both reactive Retry-After parking *and* proactive per-key concurrency/rpm reservation (release-in-`finally`), with injectable budgets. **S2–S5 genuinely depend on ADR-041's `ProviderDialer`/`ProviderDefinition` seams** and are deferred until those land.
- **ADR-039 (taint analysis):** scope resolved to this-repo-only. **All six concrete vulnerabilities the ADR cites as evidence are fixed** (0.4.21): the "quadratic regex ~23s per PR comment" ReDoS (#1413), the "guard on three paths of four" LM Studio probe SSRF (#1414), and the three runtime provider SSRFs — embeddings / rerank / memory-pipeline chat — via a validate-then-fetch guard through `upstreamProbePolicy` that refuses an internal target before dialing, self-hosted local backends opting in via `BRAINROUTER_UPSTREAM_ALLOWLIST` (#1416). The general flow/taint **engine** is a dedicated multi-week track — and a grounded direction review (2026-08-17) corrected its shape before the dedicated session commits:
  - **It is an *integration*, not a build-from-scratch.** ADR §2 describes an off-the-shelf, database-first analyzer (declarative queries carrying precision/severity metadata, source→sink `path-problem` paths, source/sink/barrier taint model, model-as-data extensions, a separately-licensed CLI). **D3 forbids inventing our own filter** — so authoring a static analyzer is the one wrong direction the chip title ("build the engine") invites.
  - **The D1/D2/D6 ingestion seam is already wired.** `normalizeDeterministicCandidates` (`brainrouter/src/reviews/reviewCandidateNormalization.ts:140`) walks `packet.sourceToSinkPaths` → mints `AssuranceFinding{producerKind:'deterministic_analyzer'}` on the same footing as model findings; `diffReviewAssurance.ts:555-611` merges → `verifyCandidate` (the D2 adversarial verify) → the same publication gate. The `typescript-source-to-sink` producer present today is a **placeholder**; `candidateLedger.ts` is a dead ADR-027-era decoy to ignore.
  - **D8's "code scanning already configured here" is TRUE** (corrected 2026-08-17 against the GitHub API — an earlier file-only read wrongly called it false because default setup leaves no workflow file). The repo is **public**, so no GitHub Advanced Security entitlement is needed; the database-first scanner runs via **default setup** (`code-scanning/default-setup` → `state: configured`; js/ts, python, actions; query suite `default`, since 2026-08-06). The javascript-typescript analysis emits 243 results, and there are **243 open code-scanning alerts** (214 high / 23 medium / 6 critical) — `js/request-forgery`, `js/polynomial-redos`, `js/missing-rate-limiting`, `js/insufficient-password-hash`. So the engine already runs; the remaining work is **consuming its output**, not standing it up.
  - **Sequence (engine-independent value first):** Slice 1 — the D2 verifier + a D4 SSRF barrier pack (`fetchUpstreamWithPolicy`, `policyBoundFetch`, `validateUpstreamTarget`) + the §6 replay corpus behind the existing seam, proving "fixed code stays fixed" at HEAD (`modelProbe.ts` must not re-report); **most urgent: capture the must-NOT-report false-positive set (5 path-guard sinks + 2 non-repro ReDoS) as committed ground truth** — it lives only as counts in the ADR and cannot be rebuilt from git later. Slice 2 — implement `RepositoryAssuranceImpactPort.assemble` (`packages/core/src/review/ports/analysis.ts:38`) to pull the **existing** code-scanning API (`GET /code-scanning/alerts` + the SARIF from `/code-scanning/analyses/{id}`) and map path-problem results → `AssuranceImpactPacket.sourceToSinkPaths`, swapping the placeholder at `repositoryContextComposition.ts:43`. No engine to stand up — CodeQL is already producing SARIF. Slices 3–6 — barrier pack as versioned data + precision suite selection; D6 path-hops (extend the flattened `AssuranceSourceToSinkPath`, `packages/types/src/review/analysis.ts:96`); D5 async DB scheduling + "not analyzed" honesty; D7 own-failure-mode queries.
  - **Licensing:** green for this-repo-only; deferred (red, needs a decision first) for any customer-facing offering.

Legend: ✅ Implemented · 🟡 Partial / in progress · 📝 Proposed
