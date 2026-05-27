# <version> - <Unreleased | YYYY-MM-DD>

One short paragraph: what changed, who it helps, and why this release
exists. Keep this to 2-3 lines.

## Breaking / Removed

- **<Short label>.** What changed, what users must do, and the safe
  migration path. Delete this section if there are no breaking/removal
  notes.

## Added

- **<Feature>.** User-visible capability and the command, screen, or
  workflow it affects.
- **<Feature>.** Keep implementation details out unless they help users
  operate or debug the feature.

## Changed

- **<Area>.** Behavior change, default change, or UX improvement.
- **<Area>.** Mention config paths, commands, or compatibility effects
  when relevant.

## Fixed

- **<Bug>.** Symptom first, then the fix. Prefer concrete behavior over
  internal class/function names.

## Tests / Verification

- <Test suite, smoke check, or manual verification that matters for the
  release.>

## Notes

- <Intentional scope boundary, known limitation, or follow-up release
  pointer. Delete if unnecessary.>

## Writing Rules

- Keep this per-version file readable in one pass; aim for 40-100 lines.
- Put future plans in `../ROADMAP.md` or `../brainrouter-roadmap/`, not
  here.
- Keep root `../CHANGELOG.md` shorter than this file.
- Write for users first. Use file paths only when they are useful for
  operators or maintainers.
