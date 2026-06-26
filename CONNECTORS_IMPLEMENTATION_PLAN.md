# BrainRouter Connectors Implementation Plan

## Target Shape

BrainRouter should treat connectors as first-class workspace resources, similar to Onyx: catalog entry -> configured connector instance -> credential provider -> validation/run lifecycle -> checkpointed outputs.

## Tasks

- [x] Compare Onyx connector interfaces, registry, and GitHub connector behavior against BrainRouter's existing Track GitHub and MCP surfaces.
- [x] Write `brainrouter-docs/specs/connectors-platform.md` with goals, boundaries, and staged work.
- [x] Add shared connector type contracts to `@kinqs/brainrouter-types`.
- [x] Add a core connector catalog with GitHub plus Onyx-inspired entries for GitLab, Slack, Google Drive, Confluence, Jira, filesystem, web, and MCP resources.
- [x] Add a per-workspace connector store for instances, status, checkpoints, and run history.
- [x] Add focused connector store/catalog tests.
- [x] Add desktop host queries for connector catalog and connector instance CRUD/run history.
- [x] Add Settings -> Connectors UI for multi-repository GitHub connector setup.
- [x] Consolidate GitHub Track sync settings into Settings -> Connectors and remove the duplicate Integrations tab.
- [x] Add a connector catalog picker and generic setup form for catalog sources whose runtime ingestion is not implemented yet.
- [x] Wire Track GitHub issue sync to optionally use connector instances.
- [x] Implement GitHub connector validation using GitHub CLI with TLS CA bundle support.
- [x] Add token-backed validation for static credential references.
- [x] Implement GitHub checkpoint ingestion for issues, PRs, and files.
- [x] Persist connector documents into a workspace search sink.
- [x] Feed connector documents into memory embeddings/recall through deterministic `memory_import` records.
- [x] Add slim retrieval for persisted GitHub connector documents.
- [x] Add permission sync for GitHub connector runs.
- [x] Add scheduler/background run integration and user-visible run status.
- [x] Add import/export of connector definitions without secrets.
