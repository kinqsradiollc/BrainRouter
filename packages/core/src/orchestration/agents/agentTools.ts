/**
 * REFAC-AGENT-ORCH (0.4.6) — the orchestration tool SPEC factories, extracted
 * verbatim from tools.ts. Each returns a pure model-visible tool spec
 * (name/description/inputSchema) consumed by agent/tools/specs.ts to build
 * the orchestration capability extension. No shared state and no Agent-runtime
 * dependencies; re-exported from tools.ts for back-compat.
 *
 * Tool descriptions are also where the orchestration CONTRACT lives. The base
 * system prompt is at its token cap, and a description the model reads next to
 * the schema it is about to fill in is a better place for "what makes this call
 * worth its cost" than one more line of general instruction it read 5k tokens
 * ago.
 */

import { adversarialLens, investigationLenses, reviewLenses } from '../lenses.js';

export function createProfileStageTool() {
  return {
    name: 'profile_stage',
    description:
      'Advance a primary-agent stage from the active workspace profile plan. ' +
      'Call begin before doing the stage work; when the stage declares skills, execute the returned instructions using only the returned tool surface, then call complete. ' +
      'A multi-skill stage requires one begin/complete pair per declared skill. Optional stages may be skipped before they start. ' +
      'Launch a delegated-role stage with task_agent or delegate_agent and its exact stageId; profile_stage does not launch children. ' +
      'No stage transition can grant tools beyond the reviewed workspace policy.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['begin', 'complete', 'skip'],
          description: 'Begin a primary stage/its next skill, complete the active skill or stage, or skip an optional unstarted stage.',
        },
        stageId: {
          type: 'string',
          description: 'Stage id from the active profile strategy.',
        },
        skillId: {
          type: 'string',
          description: 'Declared skill id. Optional when the stage has one remaining skill; omit for skill-less stages.',
        },
      },
      required: ['action', 'stageId'],
    },
  };
}

export function createSpawnAgentTool() {
  return {
    name: 'spawn_agent',
    description: 'Spawn a child agent and a bounded prompt. Returns the child agent id immediately; the child runs in the background. Specify the agent via `role` (legacy: explorer/architect/reviewer/worker/verifier) or `agentId` (registry id, e.g. a custom workspace definition).',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'One of: explorer, architect, reviewer, worker, verifier. Prefer agentId for custom definitions.' },
        agentId: { type: 'string', description: 'Registry id of the agent definition. Takes precedence over role when both are provided.' },
        prompt: { type: 'string', description: 'The bounded task prompt for the child agent.' },
        label: { type: 'string', description: 'Optional short label for the child run.' },
        access: { type: 'string', enum: ['read', 'write', 'shell'], description: 'Override the role default access mode. Default: role default.' },
        wait: { type: 'boolean', description: 'If true, block until the child completes and return its final output. Default: false.' },
        timeoutMs: { type: 'integer', description: 'Optional parent wait timeout in milliseconds when wait=true. 0 or omitted waits until completion; timeout returns an envelope and leaves the child running.' },
        workdir: { type: 'string', description: 'Optional workspace-relative child launch directory. Must exist; invalid values fall back to the parent CWD.' },
        seedRecordIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional BrainRouter memory record IDs that the parent already recalled. The child agent is told to build on these instead of re-discovering them.',
        },
        overlay: {
          type: 'string',
          description: 'Optional one-off instruction overlay (≤4000 chars) appended to the child\'s role prompt — the escape hatch for a bespoke contractor the preset roles don\'t cover (e.g. "only touch the CSS, match the existing design tokens"). The child is marked synthetic.',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh'],
          description: 'Optional reasoning-effort override for this child (otherwise inherits the session /effort).',
        },
      },
      required: ['prompt'],
    },
  };
}

export function createTaskAgentTool() {
  return {
    name: 'task_agent',
    description:
      'Launch a new agent to handle complex, multi-step tasks autonomously. Returns the completed child output (foreground, blocks).\n\n' +
      'When using task_agent, specify a `role` to select which specialized agent type to use. Roles: explorer (read-only investigation), architect (design alternatives), reviewer (code review), worker (write access), verifier (tests/checks). Use `agentId` for custom workspace definitions.\n\n' +
      'When NOT to use task_agent:\n' +
      '- Specific file path → use read_file directly.\n' +
      '- Named class/function ("class Foo") → use grep_search directly.\n' +
      '- Code within 2-3 known files → use read_file.\n' +
      '- Trivial one-shot questions answerable from one tool call.\n\n' +
      'Usage notes:\n' +
      '- Always include a short `label` (3-5 words) summarizing the task.\n' +
      '- Launch multiple agents concurrently when possible — single assistant message with multiple task_agent tool_calls.\n' +
      '- The agent\'s result is NOT visible to the user; after it returns, write a text summary so the user sees the findings.\n' +
      '- Each invocation starts with fresh context — provide a complete task description (file paths, scope, what to return).\n' +
      '- Tell the agent whether you expect code-writing or research-only — it is not aware of the user\'s intent.\n' +
      '- If the user says run agents "in parallel", you MUST send one message with multiple task_agent tool_calls.\n' +
      '- For background fire-and-forget when you have parent-side work to do, use delegate_agent instead and call wait_agent when the result is needed.\n\n' +
      'Writing the prompt: brief the child like a smart colleague who just walked in. Explain what you\'re accomplishing and why, what you\'ve already learned or ruled out, enough context for judgment calls. Include file paths and line numbers. **Never delegate understanding** — don\'t write "based on your findings, fix the bug"; that pushes synthesis onto the child. Terse command-style prompts produce shallow generic work.\n\n' +
      '**Trust but verify:** a child\'s returned summary describes what it INTENDED to do, not necessarily what it actually did. When a child writes or edits code, read the actual changes (git diff, read_file) before reporting work as done.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'One of: explorer, architect, reviewer, worker, verifier. Prefer agentId for custom definitions.' },
        agentId: { type: 'string', description: 'Registry id of the agent definition. Takes precedence over role when both are provided.' },
        prompt: { type: 'string', description: 'The bounded task prompt for the child agent.' },
        label: { type: 'string', description: 'Optional short label for the child run.' },
        access: { type: 'string', enum: ['read', 'write', 'shell'], description: 'Override the role default access mode. Default: role default.' },
        timeoutMs: { type: 'integer', description: 'Optional parent wait timeout in milliseconds. 0 or omitted waits until completion; timeout returns an envelope and leaves the child running.' },
        workdir: { type: 'string', description: 'Optional workspace-relative child launch directory. Must exist; invalid values fall back to the parent CWD.' },
        seedRecordIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional BrainRouter memory record IDs that the parent already recalled.',
        },
        stageId: {
          type: 'string',
          description: 'Optional role-stage id from the active profile strategy. When present, the runtime owns the role, objective, skills, output contract, and ceilings; prompt is only a bounded assignment.',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh'],
          description: 'Reasoning effort for this child (default: inherits the session /effort). Raise it for design, adversarial review, or subtle debugging; lower it for mechanical edits. Ignored when stageId is set — the runtime owns a stage child\'s ceilings.',
        },
      },
      required: ['prompt'],
    },
  };
}

export function createDelegateAgentTool() {
  return {
    name: 'delegate_agent',
    description:
      'Start one background child agent and keep working in the parent turn. ' +
      'Non-blocking — there is no `timeoutMs`; the child runs until it finishes or is cancelled. ' +
      'Returns a running child id plus a reminder to continue useful work; call wait_agent later when the result is needed.\n\n' +
      'When to choose delegate_agent over task_agent: when you have genuinely independent parent-side work to fill the time (read other files, write a different section, run a benchmark) while the child runs. If you would just sit idle waiting, use task_agent instead — it returns the result directly.\n\n' +
      'Writing the prompt: same standard as task_agent — brief the child like a smart colleague who just walked in. Explain what you\'re accomplishing and why, what you\'ve already learned, enough context for judgment calls. Include file paths and line numbers. Never write "based on your findings, X" — write what to change, where. Terse prompts produce shallow work.\n\n' +
      '**Trust but verify after wait_agent:** the child\'s returned summary describes intent, not necessarily what landed on disk. If the child wrote or edited code, read the actual changes (git diff / read_file) before reporting the work as done to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'One of: explorer, architect, reviewer, worker, verifier. Prefer agentId for custom definitions.' },
        agentId: { type: 'string', description: 'Registry id of the agent definition. Takes precedence over role when both are provided.' },
        prompt: { type: 'string', description: 'The bounded task prompt for the child agent.' },
        label: { type: 'string', description: 'Optional short label for the child run.' },
        access: { type: 'string', enum: ['read', 'write', 'shell'], description: 'Override the role default access mode. Default: role default.' },
        workdir: { type: 'string', description: 'Optional workspace-relative child launch directory. Must exist; invalid values fall back to the parent CWD.' },
        seedRecordIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional BrainRouter memory record IDs that the parent already recalled.',
        },
        stageId: {
          type: 'string',
          description: 'Optional role-stage id from the active profile strategy. When present, the runtime owns the role, objective, skills, output contract, and ceilings; prompt is only a bounded assignment.',
        },
      },
      required: ['prompt'],
    },
  };
}

export function createListAgentsTool() {
  return {
    name: 'list_agents',
    description: 'List all child agent sessions for the current workspace with status, role, and elapsed time.',
    inputSchema: { type: 'object', properties: {} },
  };
}

export function createWaitAgentTool() {
  return {
    name: 'wait_agent',
    description: 'Wait for a child agent to complete. Returns final output, error, or timeout state.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Child agent id returned by spawn_agent.' },
        timeoutMs: { type: 'integer', description: 'Maximum wait time in ms. Default 120000. Use 0 to wait until completion.' },
      },
      required: ['id'],
    },
  };
}

export function createReadAgentTranscriptTool() {
  return {
    name: 'read_agent_transcript',
    description: 'Read recent transcript entries (default 40) of a child agent session.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Child agent id.' },
        limit: { type: 'integer', description: 'Max entries to return. Default 40.' },
      },
      required: ['id'],
    },
  };
}

export function createCloseAgentTool() {
  return {
    name: 'close_agent',
    description: 'Mark a child agent session closed without deleting its transcript. Use this for cleanup.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Child agent id.' } },
      required: ['id'],
    },
  };
}

export function createSendInputTool() {
  return {
    name: 'send_input',
    description: 'Send a follow-up message to an existing child agent session, reusing its transcript. Blocks for one resumed child turn and returns the new output.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Child agent id returned by spawn_agent, task_agent, delegate_agent, or spawn_agents.' },
        message: { type: 'string', description: 'Follow-up message to append to the child agent transcript.' },
        interrupt: { type: 'boolean', description: 'If true and the child is currently running, request an interrupt before sending this message. Default false.' },
      },
      required: ['id', 'message'],
    },
  };
}

export function createResumeAgentTool() {
  return {
    name: 'resume_agent',
    description: 'Resume a previously closed, failed, stale, or completed child agent for one more turn. Optionally provide a message; otherwise asks it to continue from its transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Child agent id to resume.' },
        message: { type: 'string', description: 'Optional resume prompt. Defaults to a concise continue-from-transcript request.' },
      },
      required: ['id'],
    },
  };
}

export function createSpawnAgentsTool() {
  return {
    name: 'spawn_agents',
    description:
      'Spawn several child agents in parallel with ONE tool call, and the primary way to work at high effort on a broad task. Returns all child ids immediately; drain with `wait_agents`, then synthesize.\n\n' +
      'What makes a fan-out worth its cost — all four, not just the first:\n' +
      `1. **≥3 children, each on a DISTINCT named lens.** Give every child a \`label\` naming its lens and tell it to ignore findings outside that lens. Review lenses: ${reviewLenses().join(' / ')}. Investigation lenses: ${investigationLenses().join(' / ')}. Three children asking the SAME question in three folders is breadth of path, not of thinking — it costs 3x and returns one angle.\n` +
      `2. **One adversarial child.** Its brief: ${adversarialLens()}. Its output is answered, not merged — a conclusion nobody tried to break is an opinion.\n` +
      '3. **Write/shell children declare `ownership`.** Parallel writers without a glob would clobber each other, so the batch is rejected before any child starts. Read-only lenses need none.\n' +
      '4. **You synthesize.** Merge the lens findings into one answer and state explicitly what the adversary failed to break. Do not hand the user a list of child ids, and do not defer ("I\'ll summarize once they finish") — you are the last step.\n\n' +
      'Raise `effort` on children doing design, adversarial review, or subtle debugging. For a task whose phases feed forward (plan → implement → verify → review) prefer `run_workflow` — the runtime sequences and synthesizes it for you.',
    inputSchema: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'explorer | architect | reviewer | worker | verifier (omit to auto-route from the prompt).' },
              prompt: { type: 'string', description: 'Bounded task prompt for this child, including the lens it must stay inside.' },
              label: { type: 'string', description: 'Short label naming THIS child\'s distinct lens. Children sharing a label are not a fan-out.' },
              access: { type: 'string', enum: ['read', 'write', 'shell'] },
              workdir: { type: 'string' },
              seedRecordIds: { type: 'array', items: { type: 'string' } },
              ownership: { type: 'string', description: 'File glob this child may write within (e.g. "src/payments/**"). Required for write/shell access unless allowOverlap is set. Enforced on write_file / edit_file / apply_patch.' },
              allowOverlap: { type: 'boolean', description: 'Opt out of the ownership requirement for this entry (writes are then unbounded). Default false.' },
              effort: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'xhigh'],
                description: 'Reasoning effort for this child (default: inherits the session /effort). Raise it for the adversarial and design children.',
              },
            },
            required: ['prompt'],
          },
        },
      },
      required: ['agents'],
    },
  };
}

export function createWaitAgentsTool() {
  return {
    name: 'wait_agents',
    description:
      'Wait for multiple child agents in parallel. Returns each child\'s final status / output / error. ' +
      'Use after spawn_agents to drain the whole batch before synthesizing.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        timeoutMs: { type: 'integer', description: 'Maximum total wait. Default 240000. Use 0 to wait until all children complete.' },
      },
      required: ['ids'],
    },
  };
}

/**
 * WF-TOOL (0.4.8) — `run_workflow`. One call hands the runtime a declarative
 * multi-phase plan; the runtime fans out, barrier-waits, synthesizes, and feeds
 * each phase forward deterministically (the agent does NOT orchestrate
 * spawn/wait/synthesize itself).
 */
export function createRunWorkflowTool() {
  return {
    name: 'run_workflow',
    description:
      'Run a deterministic multi-phase workflow in ONE call — the highest-effort orchestration primitive, and the one to reach for when phases feed forward. Hand over a declarative plan; the runtime fans out a child agent per phase entry, waits for the WHOLE phase, synthesizes it, then feeds that into the next phase — you do not orchestrate spawn/wait/synthesize yourself. Use for "review each of these → summarize", "compare A vs B vs C → recommend", multi-stage research, or a full build loop. Each phase has EITHER an explicit `agents` list OR a `fanOut` over targets (one clone per target, {{target}} substituted). A later phase consumes an earlier one via `inputFrom` (its synthesis replaces {{input}}).\n\n' +
      `The built-in \`build\` template is the adversarial shape in full: plan → implement on an isolated worktree → verify against the real \`git diff\` (not the worker's self-report) → review fanned out over ${reviewLenses().length} independent lenses (${reviewLenses().join(' / ')}) merged by role-rollup. \`investigate\` is its read-only twin: ${investigationLenses().length} lenses in parallel → architect synthesis → one adversary briefed to break that synthesis.`,
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Optional run slug (defaults from the plan title).' },
        background: { type: 'boolean', description: 'Run detached so the turn is not blocked by a long fan-out; track via /workflows or the background panel. Default false.' },
        resume: { type: 'string', description: 'Resume an interrupted run by slug — skips already-completed phases (their output feeds {{input}}) and re-runs from the failed one. Provide instead of plan/template.' },
        template: { type: 'string', enum: ['compare', 'review-wide', 'research', 'build', 'investigate'], description: 'Built-in workflow shape — pass this + templateArgs INSTEAD of an explicit plan. compare {targets[],criteria?,goal?} · review-wide {paths[],focus?} · research {question,angles?} · build {task, slices?[]} (the plan→implement→verify→review build loop on isolated worktrees) · investigate {question, lenses?[]} (read-only multi-lens investigation → synthesis → adversarial challenge).' },
        templateArgs: { type: 'object', description: 'Arguments for the chosen template, e.g. { targets: ["optionA","optionB"] } or { paths: ["src/a","src/b"] }.' },
        plan: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            phases: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Unique phase id.' },
                  title: { type: 'string' },
                  agents: {
                    type: 'array',
                    description: 'Explicit, heterogeneous agents. Mutually exclusive with fanOut.',
                    items: {
                      type: 'object',
                      properties: {
                        role: { type: 'string', description: 'explorer|architect|reviewer|worker|verifier (omit to auto-route).' },
                        prompt: { type: 'string' },
                        access: { type: 'string', enum: ['read', 'write', 'shell'] },
                      },
                      required: ['prompt'],
                    },
                  },
                  fanOut: {
                    type: 'object',
                    description: 'Spawn one clone of `agent` per `over` target ({{target}} substituted). Mutually exclusive with agents.',
                    properties: {
                      over: { type: 'array', items: { type: 'string' }, minItems: 1 },
                      agent: {
                        type: 'object',
                        properties: {
                          role: { type: 'string' },
                          prompt: { type: 'string', description: 'May contain {{target}}.' },
                          access: { type: 'string', enum: ['read', 'write', 'shell'] },
                        },
                        required: ['prompt'],
                      },
                    },
                    required: ['over', 'agent'],
                  },
                  inputFrom: { type: 'array', items: { type: 'string' }, description: 'Prior phase id(s); their synthesis is injected as {{input}}.' },
                  synthesize: { type: 'string', enum: ['role-rollup', 'review-merge', 'none'], description: 'How to aggregate this phase (default none).' },
                  dependsOn: { type: 'array', items: { type: 'string' }, description: 'Phase id(s) that must finish first (default: declaration order).' },
                },
                required: ['id'],
              },
            },
          },
          required: ['phases'],
        },
      },
      // Provide EITHER `plan` (explicit) OR `template`+`templateArgs`.
      required: [],
    },
  };
}

export function createRunWorkflowGraphTool() {
  return {
    name: 'run_workflow_graph',
    description:
      'Run a saved VISUAL workflow graph (built on the Workflows canvas) by id, in ONE call. The runtime executes the graph node-by-node — AI Agent nodes run as real child agents, Condition/Switch/Filter/Sort/Limit/Aggregate/Loop wire the dataflow, and Sub-workflow nodes call other saved graphs — then returns the graph\'s final output. Use this to invoke a reusable automation the user designed visually, instead of re-orchestrating it by hand. Distinct from `run_workflow` (which takes an inline declarative phase-plan); this one loads a named, saved graph.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The saved workflow-graph id or name (as shown in the Workflows canvas / workflow list).' },
        vars: { type: 'object', description: 'Optional run variables, merged over the graph\'s own defaults and available to nodes as {{$vars.*}}.' },
      },
      required: ['id'],
    },
  };
}

/**
 * MAS-P2-M2 — `route_task` tool. Returns a typed 4-tier policy
 * decision (answer-direct / direct-tool / spawn-inline / spawn-worker)
 * with the recommended tool, agent id (when inline), confidence, and
 * memory evidence (MAS-P2-M4).
 */
export function createRouteTaskTool() {
  return {
    name: 'route_task',
    description:
      'Direct-first delegation dry-run. Returns `{ tier, reason, recommendedTool, agentId, confidence, memoryEvidence }`. Six tiers, cheapest first: ' +
      '`answer-direct` (no tool — reply in prose) · ' +
      '`direct-tool` (one concrete tool answers — e.g. `read_file`, `grep_search`, `run_command`) · ' +
      '`spawn-inline` (one specialized child via `delegate_<id>`) · ' +
      '`fan-out` (separable breadth — several children on DISTINCT lenses in ONE `spawn_agents` call, then `wait_agents` and synthesize) · ' +
      '`workflow` (a dependency chain — hand the whole thing to `run_workflow`, which fans out, waits, synthesizes and feeds each phase forward for you; `reason` names the template to pass) · ' +
      // The tier is named; the tool is not. Background workers are a separate
      // catalog group a workspace may not have enabled, and this description is
      // static while the tool list is not. `recommendedTool` in the RESULT is
      // gated on what this turn can emit, so that is where the name belongs.
      '`spawn-worker` (long-running detached work that outlives the turn). ' +
      'Call this BEFORE spawning to pick the right tier: it stops trivial reads from becoming children, AND stops genuinely broad work from being answered by one child.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task prompt the parent is considering routing.' },
      },
      required: ['task'],
    },
  };
}
