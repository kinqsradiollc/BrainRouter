# Spec: Meeting Summary Format Extension

Status: Implemented (approved 2026-07-18)
Owner: Core / Meetings backend
Scope: `packages/core`, `brainrouter`

## Objective

Make BrainRouter meeting summaries consistently useful and presentation-ready. The
meeting summarization model must produce structured facts and call a built-in
`format_meeting_summary` tool; the tool, rather than the model, owns the final
Markdown layout.

The public/dashboard presentation remains aligned with the supplied reference:
the meeting title and date are page metadata, while the summary card contains a
concise overview, decisions, and owned action items. Specialized templates keep
their domain sections without losing the common overview and action-item contract.

## Assumptions

1. The title and meeting date remain outside `summaryMarkdown`; existing desktop,
   dashboard, and public-share views already render them separately.
2. The default `general` template always renders `Overview`, `Decisions`, and
   `Action Items` in that order.
3. `standup`, `one-on-one`, and `retrospective` retain their specialized sections,
   with `Overview` first and `Action Items` last.
4. Existing account gating, org isolation, meeting storage, redaction, sharing,
   background execution, and per-org `meeting-summary` model routing do not change.
5. This slice changes summary generation and the agent tool surface only; it does
   not redesign the Meetings UI or add a database migration.

## Product Contract

### Built-in agent tool

The optional built-in extension `meeting-summary` contributes one read-only,
parallel-safe tool:

```text
format_meeting_summary({
  template,
  overview,
  decisions,
  action_items,
  progress,
  blockers,
  next_steps,
  discussion,
  feedback,
  commitments,
  what_went_well,
  what_did_not_go_well,
  experiments
})
```

Only fields relevant to the selected template are rendered. `overview` is
required. Other arrays may be empty. An action item has a required `task` and
optional `assignee` and `due` fields.

The tool returns JSON with:

```json
{
  "markdown": "## Overview\n...",
  "actionItems": [
    { "title": "Prepare technical design", "assignee": "Anh" }
  ]
}
```

### Deterministic output

- The formatter owns heading names, ordering, bullet syntax, assignee rendering,
  empty-section copy, deduplication, whitespace normalization, and length caps.
- Model-provided Markdown syntax cannot introduce extra headings or break the
  output layout; field values are normalized to plain inline text.
- Decisions and action items are never invented. The extraction prompt explicitly
  requires empty arrays when the transcript does not establish them.
- Empty sections render a short `_None recorded._` marker instead of a fabricated
  bullet or a placeholder action item.
- Action items are persisted from the structured tool arguments. The backend no
  longer recovers them by applying a regex to model-authored Markdown.

### Template layouts

| Template | Ordered sections |
|---|---|
| `general` | Overview, Decisions, Action Items |
| `standup` | Overview, Progress, Blockers, Next Steps, Decisions, Action Items |
| `one-on-one` | Overview, Discussion, Feedback, Commitments, Decisions, Action Items |
| `retrospective` | Overview, What Went Well, What Didn't Go Well, Experiments, Decisions, Action Items |

## Backend Integration

The Meetings backend continues resolving `memoryEngine.modelRunner("meeting-summary",
orgId)`. It passes the extension's tool schema through `ModelLLMRunner.run({ tool })`,
which forces a function call on providers that support tools. The backend then:

1. extracts the returned JSON through the existing `llm-json` chokepoint;
2. overrides any model-provided template value with the user-selected template;
3. calls the same formatter implementation used by the extension;
4. stores the deterministic Markdown and structured action items through the
   existing meeting/redaction/provenance pipeline.

For OpenAI-compatible providers that reject tool calling, the existing gateway
drops `tools` and retries. The prompt therefore also requests the exact JSON
object as a fallback, and the same JSON chokepoint and formatter still apply.
Malformed or empty structured output fails summary generation explicitly rather
than persisting an incorrectly formatted result.

## Tech Stack and Project Structure

- TypeScript/ESM in `packages/core/src/extension/` for the shared schema and
  deterministic formatter.
- Plain ESM in `packages/core/extensions/meeting-summary/` for built-in extension
  activation, matching the existing Browser and agent-ops extension pattern.
- TypeScript/Vitest in `brainrouter/src/memory/meetings/` for the backend adapter.
- Node test runner in `packages/core/src/tests/` for formatter and activation
  coverage.

## Code Style

The formatter is a pure function with an unknown-input validation boundary:

```ts
const formatted = formatMeetingSummary({
  template: "general",
  overview: "The team confirmed the first-release scope.",
  decisions: ["Support uploaded documents first."],
  action_items: [{ task: "Prepare technical design", assignee: "Anh" }],
});
```

No backend singleton, provider secret, database handle, or Agent runtime object is
available to the public extension handler.

## Commands

- Core build: `npm run build -w @kinqs/brainrouter-core`
- Core targeted test: `node --test packages/core/dist/tests/meeting-summary-extension.test.js`
- Server targeted test: `npm exec -w @kinqs/brainrouter-mcp-server vitest run -- src/memory/meetings/summary.test.ts`
- Server typecheck: `npm run typecheck -w @kinqs/brainrouter-mcp-server`
- Server meeting tests: `npm exec -w @kinqs/brainrouter-mcp-server vitest run -- src/memory/meetings/meetingsService.test.ts src/memory/meetings/summary.test.ts`
- Diff validation: `git diff --check`

## Testing Strategy

- Pure formatter tests cover every template, empty sections, normalization,
  deduplication, action metadata, invalid input, and output length boundaries.
- Extension activation test proves `meeting-summary` contributes
  `format_meeting_summary` with read/read-only/parallel-safe metadata and that its
  handler returns the same formatter result.
- Backend tests use a fake `LLMRunner`; no live model, external API, or database is
  used. They assert the forced tool schema, selected-template enforcement,
  structured action persistence, malformed-output rejection, and prompt fallback
  contract.
- Existing Meetings service tests and package typechecks guard regressions.

## Boundaries

- Always: validate unknown tool input, cap strings/arrays, preserve org-scoped
  model resolution, use the JSON extraction chokepoint, and keep formatter output
  deterministic.
- Ask first: database schema changes, changing the visible title/date layout,
  replacing model routing, or adding a dependency.
- Never: expose provider credentials to the extension, log meeting transcripts or
  model bodies, infer an assignee/due date absent from the transcript, or allow
  model-authored headings to control the rendered layout.

## Definition of Done

- `format_meeting_summary` is discoverable through the built-in extension loader.
- The tool deterministically produces the documented layouts for all four templates.
- New meeting summaries force the tool schema and persist formatted Markdown plus
  structured action items.
- Invalid structured model output marks the existing background summary job failed;
  no malformed summary is persisted.
- Core targeted tests, server targeted tests, both package typechecks, and
  `git diff --check` pass.

## Open Questions

None blocking. If the assumptions above are approved, implementation can proceed
without a UI or database change.

## Implementation Evidence

- The core extension/registry suite passes 35 tests, including seven direct
  meeting-summary formatter, boundary, size, discovery, and execution tests.
- The Meetings regression suite passes 27 tests, including four forced-tool,
  fallback, template, structured-action, malformed-output, and input-bound tests.
- Core and server builds/typechecks pass; changed-file ESLint and `git diff
  --check` pass.
- `npm pack --dry-run` includes the formatter JavaScript/type declarations and
  the built-in extension manifest/activation module.
