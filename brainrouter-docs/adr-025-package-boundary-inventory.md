# ADR-025 Package Boundary Inventory

**Status:** A25-1 inventory and A25-2 guard pilot complete · **Baseline
snapshot:** `release/0.4.17` at `9ef12c291` · **Decision:** ADR-025

## Purpose

This inventory is the execution map for the whole-platform modernization
accepted in ADR-025. It records current owners, public entrypoints, dependency
direction, mixed-responsibility modules, compatibility requirements, and the
first safe migration for every maintained package and product host.

Line count is a discovery signal, not a refactor rule. A large, cohesive
generated table or state machine may remain intact. A smaller module that mixes
contracts, policy, persistence, transport, and presentation is a higher-priority
boundary defect. Every implementation slice must prove an ownership
improvement, preserve behavior unless its PR explicitly changes behavior, and
keep the old supported import path through a compatibility facade.

## Authoritative dependency graph

```text
packages/types ─────────────┐
                            ├──> packages/core ───────> backend / CLI / Desktop host
packages/agent-protocol ────┘

packages/types ───> packages/sdk ───> packages/hooks ───> Dashboard
       │                    │                │
       └────────────────────┴────────────────┘
```

Rules established by the current package manifests and architecture law:

1. `packages/types` and `packages/agent-protocol` are leaves. They never import
   Core or an application.
2. Core depends on types and protocol. It owns host-neutral runtime validation,
   domain transitions, policy, services, and local adapters behind curated
   subsystem entrypoints.
3. SDK is browser-safe and fetch-only. Hooks depend only on SDK, types, and
   React as a peer.
4. Dashboard consumes the browser-safe types/SDK/hooks subset. It does not
   import Core or protocol.
5. Backend, CLI, and the Electron host consume curated Core entrypoints.
6. The Desktop renderer may deep-import a specific browser-safe Core module.
   This is the one sanctioned exception and depends on Core's `./dist/*`
   compatibility export until browser-safe subpaths replace each use.

## Whole-platform ownership map

| Surface | Current owner and useful seam | Boundary debt | Destination and first migration |
|---|---|---|---|
| `packages/types` | Shared records; domain files exist for memory, Atlas, Track, work contracts, planning, and a cohesive dependency-free repository-assurance family | Root barrel is broad; `api.ts`, `store.ts`, `track/entities.ts`, and `atlas-enrich.ts` remain large; backend review DTOs still need adaptation to the assurance records | Keep `review/` as the host-neutral assurance owner behind `./review`, `./reviews`, and root compatibility exports; migrate adapters without moving runtime policy into Types |
| `packages/agent-protocol` | Zero-dependency agent-host vocabulary with structural guards; the root now curates private event, command, interaction, callback-bridge, and envelope modules | Lifecycle and authority records remain structural mirrors that need parity fixtures before deeper agent-runtime extraction | Keep the root entrypoint unchanged and all guards pure; evolve host-neutral lifecycle records here only when Core and host fixtures prove parity |
| `packages/core` | Headless domains with curated package exports and a minimal root barrel | Several domains mix contracts/policy/adapters; provider and router overlap; large configuration, agent, extension, workspace, browser, and orchestration modules remain | Migrate one domain at a time to contracts/domain/policy/ports/services/adapters as earned; preserve curated subsystem entrypoints |
| `packages/sdk` | One fetch-only `BrainRouterClient` plus knowledge helpers | `client.ts` is the transport, auth refresh, and most domain methods in one 454-line class | Extract request/auth transport and domain method installers or delegates while preserving the class and root API |
| `packages/hooks` | One hook per file and explicit client injection already match the intended boundary | Root exports are flat and knowledge request coordination is shared informally | Keep the one-hook-per-file rule; add internal per-domain helpers only when multiple hooks share cancellation/query behavior |
| `brainrouter` | Durable memory engine, jobs, normalized assurance receipts, API routes, external integrations, provider storage, and hosted services | Provider responsibilities span `providers/`, `services/modelGateway/`, and `services/gateway/`; PR review execution is concentrated in an 800-line integration; durable assurance persistence exists but production review scheduling has not adopted it; some routes contain use-case logic | Routes/tools become adapters over services; provider storage, gateway policy, and transport get explicit owners; assurance execution moves behind a service and ports while retaining the memory-job ledger |
| `brainrouter-cli` | Terminal host, runtime composition, slash-command adapters, and Ink views | Some handlers and views still combine parsing, use cases, and rendering; `workflow/handlers.ts` remains 1,326 lines after the first split | Keep slash behavior stable; extract per-command services and view models behind existing `tryHandle*`/barrel paths |
| `brainrouter-desktop/electron` | Privileged host, IPC adapters, native browser/PTY, and CLI/Core composition | `host/queries.ts`, browser manager, host facade, and main composition remain multi-concern; host imports some CLI implementation paths because no shared host package exists | Split query families and browser concerns behind current composers; move reusable host-neutral contracts/services down to protocol/Core rather than creating Desktop policy |
| `brainrouter-desktop/src` | Renderer shell, feature panels, local view models, and presentation state | dev bridge and several panels/settings components mix fixtures, queries, state, and rendering; feature ownership is divided across `lib/`, `panels/`, and top-level components | Organize touched UI by feature; keep renderer-only adapters at the edge and do not move Node policy into UI folders |
| `brainrouter-dashboard` | Next.js routes and browser presentation over types/SDK/hooks | Several pages and `adminApi.ts` own large request/view-model/rendering surfaces; reusable domain screens are split between `app/`, `components/`, and `lib/` | Keep route composition in `app/`; move domain view models/screens to feature folders and API behavior into SDK/hooks where it is shared |

## Public entrypoint inventory

### Shared packages

| Package | Supported entrypoints at this snapshot | Rule |
|---|---|---|
| types | root plus `models`, `review`, `reviews`, `work-contract`, `planning-schema`, `atlas-ops`, and `provider` | `review` is canonical and `reviews` is its compatibility entrypoint; add other subpaths only when browser safety or bounded domain ownership requires them |
| agent protocol | root only | The root remains stable while its implementation splits into private siblings |
| Core | minimal root plus curated domain subpaths such as `agent`, `config`, `provider`, `router`, `review`, `workspace`, and `workflow` | Internal services stay private; renderer-only `dist/*` access remains a documented compatibility exception |
| SDK | root only | Preserve `BrainRouterClient`; private transport/domain delegates do not become public automatically |
| hooks | root only | Preserve named hook exports and explicit client injection |

Applications are private composition roots, not libraries. A reusable concept
found in an app moves down only when at least one real cross-package consumer
needs it and the lower package can own it without importing host concerns.

### Current exception that must remain explicit

The Desktop renderer has specific deep Core imports for browser-safe modules.
The root lint configuration exempts only `brainrouter-desktop/src/**`; Electron
host code remains subject to the curated-entrypoint rule. Core's `./dist/*`
export is therefore still load-bearing. A25-2 must correct the stale lint
comment that says the wildcard is gone, then add negative fixtures without
removing the exception.

## Mixed-responsibility and large-module triage

The following list is the initial migration queue. Test files are excluded from
line-count prioritization; they may be split for comprehension after the owning
production boundary stabilizes.

| Priority | Current module or family | Snapshot signal | Ownership assessment | Migration strategy |
|---|---|---:|---|---|
| P0 | `packages/core/src/config/configTypes.ts` | 1,340 lines | Server, provider, automation, web search, marketplace, skills, routing, triggers, budget, GitHub, and CLI records share one file | Extract domain contract siblings; keep `configTypes.ts` as the compatibility barrel |
| Done | `packages/agent-protocol/src/index.ts` | 13-line curated root | Events, commands, interaction, callback projection, and envelope stamping have private sibling owners | Preserve the root-only public entrypoint and dependency-free package contract |
| P0 | Core `provider/` + `router/` | two public subsystems | Catalog/definition and model-route execution boundaries overlap; backend has two additional gateway layers | Inventory names and call paths first, then consolidate ownership without changing public entrypoints |
| P0 | `brainrouter/src/integrations/prSecurityReview.ts` | 800 lines | Checkout/diff intake, model review, GitHub comments/checks, coverage, and compatibility aliases share one integration | Adapt to Core assurance validation/gate policy, then extract the assurance service, GitHub port/adapter, packet builder, and publication adapter behind current functions |
| P0 | `brainrouter-desktop/electron/host/queries.ts` | 3,969 lines | Query registration spans most product domains; it is a composer but still owns many handler bodies | Extract one query family per PR using the existing host context; keep `buildQueries` as composer |
| P1 | `packages/core/src/agent/runtime/runTurn.impl.ts` | 2,954 lines after safe-boundary steering extraction | Cohesive turn state machine still contains separable prompt/context, tool execution, recovery, and completion phases | Continue one characterized phase per PR; `agent/runtime/steering.ts` owns pending-input reconciliation and model-safe application |
| P1 | `packages/core/src/agent/agent.ts` | 2,011 lines | Agent composition owns many registries and runtime capabilities | Move composition helpers by capability; keep Agent public facade stable |
| P1 | `packages/core/src/extension/builtin/runtime.ts` | 1,685 lines | Built-in extension construction and many execution handlers share one module | Split per built-in extension/tool family behind the existing registry |
| P1 | `packages/core/src/agent/transport/llmTransport.ts` | 1,482 lines | Provider wire handling, retries, streaming, normalization, and tool-call transport overlap | Align request/response normalization with provider routing and recovery receipts before splitting |
| P1 | `packages/core/src/workspace/onboardingTransaction.ts` | 977 lines | Scan, proposal, review, stale protection, and persistence transaction share one module | Extract pure transaction phases and retain the current reviewed commit facade |
| P1 | `packages/core/src/orchestration/profiles/orchestrationProfileDefinitionFile.ts` | 855 lines | Schema parsing and filesystem trust checks are coupled | Reuse a bounded-file port only after exact fail-closed behavior is fixture-pinned |
| P1 | `brainrouter/src/memory/store/postgres/PostgresMemoryStore.ts` | 1,608 lines | Store facade spans many memory domains; query modules already exist | Keep facade; continue moving domain operations to query/service modules without creating a second store |
| P1 | `brainrouter/src/memory/engine.ts` | 1,280 lines | Memory facade/composition remains large | Keep one engine; extract services without moving durable truth elsewhere |
| P1 | `brainrouter-cli/src/cli/commands/workflow/handlers.ts` | 1,326 lines | Existing split still centralizes many workflow command bodies | Extract per-subcommand handlers/services behind the current command entrypoint |
| P1 | `brainrouter-desktop/electron/browser/browserViewManager.ts` | 1,992 lines | View lifecycle, tabs, navigation, events, permissions, downloads, and agent ownership share one class | Extract cohesive managers with injected live state; preserve BrowserViewManager facade |
| P1 | `brainrouter-desktop/src/devBridge/queries.ts` | 1,720 lines | Browser-development fixtures and every query family share one registry | Split fixture/query families behind one deterministic dev composer |
| P1 | `brainrouter-dashboard/app/overview/page.tsx` | 816 lines | Data loading, view model, and presentation share a route module | Extract overview feature components/view model while route keeps composition |
| P2 | `packages/sdk/src/client.ts` | 454 lines | Still understandable, but projected assurance and provider APIs will grow it into a god class | Split before adding ADR-025 clients; preserve constructor/auth/request semantics |
| P2 | `packages/types/src/track/entities.ts` | 537 lines | Large but cohesive domain record family | Keep unless the Track contract evolves independently enough to earn subfamilies |
| P2 | `packages/types/src/atlas-enrich.ts` | 503 lines | Deterministic Atlas enrichment is cohesive | Keep until code-index replacement creates a real analysis/service seam |

## Domain migration matrix

| ADR-025 wave | Current sources of truth | Destination decision | Compatibility requirement |
|---|---|---|---|
| A25-2 shared boundaries | package manifests, types exports, protocol root, Core export map, lint boundary | Machine-check leaf direction, curated Core imports, and sanctioned renderer exception | No supported import breaks; negative fixtures prove forbidden edges |
| A25-3 provider/model | Core `provider/` and `router/`; backend `providers/`, model gateway, hosted gateway; agent LLM transport | Catalog, routing, policy, transport adapters, and recovery receipts have one named owner each | Existing provider IDs, model discovery, fallback, budgets, and endpoint behavior stay stable |
| A25-4 agent runtime | Core agent/runtime/context/tool/session/orchestration plus host protocol | Separate lifecycle, context, tool execution, delivery, and delegation boundaries | Tool-call pairing, safe-boundary Steer, authority ceilings, and bounded loops stay exact |
| A25-5 workspace/profile | Core workspace, plugin, persona, planning, tool-profile, and onboarding modules | Manifest/contracts, catalog resolution, policy, file adapters, and transaction services are distinct | Missing-manifest behavior, precedence, diagnostics, and safe writes stay exact |
| A25-6 infrastructure domains | Core browser/exec/background/connectors/storage/worktree plus CLI/Desktop adapters | Host-neutral policy/services remain in Core; privileged side effects remain in hosts | No permission, cancellation, workspace, or session widening |
| A25-7–A25-13 assurance | types review/pentest records, Core review package, backend PR integration/jobs/routes, GitHub publication, Desktop/CLI/Dashboard review views | Durable assurance run, coverage, evidence, lifecycle, analysis, ports, and host projections | Current diff review remains labeled fallback until repository-context parity is proven |
| A25-14 agent quality | contributor rules, engineering profile planning schema, skills, runtime activation | Short global invariants plus profile/task-selected architecture, planning, code-quality, and security workflows | No prompt claims an unshipped tool or authority; unrelated profiles do not inherit engineering work |
| A25-15 cleanup | compatibility barrels, aliases, renderer deep imports, legacy paths | Remove only after import graph and consumer evidence prove zero supported users | One deletion PR per coherent compatibility family |

### Provider/model migration

The provider domain is now the canonical owner. Dependency-free recovery
receipts live in `packages/types/src/provider/`; catalog, model policy, budgets,
provider definitions, and model services remain behind Core's curated
`provider` entrypoint; and route selection, cooldowns, upstream policy, wire
adapters, gateway execution, and recovery live under
`packages/core/src/provider/routing/`.

Non-streaming gateway calls, streaming calls, and the agent turn loop use the
same bounded recovery executor. Maintained backend, CLI, Desktop, and Core
consumers import the provider owner. The `provider` and `router` public
entrypoints remain supported, but `router` and `router/gateway` are now thin,
identity-tested compatibility façades. Their named owner is Provider Routing;
their deletion is deferred to A25-15 and requires an external compatibility
window plus a zero-consumer import audit.

## Boundary guard

`scripts/check-package-boundaries.mjs` is the A25-2 source-graph gate. Root
`lint` runs its negative fixtures and a repository scan before ESLint, while
the staged-file hook runs the same checker only when relevant source or package
manifests change. The guard now proves:

1. types and protocol manifests remain dependency-free and cannot import
   another BrainRouter package or application;
2. Core, SDK, and hooks retain their declared internal dependency direction,
   with React remaining a hooks peer dependency;
3. SDK and hooks production modules stay free of `node:` imports while their
   Node-based tests remain valid;
4. Dashboard cannot import Core or protocol;
5. non-renderer consumers cannot use Core `dist/**` internals or unexported
   Core subpaths;
6. the Desktop renderer exception accepts only Core `dist/**` compatibility
   imports and does not weaken any other surface; and
7. maintained Core and host consumers use canonical Provider Routing while the
   supported router entrypoints remain external compatibility façades; and
8. static imports, re-exports, dynamic imports, and `require()` calls are all
   inspected.

The checker reads Core's exact public exports from `packages/core/package.json`
rather than duplicating that list. Domain contract-placement checks remain
deferred until the review and provider pilots establish real stable paths;
A25-2 intentionally does not freeze speculative empty folders.

## Per-slice completion evidence

Every structural PR must include:

- current owner, destination owner, and unchanged public path;
- a focused import graph/diff showing no forbidden dependency edge;
- behavior or contract fixtures for the extracted concern;
- a purpose header on every new module;
- a compatibility facade when existing consumers use the old path;
- focused typecheck/tests for the affected package and direct consumers;
- hosted CI as the full workspace integration gate; and
- an explicit “behavior-preserving” statement when the slice is a pure move.

No slice may claim that the whole modernization is complete merely because a
folder tree looks cleaner. ADR-025 completes only after its shared contracts,
runtime domains, assurance pipeline, host projections, agent skills, obsolete
path removals, and final acceptance audit all have direct evidence.
