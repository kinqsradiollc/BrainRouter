---
name: browser-testing-skill
description: Verify frontend behavior in a real browser with interaction, console, responsive, screenshot, and regression evidence.
allowed-tools: [read_file, list_dir, grep_search, glob_files, run_command, computer_use, mcp_search, mcp_describe, mcp_call]
---

# Browser and visual verification

## Overview

Verify the user-visible result, not only the component implementation. Exercise
the real route and state transitions, inspect runtime errors and accessibility,
and compare screenshots at representative viewports against the design intent.

## When to Use

Use after user-facing changes, visual regressions, responsive fixes, browser-only
bugs, interaction-state changes, or design-system updates.

## Workflow

1. Start the smallest production-representative surface and record the route,
   viewport, data state, and prerequisite actions. Do not substitute a static
   component snapshot when the feature depends on host or navigation behavior.
2. Exercise the primary path and meaningful alternatives: initial, loading,
   populated, empty, error, disabled, cancel, retry, reload, and stale-response
   behavior as applicable. Confirm persisted state by reopening when relevant.
3. Inspect console errors, failed requests, layout overflow, focus order, and
   accessibility structure while interacting. Test keyboard as well as pointer.
4. Capture screenshots at a narrow mobile viewport, a common desktop viewport,
   and any breakpoint implicated by the change. Include states where hierarchy,
   validation, menus, dialogs, or long content could fail.
5. Review images at full size against the applicable design artifact and nearby
   product surfaces. Check alignment, hierarchy, typography, density, clipping,
   contrast, and whether responsive changes preserve the user job.
6. Fix observed defects and repeat the exact path. Report commands, viewports,
   states, screenshot locations, console status, and remaining limitations.

## Verification

- [ ] The real integrated route or host surface was exercised.
- [ ] Primary, failure, cancellation, and persistence states were checked where relevant.
- [ ] Console, network, keyboard, focus, and overflow checks are clean.
- [ ] Screenshots cover representative narrow and desktop viewports.
- [ ] Final images were reviewed against design intent after the last change.

## Red Flags

- Claiming visual correctness from unit tests or source inspection alone.
- Capturing a screenshot without reviewing it at full size.
- Testing only the happy path or only one viewport.
- Ignoring console errors because the page appears usable.
