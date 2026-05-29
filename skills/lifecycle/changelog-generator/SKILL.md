---
name: changelog-generator
description: Automatically creates user-facing changelogs from git commits by analyzing commit history, categorizing changes, and transforming technical commits into clear, customer-friendly release notes. Turns hours of manual changelog writing into minutes of automated generation.
hints:
  - Check existing project files for CHANGELOG.md patterns and formats if available.
  - Exclude developer-only noise (e.g. chore, simple refactoring, config updates) from user-facing logs.
  - Group additions into cohesive, standard categories: Features, Improvements, Bug Fixes, Breaking Changes, Security.
  - Translate technical implementation terms (e.g., class names, SQL keys) into user-facing benefits and actions.
  - Highlight breaking changes or required migration steps prominently at the top of the changelog notes.
---

# Changelog Generator

This skill transforms technical git commits into polished, user-friendly changelogs that your customers and users will actually understand and appreciate.

## When to Use This Skill

- Preparing release notes for a new version
- Creating weekly or monthly product update summaries
- Documenting changes for customers
- Writing changelog entries for app store submissions
- Generating update notifications
- Creating internal release documentation
- Maintaining a public changelog/product updates page

## Overview

1. **Scans Git History**: Analyzes commits from a specific time period or between versions
2. **Categorizes Changes**: Groups commits into logical categories (features, improvements, bug fixes, breaking changes, security)
3. **Translates Technical → User-Friendly**: Converts developer commits into customer language
4. **Formats Professionally**: Creates clean, structured changelog entries
5. **Filters Noise**: Excludes internal commits (refactoring, tests, etc.)
6. **Follows Best Practices**: Applies changelog guidelines and your brand voice


## Workflow

1. Identify release scope (version range, commit range, or date range).
2. Gather relevant commits and exclude maintenance noise.
3. Group changes into user-facing categories.
4. Rewrite each item in plain customer language.
5. Format output as publish-ready markdown and verify clarity.

## Usage

### Basic Usage

From your project repository:

```
Create a changelog from commits since last release
```

```
Generate changelog for all commits from the past week
```

```
Create release notes for version 2.5.0
```

### With Specific Date Range

```
Create a changelog for all commits between March 1 and March 15
```

### With Custom Guidelines

```
Create a changelog for commits since v2.4.0, using my changelog 
guidelines from CHANGELOG_STYLE.md
```

## Example

**User**: "Create a changelog for commits from the past 7 days"

**Output**:
```markdown
# Updates - Week of March 10, 2024

## ✨ New Features

- **Team Workspaces**: Create separate workspaces for different 
  projects. Invite team members and keep everything organized.

- **Keyboard Shortcuts**: Press ? to see all available shortcuts. 
  Navigate faster without touching your mouse.

## 🔧 Improvements

- **Faster Sync**: Files now sync 2x faster across devices
- **Better Search**: Search now includes file contents, not just titles

## 🐛 Fixes

- Fixed issue where large images wouldn't upload
- Resolved timezone confusion in scheduled posts
- Corrected notification badge count
```

**Inspired by:** Manik Aggarwal's use case from Lenny's Newsletter

## Tips

- Run from your git repository root
- Specify date ranges for focused changelogs
- Use your CHANGELOG_STYLE.md for consistent formatting
- Review and adjust the generated changelog before publishing
- Save output directly to CHANGELOG.md

## Related Use Cases

- Creating GitHub release notes
- Writing app store update descriptions
- Generating email updates for users
- Creating social media announcement posts

## Common Rationalizations
| Rationalization | Reality |
|---|---|
| I'll just dump raw commit logs directly. | Raw commits contain internal technical jargon (e.g. `refactor: fix database constraints`) that confuses users. |
| No one reads changelogs, so formatting doesn't matter. | Well-structured changelogs demonstrate project health, building trust with users and stakeholders. |

## Red Flags
- Including chore commits (`chore: update eslint`) or test commits in user-facing release notes.
- Highlighting internal module names or database parameters instead of functional product capabilities.
- Obfuscating or hiding major breaking changes in fine print.

## Verification
After completing the skill, confirm:
- [ ] Technical jargon is completely rewritten to represent user-facing value and utility.
- [ ] Internal/engineering noise (tests, configs, refactors) is filtered out.
- [ ] Markdown formatting is verified clean, readable, and properly categorized.
