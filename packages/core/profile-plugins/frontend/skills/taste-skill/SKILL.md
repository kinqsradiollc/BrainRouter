---
name: taste-skill
description: Build frontend changes from the workspace design artifact and existing component system, preserving product intent instead of generating isolated generic UI.
allowed-tools: [read_file, list_dir, grep_search, glob_files, write_file, edit_file, apply_patch, run_command, artifact_write, browser_capabilities, browser_list_tabs, browser_get_state, browser_snapshot, browser_screenshot, browser_console, browser_network, browser_list_screens, browser_get_screen, browser_find_element, browser_assert_visible, browser_open_tab, browser_navigate, browser_reload, browser_back, browser_forward, browser_wait, browser_select_tab, browser_close_tab, browser_reopen_tab, browser_reorder_tab, browser_click, browser_double_click, browser_hover, browser_drag, browser_tap, browser_type, browser_press, browser_scroll, browser_select_option, browser_check, browser_upload_files, browser_downloads, browser_download_action, browser_permission, browser_dialog, browser_stop, browser_set_device, browser_run_flow]
---

# Product design discipline

## Overview

Treat frontend work as engineering within an existing product language. Discover
the design artifact and reusable component system before implementation, derive
missing decisions from product intent and existing evidence, and record only
stable design decisions that future work must follow.

## When to Use

Use for user-facing pages, components, layouts, navigation, styling, themes,
design-system work, or any change where visual hierarchy and interaction quality
are part of correctness.

## Workflow

1. Inspect `DESIGN.md` and `design.md` from the workspace root downward, then
   inspect nearby screens, components, tokens, typography, assets, breakpoints,
   and interaction conventions. If multiple design artifacts apply, prefer the
   nearest scoped file and preserve non-conflicting parent rules.
2. State the user goal, information hierarchy, key states, and constraints.
   Preserve strong existing UX; do not replace it merely to impose a new style.
3. Reuse or extend existing components and tokens before creating a parallel
   abstraction. Search call sites so a shared change does not cause regressions.
4. Implement the smallest coherent responsive surface. Cover loading, empty,
   error, disabled, focus, hover, active, and long-content states where relevant.
5. If a stable new decision was required, update the applicable design artifact
   with semantic guidance: intent, token or component rule, responsive behavior,
   and exceptions. Do not turn it into a changelog or copy transient CSS values.
6. Hand off to accessibility and browser-visual verification. Reconcile the
   implementation, design artifact, and observed output before completion.

## Verification

- [ ] The applicable design artifact and component system were inspected first.
- [ ] Existing components and tokens are reused or deliberately extended.
- [ ] Hierarchy, states, content extremes, and responsive behavior are coherent.
- [ ] Any design-artifact update records a durable rule, not implementation noise.
- [ ] The result is ready for accessibility and visual browser checks.

## Red Flags

- Creating a new component when an established equivalent already exists.
- Generic placeholder copy, invented metrics, or decorative UI with no user job.
- Updating the design artifact to justify an implementation after the fact.
- A desktop-only composition with no small-screen behavior.
