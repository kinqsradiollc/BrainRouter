// Child-agent observation helpers — split out of agent.ts (god-file breakdown).
// Byte-identical moves: JSON parsing, child-id collection, spawn/wait tracking,
// child-drain timeout formatting, and waited-child output summarization. Pure
// functions consumed by the Agent turn loop.
import { getCliKnobs } from '../../config/config.js';

export function parseJsonObject(text: string): any | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectChildIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const ids: string[] = [];
  const maybeRecord = value as Record<string, unknown>;
  if (typeof maybeRecord.id === 'string') ids.push(maybeRecord.id);
  if (Array.isArray(maybeRecord.agents)) {
    for (const entry of maybeRecord.agents) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string') {
        ids.push((entry as Record<string, unknown>).id as string);
      }
    }
  }
  return [...new Set(ids)];
}

export function trackChildObservation(
  toolName: string,
  args: any,
  resultText: string,
  spawned: Set<string>,
  waited: Set<string>,
): void {
  if (
    toolName === 'spawn_agent' ||
    toolName === 'spawn_agents' ||
    toolName === 'task_agent' ||
    toolName === 'delegate_agent'
  ) {
    const ids = collectChildIds(parseJsonObject(resultText));
    for (const id of ids) {
      spawned.add(id);
      // task_agent always blocks internally (wraps spawn with wait: true);
      // spawn_agent({ wait: true }) is the legacy form. Both count as
      // already-observed, so the child-drain guardrail doesn't double-wait.
      // delegate_agent is fire-and-forget — must remain unwaited so the
      // guardrail can force a wait_agents call before the parent answers.
      if (toolName === 'task_agent') waited.add(id);
      else if (toolName === 'spawn_agent' && args?.wait) waited.add(id);
    }
    return;
  }

  if (toolName === 'wait_agent') {
    const id = typeof args?.id === 'string' ? args.id : undefined;
    if (id) waited.add(id);
    return;
  }

  if (toolName === 'wait_agents') {
    const ids = Array.isArray(args?.ids) ? args.ids.filter((id: unknown): id is string => typeof id === 'string') : [];
    for (const id of ids) waited.add(id);
  }
}

export function parseChildDrainTimeouts(resultText: string): Array<{ id: string; role?: string; status: string; childStatus?: string; summary?: string }> {
  const parsed = parseJsonObject(resultText);
  const agents: unknown[] = Array.isArray(parsed?.agents) ? parsed.agents : [];
  return agents
    .filter((entry: unknown): entry is Record<string, unknown> => {
      return !!entry && typeof entry === 'object' && (entry as Record<string, unknown>).status === 'timeout';
    })
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '(unknown)',
      role: typeof entry.role === 'string' ? entry.role : undefined,
      status: 'timeout',
      childStatus: typeof entry.childStatus === 'string' ? entry.childStatus : undefined,
      summary: typeof entry.summary === 'string' ? entry.summary : undefined,
    }));
}

export function formatChildDrainTimeoutAnswer(timeouts: Array<{ id: string; role?: string; childStatus?: string; summary?: string }>): string {
  const lines = [
    `Children still running after the bounded wait (${timeouts.length}):`,
    ...timeouts.map((child) => {
      const role = child.role ? ` role=${child.role}` : '';
      const status = child.childStatus ? ` status=${child.childStatus}` : '';
      const summary = child.summary ? ` — ${child.summary}` : '';
      return `- ${child.id}${role}${status}${summary}`;
    }),
    '',
    'Use `/continue` to drain the pending child output and synthesize the result when it is ready.',
  ];
  return lines.join('\n');
}

export function summarizeWaitedChildOutputs(resultText: string): string | undefined {
  const parsed = parseJsonObject(resultText);
  if (!parsed) return undefined;
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [parsed];
  const sections: string[] = [];
  for (const entry of agents) {
    if (!entry || typeof entry !== 'object') continue;
    const child = entry as Record<string, unknown>;
    const id = typeof child.id === 'string' ? child.id : undefined;
    const status = typeof child.status === 'string' ? child.status : undefined;
    const role = typeof child.role === 'string' ? child.role : undefined;
    const output = typeof child.finalOutput === 'string'
      ? child.finalOutput
      : (typeof child.error === 'string' ? `ERROR: ${child.error}` : undefined);
    if (!id || !output) continue;
    sections.push([
      `Child ${id}${role ? ` (${role})` : ''} ${status ? `[${status}]` : ''}`,
      output,
    ].join('\n'));
  }
  if (sections.length === 0) return undefined;
  const body = sections.join('\n\n---\n\n');
  const maxChars = getCliKnobs().childResultSystemChars;
  const clamped = body.length > maxChars
    ? `${body.slice(0, maxChars)}\n...[truncated ${body.length - maxChars} chars; use read_agent_transcript or /agent show <id> for full output]`
    : body;
  return [
    '<system-reminder id="child-results">',
    'Recently waited child-agent outputs are available below. Synthesize these results directly; do not ignore them or continue as if the children are still running.',
    '',
    clamped,
    '</system-reminder>',
  ].join('\n');
}
