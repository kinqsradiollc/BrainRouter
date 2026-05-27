# <version> Roadmap — <Short Theme>

**Status.** <Planned | Designed | In progress | Shipped — YYYY-MM-DD>.
Full release notes: [`../brainrouter-changelog/<version>.md`](../brainrouter-changelog/<version>.md).

**Theme.** One or two sentences explaining the release goal and the
boundary that keeps it from growing without limit.

## Release Threads

| Thread | Goal | Status |
|---|---|---|
| A. <Thread name> | <What this thread delivers.> | <Planned / Shipped> |
| B. <Thread name> | <What this thread deliberately does not include.> | <Planned / Shipped> |

## Why This Release Exists

- <Concrete product or engineering problem this release solves.>
- <What becomes possible after this ships.>
- <What pain or risk remains out of scope.>

## Implementation Summary

| # | Item | Result / target |
|---:|---|---|
| 1 | <Item name> | <One-line shipped result or intended outcome.> |
| 2 | <Item name> | <One-line shipped result or intended outcome.> |
| 3 | <Item name> | <One-line shipped result or intended outcome.> |

## Branches

| # | Branch | Item |
|---:|---|---|
| 1 | `feature/<version>-1-<slug>` | <Item name> |
| 2 | `feature/<version>-2-<slug>` | <Item name> |

## Read First

| Area | Files |
|---|---|
| <Area> | `<path>` |
| <Area> | `<path>`, `<path>` |

## Acceptance

- <Observable outcome or command behavior.>
- <Regression that must not return.>
- <Verification signal that proves the release goal.>

## Ship Gate

- `npm run build`
- `npm test`
- <Any focused workspace/package test>
- <Manual smoke check if runtime behavior matters>

## Out of Scope

- <Explicit non-goal and where it belongs instead.>
- <Deferred feature or risk.>

## Writing Rules

- Keep this roadmap scannable; aim for 80-150 lines.
- Use tables for release shape and short bullets for rationale.
- Do not paste full implementation specs into this file once the work
  is understood. Move deep task breakdowns to task docs or PRs.
- Keep root `../ROADMAP.md` as the executive index, not a duplicate.
