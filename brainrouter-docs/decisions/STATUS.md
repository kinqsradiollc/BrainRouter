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
| 039 | The half of security a model cannot see (taint) | 🟡 6 vulns fixed; **S2 CODE-COMPLETE** — CodeQL SARIF→review-candidate pipeline wired end-to-end (#1434/#1436/#1437/#1438), pending a live-run confirm (owner, like §5); S1 corpus + S3–S6 remain | 0.4.21 |
| **040** | **One runtime, graphs of bounded loops** | **✅ Implemented** | **0.4.20** |
| 041 | Plug-and-play runtime | 🟡 A41-6 + D1 + **D3 ports COMPLETE** (#1428–#1441); **D4 substantially built** — IAgent seam (#1443) + phase-hook mechanism & turn-end firing (#1444); D4b.2 (provider/tool waterfalls + logged-invariant assertion), D8, D10, ExtensionHost port-registration remain | 0.4.21 |
| **042** | **Worktrees the agent can enter** | **✅ Implemented** | **0.4.21** |
| 043 | Egress at the user's edge | 🟡 S1 + S1b + EdgeDialer seam + egress ProviderDefinition fields (#1426) shipped; S3a tunnel dialer shipped dark (#1432); S3b–S5 building | 0.4.21 |

## In flight / next

- **ADR-037** — the credentials-hardening program is **complete** (all 8 slices shipped to `release/0.4.21`): B1 revocable sessions, B2 boot-guard, B3 cookie+CSRF, D-1 identity, D-2 cookie transport (+ readable `br_csrf` double-submit cookie that survives reload), D-3 API key + tokens out of localStorage into memory, B4 cookie-path `/refresh` returns no body token. The dashboard now persists no credential to storage. Owner step: run §5's live acceptance test on the running stack.
- **Partial → finish:** ADR-032 and ADR-033 shipped partial to 0.4.20 and have room to complete.
- **ADR-041 (plug-and-play runtime):** two safe, behaviour-neutral foundations shipped to `release/0.4.21` — **A41-6** (`IMemoryStoreComposite`, removed 15 `as unknown as *Store` casts) and **D1 foundation** (#1418: the `ProviderRegistry` class replacing the `ReadonlyMap`, with `register`/`replace`/`dispose` + `hasBuiltin` — identical reads, the seam ADR-043 S2's `ProviderDialer` attaches to). **D1 is now complete** (#1418 foundation + #1423 extension-unify — extension providers are live to routing). **D3 (capability ports) is COMPLETE** (#1428–#1441): all three runtime side effects are behind injectable, byte-identical ports — `FilesystemPort` (all 5 file tools), `SubprocessPort` (`spawn_worker_thread`), and `ShellPort` (`run_command`'s bare exec; the ~200 lines of approval/policy/sandbox/destructive-guard stay inline, verified untouched by the `cc-safety-shell`/`exec-policy` suites). This is the substrate D10's execution worlds compose. Remaining: D4 (`IAgent` + phase hooks), D8 (guarded tool pipeline), D10 (execution worlds), and registering the ports on `ExtensionHost` (D7/D9). Seams in place: `ProviderRegistry`, `EdgeDialer`, `FilesystemPort`/`SubprocessPort`/`ShellPort`.
- **ADR-043 (edge egress):** **S1 + S1b + the S2 EdgeDialer-seam foundation** shipped to `release/0.4.21` (#1420: `EdgeDialer` type + `directDialer` default over the existing dispatcher-factory seam, byte-identical). The egress `ProviderDefinition` fields (`egressCapabilities`/`egressMode`) landed (#1426), and **S3a — the server-terminated-TLS tunnel dialer — shipped dark** (#1432: 7 tests, credential-blind, nothing selects it). S3b (a distinct egress channel type over the relay substrate — gateway as one endpoint, client device as the other, own ticket kind + allowlist), S4 (consent/telemetry/fallback + dialer selection off `egressMode`), and S5 (vended-token path) are building. The gateway rate-shaper does both reactive Retry-After parking *and* proactive per-key concurrency/rpm reservation (release-in-`finally`), with injectable budgets. Safety anchor: the client-tunnel far endpoint must validate against the SAME upstream allowlist (`validateUpstreamTarget`/`upstreamProbePolicy`) as server-side egress, so the tunnel never widens the SSRF surface.
- **ADR-039 (taint analysis):** scope resolved to this-repo-only. **All six concrete vulnerabilities the ADR cites as evidence are fixed** (0.4.21): the "quadratic regex ~23s per PR comment" ReDoS (#1413), the "guard on three paths of four" LM Studio probe SSRF (#1414), and the three runtime provider SSRFs — embeddings / rerank / memory-pipeline chat — via a validate-then-fetch guard through `upstreamProbePolicy` that refuses an internal target before dialing, self-hosted local backends opting in via `BRAINROUTER_UPSTREAM_ALLOWLIST` (#1416). The general flow/taint **engine** track was reassigned to the seam-holding session (2026-08-17, owner decision, when the dedicated 039 session stood down). A grounded direction review corrected its shape — and because the engine is **already live** (see D8 below), it is far more tractable than "multi-week":
  - **It is an *integration*, not a build-from-scratch.** ADR §2 describes an off-the-shelf, database-first analyzer (declarative queries carrying precision/severity metadata, source→sink `path-problem` paths, source/sink/barrier taint model, model-as-data extensions, a separately-licensed CLI). **D3 forbids inventing our own filter** — so authoring a static analyzer is the one wrong direction the chip title ("build the engine") invites.
  - **The D1/D2/D6 ingestion seam is already wired.** `normalizeDeterministicCandidates` (`brainrouter/src/reviews/reviewCandidateNormalization.ts:140`) walks `packet.sourceToSinkPaths` → mints `AssuranceFinding{producerKind:'deterministic_analyzer'}` on the same footing as model findings; `diffReviewAssurance.ts:555-611` merges → `verifyCandidate` (the D2 adversarial verify) → the same publication gate. The `typescript-source-to-sink` producer present today is a **placeholder**; `candidateLedger.ts` is a dead ADR-027-era decoy to ignore.
  - **D8's "code scanning already configured here" is TRUE** (corrected 2026-08-17 against the GitHub API — an earlier file-only read wrongly called it false because default setup leaves no workflow file). The repo is **public**, so no GitHub Advanced Security entitlement is needed; the database-first scanner runs via **default setup** (`code-scanning/default-setup` → `state: configured`; js/ts, python, actions; query suite `default`, since 2026-08-06). The javascript-typescript analysis emits 243 results, and there are **243 open code-scanning alerts** (214 high / 23 medium / 6 critical) — `js/request-forgery`, `js/polynomial-redos`, `js/missing-rate-limiting`, `js/insufficient-password-hash`. So the engine already runs; the remaining work is **consuming its output**, not standing it up.
  - **Sequence (engine-independent value first):** Slice 1 — the D2 verifier + a D4 SSRF barrier pack (`fetchUpstreamWithPolicy`, `policyBoundFetch`, `validateUpstreamTarget`) + the §6 replay corpus behind the existing seam, proving "fixed code stays fixed" at HEAD (`modelProbe.ts` must not re-report); **most urgent: capture the must-NOT-report false-positive set (5 path-guard sinks + 2 non-repro ReDoS) as committed ground truth** — it lives only as counts in the ADR and cannot be rebuilt from git later. Slice 2 — implement `RepositoryAssuranceImpactPort.assemble` (`packages/core/src/review/ports/analysis.ts:38`) to pull the **existing** code-scanning API (`GET /code-scanning/alerts` + the SARIF from `/code-scanning/analyses/{id}`) and map path-problem results → `AssuranceImpactPacket.sourceToSinkPaths`, swapping the placeholder at `repositoryContextComposition.ts:43`. No engine to stand up — CodeQL is already producing SARIF. Slices 3–6 — barrier pack as versioned data + precision suite selection; D6 path-hops (extend the flattened `AssuranceSourceToSinkPath`, `packages/types/src/review/analysis.ts:96`); D5 async DB scheduling + "not analyzed" honesty; D7 own-failure-mode queries.
  - **Licensing:** green for this-repo-only; deferred (red, needs a decision first) for any customer-facing offering.

Legend: ✅ Implemented · 🟡 Partial / in progress · 📝 Proposed
