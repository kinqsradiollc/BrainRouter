<!-- GENERATED FILE — do not edit by hand.
     Source: packages/core/src/extension/builtin/capabilities.ts (CAPABILITY_TOOLS).
     Regenerate: REGEN_CATALOG=1 npm --workspace packages/core test -- capability-catalog-drift
     Drift-checked by packages/core/src/tests/capability-catalog-drift.test.ts (ADR-046 D1). -->

# BrainRouter capability catalog

8 required-core capability extensions activating 88 built-in tools.

| Capability | Tools | Members |
|------------|-------|---------|
| `filesystem` | 13 | `apply_patch`, `atlas_context`, `edit_file`, `glob_files`, `grep_search`, `list_dir`, `notebook_edit`, `read_file`, `worktree_create`, `worktree_done`, `worktree_enter`, `worktree_list`, `write_file` |
| `mcp-lsp-connectors` | 10 | `connector_list`, `connector_run`, `list_mcp_resource_templates`, `list_mcp_resources`, `lsp`, `mcp_call`, `mcp_describe`, `mcp_refresh_catalog`, `mcp_search`, `read_mcp_resource` |
| `orchestration` | 17 | `close_agent`, `delegate_agent`, `list_agents`, `profile_stage`, `read_agent_transcript`, `resume_agent`, `route_task`, `send_input`, `session_list`, `session_read`, `session_reference`, `session_search`, `spawn_agent`, `spawn_agents`, `task_agent`, `wait_agent`, `wait_agents` |
| `planning-state` | 20 | `artifact_write`, `ask_user_choice`, `goal_blocked`, `goal_complete`, `mark_chapter`, `planner_add`, `planner_complete`, `planner_find`, `planner_schedule`, `planner_today`, `reconcile_steer`, `remind`, `switch_model`, `track_query`, `track_update`, `update_plan`, `workspace_create`, `workspace_link`, `workspace_resolve`, `workspace_update` |
| `security-review` | 7 | `file_vulnerability`, `finish_scan`, `list_requests`, `list_sitemap`, `repeat_request`, `scope_rules`, `view_request` |
| `shell` | 9 | `computer_use`, `kill_command`, `run_code`, `run_command`, `task_output`, `terminal_list`, `terminal_read`, `terminal_write`, `wait_until` |
| `web-research` | 4 | `fetch_url`, `research_brief`, `research_note`, `web_search` |
| `workflow-workers` | 8 | `close_worker`, `extract_result`, `read_worker_summary`, `run_workflow`, `run_workflow_graph`, `spawn_worker_thread`, `wait_worker`, `workflow_progress` |
