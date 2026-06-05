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
  createRouteTaskTool,
  createRunWorkflowTool,
} from '../../orchestration/tools.js';

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
    description: 'Run a shell command on the user\'s terminal. Requires user approval before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' }
      },
      required: ['command']
    }
  },
  {
    name: 'fetch_url',
    description: 'Fetch the text content of a URL from the internet (e.g. documentation, api references, etc.).',
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
    description: 'Search the public web for a query and return top results (title, url, snippet). Useful when fetch_url needs a starting point.',
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
    description: 'Start a persistent background worker thread for a self-contained task. It runs detached (your turn does NOT block), persists its transcript + rolling summary + status under .brainrouter/cli/workers/, and is observable via /workers and read_worker_summary. Returns the worker id. Workers cannot spawn workers.',
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
    description: 'Block until a worker thread finishes (bounded), then return its status + summary.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Worker id from spawn_worker_thread.' },
        timeoutMs: { type: 'number', description: 'Max wait in ms (default 600000).' }
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
  createRouteTaskTool(),
  createRunWorkflowTool(),
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
      'on either error, decide yourself and say which option you picked and why.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user (complete sentence ending with `?`).' },
        header: { type: 'string', description: 'Short chip-style label (≤12 chars) shown above the question, e.g. "Auth method" or "Storage".' },
        options: {
          type: 'array',
          description: '2–4 mutually exclusive choices. Each option needs a short label and a one-line description.',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short display text (1–5 words).' },
              description: { type: 'string', description: 'One-line explanation of what this option means or what will happen if chosen.' },
            },
            required: ['label', 'description'],
          },
        },
        multiSelect: { type: 'boolean', description: 'When true, allow the user to pick multiple options (comma-separated input). Defaults to false.' },
      },
      required: ['question', 'header', 'options'],
    },
  },
  {
    name: 'update_plan',
    description: 'Create or update the durable CLI task plan. Use this for multi-step work and keep at most one item in_progress.',
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
              step: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
            },
            required: ['step', 'status']
          }
        }
      },
      required: ['plan']
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
      'Mark the active /goal blocked. CALL when no defensible path remains within boundaries (missing data, ambiguous spec, external dependency). Pass a reason and what user input would unblock it. **PRECONDITION for "I don\'t know what X is" blockers: you MUST first have run `list_dir(.)`, at least one `glob_files` / `grep_search` for the term, AND read any `AGENT.md` / `AGENTS.md` / `CLAUDE.md` / `README.md` present in the workspace root. Workspace docs typically point at gitignored peer folders (e.g. `vendor/`, `third_party/`) that contain the answer — blocking purely on a memory miss is rejected.** The `reason` field MUST cite which directories/files you actually checked. CRITICAL: in the SAME assistant message as this tool call, ALSO write the user-visible explanation as prose — what you tried, what you learned, why you stopped, what the user needs to do next. The `reason` / `needed` fields are short audit metadata, NOT the deliverable.',
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
