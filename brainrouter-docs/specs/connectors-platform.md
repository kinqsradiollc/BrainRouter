# Connectors Platform

## Context

BrainRouter currently has integration-specific surfaces such as MCP servers and Track GitHub issue/PR sync. Those are useful, but they do not form an Onyx-style connector platform: there is no shared source catalog, connector instance lifecycle, credential-provider contract, checkpoint/run state, or permission/sparse retrieval capability model.

Onyx's connector shape is the target baseline:

- A connector source maps to a lazy-loaded implementation.
- A connector advertises supported flows: load, poll/checkpoint, slim retrieval, event, and permission sync.
- Credentials are loaded through a provider abstraction, not mixed into every caller.
- Admin lifecycle is connector + credential pair validation, then recurring runs with persisted checkpoint and failure state.
- GitHub supports owner/org/repository modes, issues, PRs, files, slim retrieval, and permission sync.

## Goals

- Add a shared connector catalog and instance/run data contract that desktop, CLI, and core can all consume.
- Persist connector instances per workspace, with run history and checkpoint metadata.
- Keep Track GitHub sync available, but stop treating it as the general connector abstraction.
- Support many GitHub repositories through a general GitHub connector configuration, not only the Track sync active repo.
- Make the next ingestion runtime slices straightforward: validate, load/poll/checkpoint, slim retrieval, and permission sync.

## Still Out Of Scope

- No OAuth browser flow yet.

## Delivered Slices

- Shared connector types exist in `@kinqs/brainrouter-types`.
- Core exposes a connector catalog with GitHub runtime capabilities aligned to Onyx plus setup schemas for GitLab, Slack, Google Drive, Confluence, Jira, filesystem, web, and MCP resources.
- Core persists connector instances and run records per workspace.
- Store APIs validate unknown sources, unsupported flows, empty names, and immutable fields.
- Focused tests cover catalog lookup, create/update/delete, workspace isolation, run history, and checkpoint persistence.
- Desktop exposes connector catalog/list/detail/create/update/delete/validate/run actions.
- Settings has one dedicated Connectors section for connector setup and GitHub Track sync; the duplicate Integrations surface has been removed.
- Settings exposes a source picker and generic setup form for catalog entries whose deeper runtime ingestion is still pending.
- GitHub connector validation supports TLS-aware `gh` credentials and static env-token references.
- GitHub checkpoint runs emit issue, pull request, and file documents into a durable workspace sink.
- Track GitHub issue sync can resolve repositories from configured GitHub connectors while preserving the issue-board workflow.
- Slim retrieval returns bounded connector document snippets for preview/search surfaces.
- Permission sync persists GitHub repository collaborators as connector permission records.
- Connector definitions can be exported/imported without runtime state or secret values.
- Connector documents can be converted into deterministic BrainRouter `memory_import` envelopes, and Desktop can send them to the active BrainRouter memory server for recall/vector embedding.
- Desktop supports optional per-connector background polling (`pollMinutes`) and surfaces latest connector run status in Settings.

## Remaining Tasks

- Implement real runtime ingestion/validation for non-GitHub catalog sources beyond saved connector definitions.
- Add deeper source-document/artifact references for connector documents beyond the current cognitive-memory import bridge.
