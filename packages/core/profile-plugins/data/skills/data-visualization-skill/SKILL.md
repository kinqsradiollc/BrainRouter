---
name: data-visualization-skill
description: Design, implement, and verify decision-useful charts, dashboards, figures, and interactive data stories without distorting the underlying evidence.
allowed-tools: [read_file, list_dir, grep_search, glob_files, write_file, edit_file, apply_patch, notebook_edit, lsp, run_command, artifact_write, browser_capabilities, browser_list_tabs, browser_get_state, browser_snapshot, browser_screenshot, browser_console, browser_network, browser_find_element, browser_assert_visible, browser_open_tab, browser_navigate, browser_reload, browser_wait, browser_select_tab, browser_close_tab, browser_click, browser_hover, browser_type, browser_press, browser_scroll, browser_set_device, browser_run_flow]
---

# Data visualization

## Overview

Turn a defined question and reviewed dataset into an honest visual explanation.
Choose encodings from the analytical relationship, preserve uncertainty and
provenance, and verify both static and interactive outputs for comprehension,
accessibility, and rendering defects.

## When to Use

Use for charts, dashboards, analytical figures, visual reports, exploratory
views, interactive data stories, or audits of a potentially misleading graphic.

## Workflow

1. State the audience, decision, comparison, unit of analysis, and the single
   question each view must answer. Separate exploratory views from publication
   or decision artifacts.
2. Verify source lineage, filters, joins, missingness, denominators, units,
   time zones, aggregation level, and uncertainty before choosing a chart.
3. Select the simplest encoding that preserves the relationship: position and
   length before area or angle; aligned scales for comparison; small multiples
   before overloaded color, animation, dual axes, or 3D.
4. Make scale choices explicit. Use truthful baselines, label log or truncated
   axes, disclose normalization and binning, preserve zero where magnitude is
   the claim, and never hide unfavorable or missing observations.
5. Design hierarchy, annotations, legends, labels, and color for the audience.
   Provide non-color distinctions, readable contrast, keyboard interaction
   where applicable, a text alternative, and a tabular fallback for material
   values.
6. Implement reproducibly from reviewed inputs. Keep transformations and chart
   specifications inspectable; bind filters and tooltips to the displayed
   population and units.
7. Verify totals and representative marks against source data, inspect empty,
   loading, error, narrow, dense, and extreme-value states, and review console,
   network, keyboard, responsive, and screenshot evidence for interactive work.
8. Deliver the visual artifact with its question, data source, transformation
   summary, uncertainty, limitations, accessibility alternative, and the
   conclusion the graphic does and does not support.

## Verification

- [ ] Every displayed value, denominator, filter, unit, and scale is auditable.
- [ ] The encoding matches the analytical question without visual distortion.
- [ ] Uncertainty, missing data, and material limitations remain visible.
- [ ] Color, keyboard, text alternatives, and narrow layouts are usable.
- [ ] Interactive states and representative plotted values were verified.

## Red Flags

- Choosing a chart library or decorative form before defining the question.
- Truncated axes, dual scales, 3D, area, or animation that exaggerate a result.
- Dashboards with many metrics but no decision hierarchy.
- Treating a visually striking association as causal evidence.
- Shipping a screenshot without checking data correctness or interaction states.
