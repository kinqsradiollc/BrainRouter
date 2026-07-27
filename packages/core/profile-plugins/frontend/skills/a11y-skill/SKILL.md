---
name: a11y-skill
description: Treat accessibility and responsive behavior as frontend acceptance criteria through semantic, keyboard, contrast, zoom, and content-stress checks.
allowed-tools: [read_file, list_dir, grep_search, glob_files, write_file, edit_file, apply_patch, run_command, artifact_write, browser_capabilities, browser_list_tabs, browser_get_state, browser_snapshot, browser_screenshot, browser_console, browser_network, browser_list_screens, browser_get_screen, browser_find_element, browser_assert_visible, browser_open_tab, browser_navigate, browser_reload, browser_back, browser_forward, browser_wait, browser_select_tab, browser_close_tab, browser_reopen_tab, browser_reorder_tab, browser_click, browser_double_click, browser_hover, browser_drag, browser_tap, browser_type, browser_press, browser_scroll, browser_select_option, browser_check, browser_upload_files, browser_downloads, browser_download_action, browser_permission, browser_dialog, browser_stop, browser_set_device, browser_run_flow, computer_use, mcp_search, mcp_describe, mcp_call]
---

# Accessibility and responsive acceptance

## Overview

Accessibility is a functional requirement, not a final audit. Start with native
semantics and resilient layout, then verify keyboard, focus, names, states,
contrast, motion, zoom, touch, and screen-size behavior with real interactions.

## When to Use

Use for every user-facing frontend change, especially dialogs, forms, navigation,
dynamic updates, data visualizations, custom controls, and responsive layouts.

## Workflow

1. Identify the interaction contract and choose native elements before ARIA.
   Ensure visible labels, programmatic names, roles, states, and relationships
   describe the same behavior.
2. Trace keyboard order and focus lifecycle: entry, activation, validation,
   cancellation, close, route or workspace changes, and restoration. Never trap
   focus outside an intentional modal boundary.
3. Check text and control contrast, non-color cues, reduced motion, pointer and
   touch targets, alternative text, captions or transcripts, and meaningful
   status/error announcements.
4. Stress the layout at narrow and wide widths, browser zoom, larger text, long
   localized strings, empty data, errors, and dense content. No essential
   controls may clip, overlap, or require accidental horizontal scrolling.
5. Run available automated checks, but manually exercise the changed path with
   keyboard and visible focus. Inspect the accessibility tree when a custom
   control or ambiguous announcement is involved.
6. Fix issues at the semantic or layout source, rerun the path, and report any
   limitation with affected users and a concrete follow-up.

## Verification

- [ ] Native semantics, accessible names, and state announcements are correct.
- [ ] The full changed path works by keyboard with visible, restored focus.
- [ ] Contrast, non-color meaning, motion preferences, and touch targets pass.
- [ ] Zoom, larger text, long content, and narrow layouts retain all functionality.
- [ ] Automated results are paired with manual interaction evidence.

## Red Flags

- Adding ARIA to imitate behavior a native element already provides.
- Declaring accessibility complete from a linter alone.
- Hidden focus, clipped controls, or horizontal overflow at realistic zoom.
- Error text that is visible but not associated with its control.
