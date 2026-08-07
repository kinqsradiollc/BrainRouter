/** Browser-safe, prompt-free workspace tool-profile catalog. */
export interface WorkspaceToolProfileDefinition {
  id: string;
  label: string;
  description: string;
  category: string;
  toolIds: readonly string[];
  /** Stable first-party MCP names; live third-party names remain non-persistable. */
  mcpToolIds: readonly string[];
  extensionIds: readonly string[];
}

export const WORKSPACE_TOOL_PROFILES: readonly WorkspaceToolProfileDefinition[] = [
  {
    id: 'workspace-files',
    label: 'Workspace files',
    description: 'Inspect, search, create, and revise ordinary files in the workspace.',
    category: 'files-code',
    toolIds: [
      'read_file', 'list_dir', 'grep_search', 'glob_files',
      'write_file', 'edit_file', 'apply_patch',
    ],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'coding',
    label: 'Files and code',
    description: 'Inspect, edit, patch, and analyze source files and notebooks.',
    category: 'files-code',
    toolIds: [
      'read_file', 'list_dir', 'grep_search', 'glob_files',
      'write_file', 'edit_file', 'apply_patch', 'notebook_edit', 'lsp',
    ],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'shell',
    label: 'Shell commands',
    description: 'Run workspace commands and inspect or control an available native terminal.',
    category: 'terminal-computer',
    toolIds: ['run_command', 'task_output', 'wait_until', 'kill_command', 'terminal_list', 'terminal_read', 'terminal_write'],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'browser',
    label: 'Web and research',
    description: 'Fetch web pages and search public sources.',
    category: 'web-research',
    toolIds: ['fetch_url', 'web_search'],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'research-browser',
    label: 'Interactive research browser',
    description: 'Observe and navigate dynamic sources one page at a time without granting uploads, permission changes, device emulation, or bulk browser flows.',
    category: 'web-research',
    toolIds: [
      'browser_capabilities', 'browser_list_tabs', 'browser_get_state',
      'browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_network',
      'browser_downloads', 'browser_list_screens', 'browser_get_screen',
      'browser_find_element', 'browser_assert_visible',
      'browser_open_tab', 'browser_navigate', 'browser_back', 'browser_forward',
      'browser_reload', 'browser_stop', 'browser_wait',
      'browser_select_tab', 'browser_close_tab', 'browser_reopen_tab',
      'browser_click', 'browser_double_click', 'browser_tap', 'browser_hover',
      'browser_type', 'browser_press', 'browser_scroll', 'browser_select_option',
      'browser_check',
    ],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'project-knowledge',
    label: 'Project knowledge',
    description: 'List and search authenticated read-only knowledge attached to this project.',
    category: 'web-research',
    toolIds: [],
    mcpToolIds: ['knowledge_list', 'knowledge_search'],
    extensionIds: [],
  },
  {
    id: 'memory-context',
    label: 'Memory context',
    description: 'Recall and search authenticated read-only memory relevant to this project.',
    category: 'web-research',
    toolIds: [],
    mcpToolIds: [
      'memory_recall',
      'memory_search',
      'memory_find_related',
      'memory_graph_query',
    ],
    extensionIds: [],
  },
  {
    id: 'research-notes',
    label: 'Research notes',
    description: 'Capture sourced research notes and bounded research briefs.',
    category: 'notes-artifacts',
    toolIds: ['research_note', 'research_brief'],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    description: 'Create structured artifact records for designs, reports, learning materials, and other deliverables.',
    category: 'notes-artifacts',
    toolIds: ['artifact_write'],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'planning-session',
    label: 'Planning and session state',
    description: 'Maintain plans, goals, task tracking, chapter markers, and bounded user choices.',
    category: 'planning-session',
    toolIds: [
      'reconcile_steer', 'update_plan', 'goal_complete', 'goal_blocked',
      'track_query', 'track_update', 'mark_chapter', 'ask_user_choice',
    ],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'orchestration',
    label: 'Active-turn orchestration',
    description:
      'Route tasks and coordinate bounded child agents while the owning turn is active, including the built-in phase templates.',
    category: 'orchestration-workflows',
    // `run_workflow` belongs here, not only in `workflow-launch`: `route_task`'s
    // `workflow` tier and `spawn_agents`' description both tell the model to hand
    // a phase chain to it, and a workspace that enabled this group and not the
    // other was handed instructions naming a tool it could not emit. It runs the
    // same in-turn child spawns as the rest of this group; `workflow-launch`
    // keeps the surfaces that are NOT in-turn — saved graphs and progress
    // reporting from inside a running workflow.
    toolIds: [
      'profile_stage', 'task_agent', 'delegate_agent', 'spawn_agents', 'list_agents', 'wait_agent', 'wait_agents',
      'read_agent_transcript', 'close_agent', 'send_input', 'resume_agent', 'route_task', 'run_workflow',
    ],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'interactive-browser',
    label: 'Interactive browser control',
    description: 'Use tools contributed by the installed browser-control extension when its runtime is available.',
    category: 'design-browser',
    toolIds: [],
    mcpToolIds: [],
    extensionIds: ['browser'],
  },
  {
    id: 'mcp-resources',
    label: 'MCP resources',
    description: 'Discover configured MCP resources and use stable progressive-discovery controls.',
    category: 'mcp-connectors',
    toolIds: [
      'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
      'mcp_search', 'mcp_describe', 'mcp_call', 'mcp_refresh_catalog',
    ],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'connectors',
    label: 'Connectors',
    description: 'List configured connectors and run an explicitly authorized connector.',
    category: 'mcp-connectors',
    toolIds: ['connector_list', 'connector_run'],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'computer-control',
    label: 'Computer control',
    description: 'Operate an available computer-control session under its normal runtime and approval gates.',
    category: 'terminal-computer',
    toolIds: ['computer_use'],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'workflow-launch',
    label: 'Workflow launch',
    description: 'Launch reviewed workflows or saved graphs and inspect active workflow progress.',
    category: 'orchestration-workflows',
    toolIds: ['run_workflow', 'run_workflow_graph', 'workflow_progress'],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'background-workers',
    label: 'Background workers',
    description: 'Launch and manage durable root-owned worker threads that may outlive an interactive turn.',
    category: 'orchestration-workflows',
    toolIds: ['spawn_worker_thread', 'wait_worker', 'read_worker_summary', 'close_worker'],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'pull-request-observation',
    label: 'Pull request monitoring',
    description: 'Watch pull-request checks, reviews, and comments in the background and notify the active agent when action is needed.',
    category: 'development-lifecycle',
    toolIds: [],
    mcpToolIds: [],
    extensionIds: ['pull-request-observer'],
  },
  {
    id: 'security-review',
    label: 'Security review',
    description: 'Inspect isolated review traffic and record or finalize security findings.',
    category: 'security-review',
    toolIds: [
      'file_vulnerability', 'finish_scan', 'list_requests', 'view_request',
      'repeat_request', 'list_sitemap', 'scope_rules',
    ],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'terminal',
    label: 'Compatibility: terminal, computer, and connectors',
    description: 'Existing composite bundle retained unchanged for previously reviewed workspaces.',
    category: 'legacy-compatibility',
    toolIds: ['run_command', 'task_output', 'wait_until', 'kill_command', 'terminal_list', 'terminal_read', 'terminal_write', 'computer_use', 'connector_run'],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'notes',
    label: 'Compatibility: notes and artifacts',
    description: 'Existing composite bundle retained unchanged for previously reviewed workspaces.',
    category: 'legacy-compatibility',
    toolIds: ['research_note', 'research_brief', 'artifact_write'],
    mcpToolIds: [],
    extensionIds: [],
  },
  {
    id: 'design',
    label: 'Compatibility: artifacts and browser control',
    description: 'Existing composite bundle retained unchanged for previously reviewed workspaces.',
    category: 'legacy-compatibility',
    toolIds: ['artifact_write'],
    mcpToolIds: [],
    extensionIds: ['browser'],
  },
] as const;

