/**
 * REFAC-TOOLS-MODULE (0.4.6) — the local tool SPECS (model-visible
 * name/description/inputSchema), extracted verbatim from agent.ts. This is the
 * static metadata the 0.4.7 CODEX-TOOL-REGISTRY will fold into a single
 * tool-executor contract (spec + exposure + policy + parallel-safety). No
 * behavior change; re-exported from agent.ts for back-compat.
 */
import {
  createTaskAgentTool,
  createDelegateAgentTool,
  createSpawnAgentTool,
  createSpawnAgentsTool,
  createListAgentsTool,
  createWaitAgentTool,
  createWaitAgentsTool,
  createReadAgentTranscriptTool,
  createCloseAgentTool,
  createSendInputTool,
  createResumeAgentTool,
  createRouteTaskTool,
  createRunWorkflowTool,
  createRunWorkflowGraphTool,
} from '../orchestration/tools.js';

export const LOCAL_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from the workspace. Optional line ranges can be provided.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to workspace root.' },
        startLine: { type: 'integer', description: 'Optional 1-based start line number to read from.' },
        endLine: { type: 'integer', description: 'Optional 1-based end line number to read to.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing file in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to workspace root.' },
        content: { type: 'string', description: 'The full content to write to the file.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: 'Edit an existing file in the workspace by replacing a target substring with a replacement string.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to workspace root.' },
        targetContent: { type: 'string', description: 'The exact substring in the file to be replaced.' },
        replacementContent: { type: 'string', description: 'The replacement string.' }
      },
      required: ['path', 'targetContent', 'replacementContent']
    }
  },
  {
    name: 'list_dir',
    description: 'List the contents of a directory in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the directory, relative to workspace root. Defaults to "."' }
      }
    }
  },
  {
    name: 'grep_search',
    description: 'Search workspace files for a REGULAR-EXPRESSION query (JS regex syntax — e.g. `foo|bar`, `\\bclass\\b`). `path` may be a directory (searched recursively, build/VCS/.claude/.brainrouter dirs skipped) or a single file. Returns up to 50 matches as {path,line,text}.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory (recursed) or file to search. Defaults to "."' },
        query: { type: 'string', description: 'Regular expression to match per line (JS regex; falls back to literal substring if the pattern is invalid regex).' }
      },
      required: ['query']
    }
  },
  {
    name: 'glob_files',
    description: 'Recursively find files in the workspace matching a glob/wildcard pattern (e.g., "src/**/*.ts" or "*.json").',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob or wildcard pattern to search for.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command on the user\'s terminal. Requires user approval before execution. Pass background:true to DETACH a long-running command (build, server, watch) — returns an id immediately; poll its output with task_output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        background: { type: 'boolean', description: 'Detach and return an id immediately instead of blocking (poll with task_output). Default false.' }
      },
      required: ['command']
    }
  },
  {
    name: 'task_output',
    description: 'Read incremental output of a background run_command: returns { status, exitCode, chunk, nextOffset, complete }. Pass the previous nextOffset as fromByte to read only new output.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Run id returned by run_command({background:true}).' },
        fromByte: { type: 'number', description: 'Byte offset to read from. Default 0.' }
      },
      required: ['id']
    }
  },
  {
    name: 'computer_use',
    description: 'Control the real local desktop mouse/keyboard or capture a screenshot. Requires user approval for mutating actions and only appears when desktop computer use is enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'left_click', 'right_click', 'double_click', 'move', 'type', 'key', 'scroll', 'drag'],
          description: 'The computer action to perform.'
        },
        x: { type: 'number', description: 'Logical screen x coordinate.' },
        y: { type: 'number', description: 'Logical screen y coordinate.' },
        x2: { type: 'number', description: 'Logical destination x coordinate for drag.' },
        y2: { type: 'number', description: 'Logical destination y coordinate for drag.' },
        text: { type: 'string', description: 'Text to type for action=type.' },
        keys: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Key or chord for action=key, e.g. "cmd+s" or ["cmd","s"].'
        },
        clicks: { type: 'integer', description: 'Scroll notches/click count; capped for safety.' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for actions that support it.' },
        hold_keys: { type: 'array', items: { type: 'string' }, description: 'Modifier keys to hold during a click or drag.' }
      },
      required: ['action']
    }
  },
  {
    name: 'fetch_url',
    description: 'Fetch and extract clean text from an HTTP(S) URL using the configured in-house crawler.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The absolute HTTP or HTTPS URL to fetch.' }
      },
      required: ['url']
    }
  },
  {
    name: 'web_search',
    description: 'Search the public web with the configured provider and return normalized results (title, url, snippet). Useful when fetch_url needs a starting point.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        maxResults: { type: 'integer', description: 'Maximum results to return. Default 5, max 10.' }
      },
      required: ['query']
    }
  },
  {
    name: 'research_note',
    description: 'Record one piece of evidence into the session research ledger: a claim, the sources backing it, whether they support/refute/are unclear about it, and your confidence. Use during evidence-driven research (after web_search / fetch_url) so the final research_brief can cross-check sources and flag conflicts.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: 'The specific factual claim this evidence bears on.' },
        sources: { type: 'array', items: { type: 'string' }, description: 'URLs or short source descriptions backing the claim.' },
        stance: { type: 'string', enum: ['support', 'refute', 'unclear'], description: 'Do the sources support, refute, or are unclear about the claim? Default unclear.' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Confidence in this finding. Default low.' },
        note: { type: 'string', description: 'Optional nuance, caveat, or short quote.' }
      },
      required: ['claim']
    }
  },
  {
    name: 'research_brief',
    description: 'Emit a report-ready markdown research brief from the session ledger: every finding plus an explicit "Uncertainty & conflicts" section (corroborated vs single-source vs conflicting). Optionally set/refine the research question. Save the returned markdown with artifact_write to persist it.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Optional — set or refine the research question shown in the brief header.' }
      }
    }
  },
  {
    name: 'list_mcp_resources',
    description: 'List resources provided by MCP servers. Resources are structured context such as files, schemas, or app data; prefer them over web search when available.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Optional pagination cursor from a previous list_mcp_resources result.' },
        server: { type: 'string', description: 'Optional MCP server id to list. Use the server value returned by prior resource listings.' }
      }
    }
  },
  {
    name: 'list_mcp_resource_templates',
    description: 'List parameterized resource templates provided by MCP servers.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Optional pagination cursor from a previous list_mcp_resource_templates result.' },
        server: { type: 'string', description: 'Optional MCP server id to list. Use the server value returned by prior template listings.' }
      }
    }
  },
  {
    name: 'read_mcp_resource',
    description: 'Read a specific resource from an MCP server by server id and URI.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server id returned by list_mcp_resources or list_mcp_resource_templates.' },
        uri: { type: 'string', description: 'Resource URI to read.' }
      },
      required: ['server', 'uri']
    }
  },
  {
    name: 'mcp_search',
    description: 'Search the connected MCP tool catalog by keyword (matches tool name, server, and description) and return the best-matching tools, each with a one-line summary. Use this FIRST when MCP progressive discovery is on: the full catalog is hidden to save context, so search for what you need, then run it with mcp_call (or mcp_describe first to see its parameters).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to match against tool names, servers, and descriptions.' },
        maxResults: { type: 'integer', description: 'Maximum tools to return. Default 8, max 25.' }
      },
      required: ['query']
    }
  },
  {
    name: 'mcp_describe',
    description: 'Return the full description and input JSON schema for one or more MCP tools by their exact name (as returned by mcp_search). Call before mcp_call to learn a tool\'s parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Exact MCP tool name(s) to describe (from mcp_search results).' },
        name: { type: 'string', description: 'A single MCP tool name (alternative to names).' }
      }
    }
  },
  {
    name: 'mcp_call',
    description: 'Invoke an MCP tool by its exact name (from mcp_search) with the given arguments. Runs the SAME approval and safety checks as calling the tool directly. Use this to actually run a tool you found via mcp_search when progressive discovery has the full catalog hidden.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact MCP tool name to call (from mcp_search / mcp_describe).' },
        args: { type: 'object', description: 'Arguments object for the tool, matching its input schema.' }
      },
      required: ['name']
    }
  },
  {
    name: 'mcp_refresh_catalog',
    description: 'Re-scan connected MCP servers and return a summary of available tools grouped by server (with counts). Use if a server was just connected or you suspect the catalog changed.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'lsp',
    description: "Semantic code navigation via the language server (exact, not fuzzy). actions: definition / references / hover (need file + 1-based line + character), symbols (file only, lists the file's symbols). Returns file:line:col locations or hover text. Requires a configured language server (cli.lspServers); reports clearly when none is available.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['definition', 'references', 'hover', 'symbols'], description: 'The LSP query.' },
        file: { type: 'string', description: 'File path (workspace-relative or absolute).' },
        line: { type: 'integer', description: '1-based line of the symbol (required for definition/references/hover).' },
        character: { type: 'integer', description: '1-based column of the symbol (default 1).' }
      },
      required: ['action', 'file']
    }
  },
  {
    name: 'extract_result',
    description: 'Expand a large tool result that was handed off (you hold a `resultRef` instead of the full output). With no `query`, returns the head of the result; with a `query`, returns the matching lines plus surrounding context. Use this instead of re-running the original tool when you only need a slice of a big output.',
    inputSchema: {
      type: 'object',
      properties: {
        resultRef: { type: 'string', description: 'The resultRef from a handed-off tool result.' },
        query: { type: 'string', description: 'Optional case-insensitive substring to search the full result for.' },
        maxChars: { type: 'integer', description: 'Cap on returned characters. Default 4000.' }
      },
      required: ['resultRef']
    }
  },
  {
    name: 'spawn_worker_thread',
    description: 'Start a persistent background worker thread for a self-contained task. It runs detached (your turn does NOT block), persists its transcript + rolling summary + status in the workspace CLI state, and is observable via /workers and read_worker_summary. Returns the worker id. Workers cannot spawn workers.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The self-contained task for the worker.' },
        role: { type: 'string', description: 'Agent role/persona for the worker (default: worker).' },
        prompt: { type: 'string', description: 'Task prompt the worker runs; defaults to the goal.' },
        ownership: { type: 'string', description: 'Glob the worker may write within (MAS-P3); defaults to your own ownership.' }
      },
      required: ['goal']
    }
  },
  {
    name: 'wait_worker',
    description: 'Block until a worker thread finishes or the wait timeout elapses, then return its status + summary. A wait timeout does not stop or fail the worker.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Worker id from spawn_worker_thread.' },
        timeoutMs: { type: 'number', description: 'Max parent wait in ms (default 600000). Use 0 to wait until completion.' }
      },
      required: ['id']
    }
  },
  {
    name: 'read_worker_summary',
    description: "Read a worker thread's rolling summary (summary.md) without waiting for it to finish.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Worker id.' } },
      required: ['id']
    }
  },
  {
    name: 'close_worker',
    description: 'Mark a worker thread closed (terminal). Its in-process run, if any, is left to wind down but its result is no longer adopted.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Worker id.' } },
      required: ['id']
    }
  },
  {
    name: 'mark_chapter',
    description: 'Mark the start of a new chapter when the work shifts to a meaningfully different phase (exploration -> implementation -> verification, or a topic pivot). Sparingly — a typical session has 3-8 chapters. The user browses them with /chapters.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short noun-phrase title, under 40 chars (e.g. "Auth bug fix").' },
        summary: { type: 'string', description: 'Optional one-line summary of what the chapter covers.' }
      },
      required: ['title']
    }
  },
  {
    name: 'wait_until',
    description: 'Block until a workspace condition holds or the timeout elapses: a file exists, or a file contains a text marker. Use after starting background work (a worker, a detached build writing a log) to wait for its artifact instead of polling manually. Returns { satisfied, waitedMs }.',
    inputSchema: {
      type: 'object',
      properties: {
        condition: { type: 'string', enum: ['file_exists', 'file_contains'], description: 'What to wait for.' },
        path: { type: 'string', description: 'Workspace-relative file path to watch.' },
        text: { type: 'string', description: 'Required for file_contains — the marker text to look for.' },
        timeoutMs: { type: 'number', description: 'Max wait in ms. Default 60000, capped at 600000.' },
        pollMs: { type: 'number', description: 'Poll interval in ms. Default 500, min 50.' }
      },
      required: ['condition', 'path']
    }
  },
  {
    name: 'artifact_write',
    description:
      'Create or update a durable ARTIFACT — a self-contained, reusable piece of work the user will want to refer back to, edit, or keep: a design doc, a report, an HTML/SVG mockup, a diagram, a standalone code file. PROMOTE to an artifact (instead of leaving it inline in chat) when the content is substantial (~15+ lines), self-contained, and likely to be iterated or reused; keep short, conversational, or one-off answers inline. ' +
      'OMIT `id` to create a new artifact (needs `title`, `content`, and a `kind`). PASS `id` to GROW an existing artifact in place — every content change is saved as a new VERSION (the user can diff/revert), and passing an id is how a later turn or a sub-agent keeps editing the SAME artifact instead of making a new one. ' +
      'Artifacts are captures of work, NOT applications: keep them single, self-contained pages — no backend, no external network calls. ' +
      'STYLING (§AV-6): when an artifact is visual (html/svg), honor the project DESIGN SYSTEM if the workspace instruction file (AGENT.md / AGENTS.md / CLAUDE.md / .cursorrules / codex.md, shown in your context) defines a "Design system" section — its palette, typography, and spacing. Precedence: an explicit user request wins over project tokens, which win over your own defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Existing artifact id (art_…) to update in place. Omit to create a new one.' },
        kind: { type: 'string', enum: ['design-note', 'sketch', 'html-prototype', 'markdown-report', 'verification-summary', 'review-export', 'other'], description: 'What kind of artifact (create only). Default: markdown-report.' },
        title: { type: 'string', description: 'Short human title. Required when creating.' },
        format: { type: 'string', enum: ['markdown', 'html', 'text', 'svg', 'mermaid', 'code'], description: 'How to render the content. Default: markdown.' },
        language: { type: 'string', description: 'Source language for format:"code" (e.g. "ts", "py") — drives syntax highlighting.' },
        content: { type: 'string', description: 'The FULL artifact content (replaces prior content; the old content is kept as a version).' },
        summary: { type: 'string', description: 'Optional one-line description of what the artifact is.' },
        note: { type: 'string', description: 'Optional one-line note about what changed (shown in the version history).' },
      },
      required: ['content'],
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply a multi-file patch using the Begin/End envelope format ("*** Begin Patch / *** Update File: path / @@ context / -old / +new / *** Add File: / *** Delete File: / *** End Patch"). Lets you make several coordinated edits across files in one tool call.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'The full patch text including Begin Patch/End Patch envelope.' }
      },
      required: ['patch']
    }
  },
  createTaskAgentTool(),
  createDelegateAgentTool(),
  createSpawnAgentTool(),
  createSpawnAgentsTool(),
  createListAgentsTool(),
  createWaitAgentTool(),
  createWaitAgentsTool(),
  createReadAgentTranscriptTool(),
  createCloseAgentTool(),
  createSendInputTool(),
  createResumeAgentTool(),
  createRouteTaskTool(),
  createRunWorkflowTool(),
  createRunWorkflowGraphTool(),
  {
    name: 'ask_user_choice',
    description:
      'Pause the turn and ask the human to commit to ONE of 2–4 mutually exclusive approaches. ' +
      'Renders an arrow-key picker (↑/↓ navigate, ENTER confirm; SPACE toggles in multiSelect mode) ' +
      'with an always-on "Other" row that drops to a free-text prompt — the user is never trapped between bad options. ' +
      'Returns { answer: <chosen label or free-text> } in single-select, or { answer: [labels/free-text…] } in multiSelect. ' +
      'Use ONLY when there is genuine ambiguity that needs the user\'s judgment — NOT for trivial yes/no confirmations ' +
      '(`askYesNo` is wired into approval gates already), NOT for things you can decide yourself with the available context, ' +
      'and NOT as a substitute for thinking. ' +
      'Errors in non-interactive runs (CI / piped / `brainrouter run`) and when the user cancels (Esc/q/Ctrl+C); ' +
      'on either error, decide yourself and say which option you picked and why. ' +
      'OPTION QUALITY (this is what separates a good question from a survey): each `description` states the real CONSEQUENCE, tradeoff, and risk of that choice — written so the user can decide with NO outside knowledge — not a restatement of the label. Put the option YOU would pick FIRST and mark its label "(Recommended)". Add a sequencing/hedge option ("A now, B later") when viable. ' +
      'To ask several related questions at once, pass a `questions` array instead of the single-question fields — each is asked in turn and all answers come back together; prefer this over dripping one question per turn.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user (complete sentence ending with `?`). Single-question form. For several related questions at once, use `questions` instead.' },
        header: { type: 'string', description: 'Short chip-style label (≤12 chars) shown above the question, e.g. "Auth method" or "Storage".' },
        options: {
          type: 'array',
          description: '2–4 mutually exclusive choices. Each description states the consequence/tradeoff/risk (not the label); recommended option first, marked "(Recommended)".',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short display text (1–5 words).' },
              description: { type: 'string', description: 'The consequence/tradeoff/risk of choosing this — enough that the user needs no outside knowledge.' },
            },
            required: ['label', 'description'],
          },
        },
        multiSelect: { type: 'boolean', description: 'When true, allow the user to pick multiple options (comma-separated input). Defaults to false.' },
        questions: {
          type: 'array',
          description: 'Batched form: 1–4 related questions asked in one pause; all answers return together. Use INSTEAD of the single-question fields, not alongside.',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'A complete question ending with `?`.' },
              header: { type: 'string', description: 'Short chip label (≤12 chars).' },
              options: {
                type: 'array', minItems: 2, maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Short display text (1–5 words).' },
                    description: { type: 'string', description: 'The consequence/tradeoff/risk of choosing this.' },
                  },
                  required: ['label', 'description'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Allow multiple picks for this question.' },
            },
            required: ['question', 'header', 'options'],
          },
        },
      },
    },
  },
  {
    name: 'update_plan',
    description:
      'Create or update the durable CLI task plan. Use it ONLY for work with ≥3 non-trivial steps (1–2 steps: just do them). ' +
      'Each item is ONE verifiable outcome in imperative voice ("Add the migration", not "Database work") — and give it an `acceptance` cue where it helps (how you\'ll know it\'s done: "tests pass", "endpoint returns 200"). ' +
      'Keep at most one item `in_progress` and mark each `completed` the moment it\'s done, never in batches. Rewrite the plan as you learn — a stale plan is worse than none. Never start an item too large to finish in one focused pass; decompose it first.',
    inputSchema: {
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'Optional short explanation of the plan update.' },
        plan: {
          type: 'array',
          description: 'Ordered plan items.',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', description: 'One verifiable outcome, imperative voice.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              acceptance: { type: 'string', description: 'Optional: how you will know this item is done (e.g. "tests pass", "file written", "benchmark hit").' }
            },
            required: ['step', 'status']
          }
        }
      },
      required: ['plan']
    }
  },
  {
    name: 'track_query',
    description: 'Read the workspace project board (Track mode — one project per workspace). action: "list" (all work items, optionally filtered), "get" (one by key), "board" (items grouped into status columns), "sprints", "sprint-detail", or "velocity". Read-only. Use it to see what work exists before creating or transitioning items.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'board', 'sprints', 'sprint-detail', 'velocity'], description: 'list · get · board · sprints · sprint-detail · velocity' },
        key: { type: 'string', description: 'Work-item key (e.g. "BR-12") for action="get".' },
        sprintId: { type: 'string', description: 'Sprint id for action="sprint-detail" or action="velocity".' },
        status: { type: 'string', description: 'Filter by workflow-state id (list).' },
        type: { type: 'string', enum: ['epic', 'story', 'task', 'bug', 'sub-task'], description: 'Filter by type (list).' },
        assignee: { type: 'string', description: 'Filter by assignee (list).' },
        text: { type: 'string', description: 'Substring filter over key + title (list).' }
      },
      required: ['action']
    }
  },
  {
    name: 'track_update',
    description: 'Create or change project-board work (Track mode). action: "create", "transition", "comment", "link", "sprint-create", "assign-sprint", "batch-transition", "sprint-start", or "sprint-complete". Writes workspace state (track.json) — no approval needed. Link items to the branches/commits/PRs you produce so the board stays connected to the code.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'transition', 'comment', 'link', 'sprint-create', 'assign-sprint', 'batch-transition', 'sprint-start', 'sprint-complete'], description: 'create · transition · comment · link · sprint-create · assign-sprint · batch-transition · sprint-start · sprint-complete' },
        key: { type: 'string', description: 'Work-item key (transition/comment/link).' },
        title: { type: 'string', description: 'Title (create).' },
        type: { type: 'string', enum: ['epic', 'story', 'task', 'bug', 'sub-task'], description: 'Item type (create).' },
        status: { type: 'string', description: 'Initial workflow-state id (create).' },
        toStatus: { type: 'string', description: 'Target workflow-state id (transition).' },
        priority: { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'], description: 'Priority (create).' },
        body: { type: 'string', description: 'Comment body (comment).' },
        codeLinks: { type: 'array', description: 'Code links to attach (link): [{ kind: "branch"|"commit"|"pull-request"|"file", ref }].', items: { type: 'object' } },
        linkedMemoryIds: { type: 'array', description: 'Memory record ids to link (link).', items: { type: 'string' } },
        blocks: { type: 'string', description: 'Key of a work item this one blocks (link).' },
        sprintId: { type: 'string', description: 'Sprint id (assign-sprint, sprint-start, sprint-complete).' },
        name: { type: 'string', description: 'Sprint name (sprint-create).' },
        goal: { type: 'string', description: 'Optional sprint goal (sprint-create).' },
        query: { type: 'string', description: 'Track query selecting work items (batch-transition).' },
        capacity: { type: 'number', description: 'Optional sprint capacity (sprint-start).' }
      },
      required: ['action']
    }
  },
  {
    name: 'workflow_progress',
    description: 'Report progress on the active durable workflow run (PARITY-W1) so `/workflows` shows live status and progress survives a restart. Call with status="running" when you START a numbered step and status="done" (or "failed"/"skipped") when you finish it. `step` is a short id matching the step you are on (e.g. "triage", "review", "implement", "verify", "apply"). Safe no-op when no workflow is active — only the multi-agent commands (/review, /simplify, /feature-dev, /spec, /implement-plan) bind one.',
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'string', description: 'Short step id, e.g. "triage", "implement", "verify".' },
        status: { type: 'string', enum: ['running', 'done', 'failed', 'skipped'], description: 'New status for the step.' },
        note: { type: 'string', description: 'Optional one-line detail (what was done, or why it failed/was skipped).' },
      },
      required: ['step', 'status'],
    },
  },
  {
    name: 'goal_complete',
    description:
      'Mark the active /goal complete. CALL ONLY when concrete evidence in the thread (tests passing, file written, benchmark hit, artifact produced) proves the outcome is satisfied. Pass a 1–2 sentence proof citing the evidence. PRECONDITION: if you have an active plan (from update_plan), every item must be marked `completed` before this call succeeds — call update_plan first to mark finished work done (or mark intentionally-dropped items completed with a rationale). The CLI hard-refuses goal_complete while pending / in_progress items remain. CRITICAL: in the SAME assistant message as this tool call, ALSO write the user-visible deliverable as prose — the actual answer, analysis, summary, or report the user asked for. The `proof` field is short audit metadata (file paths, test names, command exit codes), NOT the deliverable. If you skip the prose, the user sees only a placeholder and your work is invisible to them.',
    inputSchema: {
      type: 'object',
      properties: {
        proof: { type: 'string', description: 'Short evidence-based justification (file path / test name / output). Audit metadata only — NOT the user-visible answer; put that in the assistant message text.' },
      },
      required: ['proof'],
    },
  },
  {
    name: 'goal_blocked',
    description:
      'Mark the active /goal blocked. CALL when no defensible path remains within boundaries (missing data, ambiguous spec, external dependency). Pass a reason and what user input would unblock it. **PRECONDITION for "I don\'t know what X is" blockers: you MUST first have run `list_dir(.)`, at least one `glob_files` / `grep_search` for the term, AND read any `AGENT.md` / `AGENTS.md` / `CLAUDE.md` / `.cursorrules` / `codex.md` / `README.md` present in the workspace root. Workspace docs typically point at gitignored peer folders (e.g. `vendor/`, `third_party/`) that contain the answer — blocking purely on a memory miss is rejected.** The `reason` field MUST cite which directories/files you actually checked. CRITICAL: in the SAME assistant message as this tool call, ALSO write the user-visible explanation as prose — what you tried, what you learned, why you stopped, what the user needs to do next. The `reason` / `needed` fields are short audit metadata, NOT the deliverable.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason progress stalled. Audit metadata only — write the full explanation in the assistant message text.' },
        needed: { type: 'string', description: 'What user input or external resource would unblock progress.' },
      },
      required: ['reason'],
    },
  }
];
