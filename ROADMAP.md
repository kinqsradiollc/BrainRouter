# BrainRouter roadmap

This is the planning index for work that is not yet released. Shipped detail
lives in [`CHANGELOG.md`](CHANGELOG.md) and
[`brainrouter-changelog/`](brainrouter-changelog/); design decisions live in
[`brainrouter-docs/`](brainrouter-docs/).

## Release status

The latest tagged release is **0.4.17** (2026-07-30). A capability present on a
development branch is not considered shipped until its release gate passes and
a version is tagged.

| Version               | State          | Theme                                                                                           |
| --------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| **0.4.18**            | In progress    | Native Desktop visual system, platform-adaptive shell, accessibility, and workbench performance |
| **0.4.17**            | Shipped        | Runtime plane, automations, connectors, review operations, and cross-surface product completion |
| **0.4.16**            | Shipped        | Autonomous fleet, unified desktop, Track maturation, PostgreSQL brain, remote brain, and Atlas  |
| **0.4.15**            | Shipped        | Requirement-first workflow and the first unified Chat · Track · Code workspace                  |
| **0.4.14**            | Shipped        | Recall accuracy, grid TUI, and background workers that report back                              |
| **0.4.13**            | Shipped        | Sub-agent result delivery and REPL reliability                                                  |
| **0.4.12**            | Shipped        | Build Loop, worktree-aware orchestration, and input queue                                       |
| **0.4.11**            | Shipped        | Isolated worktree merge-back and memory verification                                            |
| **0.4.10**            | Shipped        | Memory-home hardening, mobile dashboard, and edge runtime                                       |
| **0.4.9**             | Shipped        | Dashboard redesign, auth refresh, and API hardening                                             |
| **0.4.8 and earlier** | Shipped        | Workflow, coding-agent, federation, and memory foundations                                      |

Full release notes: [`CHANGELOG.md`](CHANGELOG.md).

## What 0.4.16 established

BrainRouter is already a multi-surface agent operations product. Desktop is the
primary workbench, while Dashboard is the shared operations surface.

- **Desktop** is the primary Electron workbench for Chat, Code, and Track. It
  includes projects and sessions, Monaco editing and diffs, plans,
  requirements, tools, terminal, Atlas, workflows, automations, settings, and
  local review.
- **CLI** runs the same agent runtime, model routing, permission system,
  orchestration, workflows, and memory lifecycle in a terminal-native shell.
- **Dashboard** manages authenticated organizations, projects, providers,
  connections, repositories, knowledge, fleet work, and review operations.
- **Brain** serves PostgreSQL-backed MCP and REST contracts for memory,
  tenancy, connectors, jobs, and shared clients.
- **Track** provides board, list, backlog, sprint, roadmap, reports,
  automation, members, and repository synchronization inside the workbench.

The changelog remains the source of truth for the exact shipped inventory.

## 0.4.17 — Runtime body and product completion

**Status: shipped on 2026-07-30.** The release adds an execution plane,
project-aware onboarding, and source-grounded Project knowledge while making
the Dashboard and Desktop feel like one coherent product. It remains
default-safe: hosted or container execution, inbound triggers, and other
expanded authority stay opt-in.

### Runtime and automation

- [x] Runtime port with process, worktree, opt-in container, and declared hosted
      backends; lifecycle controls, archives, and app-preview port registration.
- [x] Inbound automation foundation for signed GitHub, GitLab, Slack, and Jira
      events with repository allowlists and redelivery idempotency.
- [x] Requirement intake, suggested-task scanning, fleet jobs, and verified
      draft-PR delivery paths.
- [x] Critic gates, task budgets, named model profiles, and role-aware model
      routing.
- [x] Plugin packaging, validation, installation, consent, registry search, and
      desktop marketplace controls.
- [x] Desktop runtime monitor, automation controls, provider configuration, and
      write-only secret handling.

### Shared product surface

- [x] A durable interface contract for dashboard, desktop, and CLI naming,
      semantic color, navigation, forms, motion, and accessibility.
- [x] Focused Settings navigation: a category rail and subsection selector render
      one panel at a time instead of one long settings document.
- [x] Authenticated dashboard chat with organization, project, and workspace
      knowledge scope and attributable source links.
- [x] Server-backed source ownership and filtering across organization, project,
      workspace, and user boundaries.
- [x] Account-linked connector OAuth with sealed server-side credentials and a
      shared connection state for dashboard and desktop.
- [x] Desktop Track repository detection, account-backed synchronization,
      account-managed automations, and server-backed pull-request review history.
- [x] GitHub pull-request review operations with separate security and code
      lenses, repository policies, evidence, and live job status.
- [x] Separate global and project onboarding with reviewed conversational
      proposals, offline fallback, one engineer, and per-task capability
      activation across CLI and Desktop.
- [x] Organization- and Project-scoped knowledge from bounded
      text/HTML/PDF/DOCX ingest through processing, retry, hybrid retrieval,
      citations, recommendations, distillation, and Dashboard/Desktop clients.
- [x] Complete the onboarding and Project-knowledge hosted CI,
      browser/Electron acceptance, and documentation reconciliation gates.
- [x] Complete the remaining release-wide validation, bump versions, tag, and
      publish.

Implementation checkmarks in this section describe the shipped release.

## 0.4.18 — Native Desktop visual system

**Status: accepted for phased implementation on 2026-07-30.**

- [ ] Resolve System, Light, Dark, and High Contrast appearance through a
      narrow native host contract.
- [ ] Replace the monolithic styling cascade with owned foundation, shell, and
      surface modules.
- [ ] Align the shell, Chat, Settings, Editor, Files, Terminal, Browser, and
      remaining workbench surfaces without changing their runtime boundaries.
- [ ] Preserve mounted panel state and meet explicit accessibility and
      responsiveness budgets.
- [ ] Complete live macOS and Windows review before removing the reversible
      compatibility setting.

Detailed decision and taskboard:
[ADR-026](brainrouter-docs/decisions/ADR-026-desktop-native-visual-system.md)
and [`brainrouter-roadmap/0.4.18.md`](brainrouter-roadmap/0.4.18.md).

## 0.5.0 — Operational scale

Planned themes, subject to validation and reprioritization:

- [ ] Hosted-runtime deployment and operational controls for teams.
- [ ] Stronger fleet observability across queues, workers, costs, and artifacts.
- [ ] Per-agent recall diagnostics and evidence drill-down in the dashboard.
- [ ] Verified provider and connector compatibility matrix.
- [ ] Stable `@kinqs/brainrouter-sdk` 1.0 contract.
- [ ] Release-grade packaging and update coverage across supported desktop
      platforms.

## Designed, not scheduled

- Per-session isolation for multiple terminals on one repository —
  [`per-session-isolation.md`](brainrouter-docs/specs/per-session-isolation.md).
- Additional knowledge ingestion providers after the current OAuth and runtime
  connector matrix is verified.
- A published MCP server container image.

## Documentation map

| File                                                               | Purpose                                         |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| [`CHANGELOG.md`](CHANGELOG.md)                                     | Tagged releases and shipped behavior            |
| [`brainrouter-changelog/`](brainrouter-changelog/)                 | Detailed release notes                          |
| [`brainrouter-roadmap/`](brainrouter-roadmap/)                     | Release-specific plans                          |
| [`brainrouter-docs/specs/`](brainrouter-docs/specs/)               | Feature and architecture specifications         |
| [`brainrouter-docs/decisions/`](brainrouter-docs/decisions/)       | Architecture decisions                          |
| [`brainrouter-benchmark/reports/`](brainrouter-benchmark/reports/) | Published benchmark evidence                    |
| [`design.md`](design.md)                                           | Shared dashboard and desktop interface contract |
