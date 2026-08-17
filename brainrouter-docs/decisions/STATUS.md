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
| 039 | The half of security a model cannot see (taint) | 🟡 Accepted (this-repo-only); phased build | — |
| **040** | **One runtime, graphs of bounded loops** | **✅ Implemented** | **0.4.20** |
| 041 | Plug-and-play runtime | 🟡 A41-6 shipped (composite store type); rest = concurrent session's epic | 0.4.21 |
| **042** | **Worktrees the agent can enter** | **✅ Implemented** | **0.4.21** |
| 043 | Egress at the user's edge | 🟡 S1 + S1b shipped; S2–S5 gated on 041 | 0.4.21 |

## In flight / next

- **ADR-037** — the credentials-hardening program is **complete** (all 8 slices shipped to `release/0.4.21`): B1 revocable sessions, B2 boot-guard, B3 cookie+CSRF, D-1 identity, D-2 cookie transport (+ readable `br_csrf` double-submit cookie that survives reload), D-3 API key + tokens out of localStorage into memory, B4 cookie-path `/refresh` returns no body token. The dashboard now persists no credential to storage. Owner step: run §5's live acceptance test on the running stack.
- **Partial → finish:** ADR-032 and ADR-033 shipped partial to 0.4.20 and have room to complete.
- **ADR-041 (plug-and-play runtime):** its lowest-risk standalone seam **A41-6** shipped to `release/0.4.21` — `IMemoryStoreComposite` typed the memory-engine `store` field and removed 15 `as unknown as *Store` casts (pure type-level). The remaining 16 slices (IAgent / ProviderRegistry / execution-worlds / services-as-profiles) are a multi-release epic being drafted by a concurrent session — left to that owner to avoid a design collision.
- **ADR-043 (edge egress):** **S1 + S1b** shipped to `release/0.4.21` — the gateway rate-shaper now does both reactive Retry-After parking *and* proactive per-key concurrency/rpm reservation (release-in-`finally`), with injectable budgets. **S2–S5 genuinely depend on ADR-041's `ProviderDialer`/`ProviderDefinition` seams** and are deferred until those land.
- **ADR-039 (taint analysis):** scope resolved to this-repo-only. Implementation is explicitly "its own track, not a single slice" — a flow/taint engine (exact-SHA checkout + DB-build stage + owned source/sink/barrier pack + review-pipeline port), multi-week. No clean sub-slice; awaiting a dedicated track.

Legend: ✅ Implemented · 🟡 Partial / in progress · 📝 Proposed
