import type { AccessMode } from '../registry/roles.js';

export const DELEGATE_TOOL_PREFIX = 'delegate_';

const ORCHESTRATION_TOOL_NAMES = new Set([
  'task_agent',
  'delegate_agent',
  'spawn_agent',
  'spawn_agents',
  'list_agents',
  'wait_agent',
  'wait_agents',
  'read_agent_transcript',
  'close_agent',
  'send_input',
  'resume_agent',
  'route_task',
  'run_workflow',
  'run_workflow_graph',
]);

export function isOrchestrationToolName(name: string): boolean {
  // MAS-P2-M1: any `delegate_<...>` (except the legacy generic
  // `delegate_agent` which is already in the set) routes through
  // the orchestration dispatcher as a synthesized delegate tool.
  if (name.startsWith(DELEGATE_TOOL_PREFIX) && name !== 'delegate_agent') {
    return true;
  }
  return ORCHESTRATION_TOOL_NAMES.has(name);
}

/**
 * MAS-P2-M1: per-turn synthesized `delegate_<agentId>` tools.
 *
 * Walks the active agent registry (built-ins + user + workspace) and
 * emits one tool per definition with description = the agent's
 * `whenToUse`. The synthesized tool routes through `handleTaskAgent`
 * (foreground `wait: true` spawn) — that's the high-discoverability
 * pattern the LLM picks naturally vs. choosing role names inside a
 * generic `spawn_agent({ role: '...' })`. The legacy `spawn_agent` /
 * `delegate_agent` stay as escape hatches for prompts the registry
 * doesn't cover.
 *
 * Per-turn (not cached): a workspace pack swap or a `/persona refresh`
 * changes the def set without restart, so the tool list reflects
 * the live registry on every assistant turn.
 *
 * Routes through `task_agent` semantics (foreground wait + structured
 * return), not background `delegate_agent`. The naming is a bit of a
 * lie historically — "delegate_*" in MAS-P2 actually means "send the
 * work over and get the answer back". That matches what the LLM
 * expects when it sees `delegate_reviewer`.
 */
export function synthesizeDelegateTools(
  loadedDefs: Array<{ def: { id: string; delegateName: string; whenToUse: string; defaultAccess?: AccessMode } }>,
): Array<{
  name: string;
  description: string;
  inputSchema: any;
  agentId: string;
}> {
  const tools: Array<{ name: string; description: string; inputSchema: any; agentId: string }> = [];
  const seen = new Set<string>();
  for (const loaded of loadedDefs) {
    const def = loaded.def;
    const name = def.delegateName || `delegate_${def.id}`;
    // Defensive: a workspace override that names two defs with the
    // same delegateName would otherwise stomp the model's tool list.
    // First-write-wins, but log so the operator notices.
    if (seen.has(name)) {
      console.error(`[BrainRouter] duplicate delegate tool name "${name}" — dropping the later definition.`);
      continue;
    }
    seen.add(name);
    tools.push({
      name,
      agentId: def.id,
      description:
        `Delegate this task to the typed \`${def.id}\` agent and wait for its structured output. ` +
        `${def.whenToUse} ` +
        `Use this in preference to spawn_agent({ role: '${def.id}' }) — the typed tool surface is what \`route_task\` recommends.`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The bounded task prompt for the child agent.' },
          label: { type: 'string', description: 'Optional short label for the child run.' },
          ownership: {
            type: 'string',
            description: 'Optional ownership constraint (file glob, module, or responsibility) — recorded on the parent-context snapshot.',
          },
          access: {
            type: 'string',
            enum: ['read', 'write', 'shell'],
            description: `Override the agent's default access mode (${def.defaultAccess ?? 'read'}).`,
          },
          timeoutMs: { type: 'integer', description: 'Optional parent wait timeout in ms. 0 or omitted waits until completion; timeout leaves the child running.' },
          workdir: { type: 'string', description: 'Optional workspace-relative child launch directory.' },
          seedRecordIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional BrainRouter memory record IDs the parent already recalled.',
          },
        },
        required: ['prompt'],
      },
    });
  }
  return tools;
}

/**
 * Match a synthesized delegate tool name to its underlying agent id.
 * Returns `null` for plain `delegate_agent` (the legacy generic tool)
 * so the existing dispatch path keeps working.
 */
export function resolveDelegateAgentId(
  name: string,
  loadedDefs: Array<{ def: { id: string; delegateName: string } }>,
): string | null {
  if (name === 'delegate_agent') return null;
  for (const loaded of loadedDefs) {
    if (loaded.def.delegateName === name) return loaded.def.id;
  }
  // Fallback: prefix-strip and check the registry by id directly.
  if (name.startsWith(DELEGATE_TOOL_PREFIX)) {
    const id = name.slice(DELEGATE_TOOL_PREFIX.length);
    if (loadedDefs.some((l) => l.def.id === id)) return id;
  }
  return null;
}
