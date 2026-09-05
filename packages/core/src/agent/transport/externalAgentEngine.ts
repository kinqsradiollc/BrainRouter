/**
 * ADR-047 D2 (P2) — agents as engines: drive the MAIN loop with an installed
 * coding-agent CLI instead of an HTTP model.
 *
 * Two ways an engine model resolves to a command:
 *  1. A KNOWN adapter — claude-code / codex / opencode / gemini-cli — from the
 *     `AGENT_ADAPTERS` catalog, auto-detected on PATH. The model id is the
 *     adapter id, and its `engineArgs` are the agent's HEADLESS (one-shot)
 *     invocation. No hand-config.
 *  2. A user-declared `cli.agents.hosted[]` entry (any custom agent CLI).
 *
 * ADR-050 P1 — the engine now drives the ONE `AgentSessionPort` seam rather than
 * spawning directly. It uses the `stdio-oneshot` transport, which is
 * byte-identical to the pre-ADR-050 behaviour (spawn the CLI, deliver the
 * flattened prompt on stdin or a `{prompt}` arg, collect ALL of stdout until the
 * process exits, EPIPE-/abort-safe). P2 selects a structured transport from the
 * agent's declared session protocol so the same call streams instead.
 *
 * Honest scope (ADR-047 D2): with the one-shot transport the external agent runs
 * its OWN tools in its own process; an engine turn is a terminal answer, and the
 * router never fails over to or from it (a subscription seat is never silently
 * swapped for an API bill). Structured transports (P2/P4) make the turn
 * incremental and its tool activity visible, without changing that guarantee.
 */
import type { LLMConfig } from '../../config/config.js';
import { getCliKnobs } from '../../config/config.js';
import { getAgentAdapter, findExecutable } from '../adapters/catalog.js';
import type { InteractionPort } from '@kinqs/brainrouter-agent-protocol';
import { createAgentSession } from '../session/factory.js';
import { bridgeInteractionToPermission } from '../session/permissionBridge.js';
import type { AgentSessionTransport, SessionPermissionMode } from '../session/types.js';
import type { EngineRunOptions } from '../session/oneShotSpawn.js';

/**
 * ADR-050 P4 — the session transport an engine model drives: the target's OWN
 * declared transport (a bring-your-own hosted agent) first, then the built-in
 * catalog adapter's, else the one-shot fallback. With live sessions off, always
 * one-shot (byte-identical to the pre-ADR-050 spawn).
 */
export function resolveEngineTransport(
  name: string,
  liveSessions: boolean,
  declared?: AgentSessionTransport,
): AgentSessionTransport {
  if (!liveSessions) return 'stdio-oneshot';
  return declared ?? getAgentAdapter(name)?.sessionTransport ?? 'stdio-oneshot';
}
// ADR-050 P1 — the one-shot spawn primitive moved into the session module (which
// now owns it); re-exported here so existing importers/tests keep resolving them.
export {
  runExternalAgentTurn,
  extractEngineOutput,
  PROMPT_PLACEHOLDER,
  type EngineTarget,
  type EngineProtocol,
  type EngineRunOptions,
} from '../session/oneShotSpawn.js';
import type { EngineTarget } from '../session/oneShotSpawn.js';

/**
 * Resolve the engine target for a model id: a user-configured hosted agent
 * first, then a KNOWN adapter whose CLI is installed on PATH. Returns undefined
 * when neither matches (the caller turns that into a clear error).
 */
export function resolveEngineTarget(config: LLMConfig): EngineTarget | undefined {
  const name = (config.model || config.provider || '').trim();
  if (!name) return undefined;
  // ADR-050 D5 — a hosted entry is an INSTANCE: its `name` is the routing key
  // (the same binary may appear N times), and its `env` is that instance's
  // isolated home, so two seats of one CLI never share auth state.
  const hosted = getCliKnobs().agents.hosted.find((a) => a.name === name);
  if (hosted) {
    return {
      name: hosted.name,
      command: hosted.command,
      args: hosted.args,
      protocol: hosted.protocol,
      ...(hosted.env ? { env: hosted.env } : {}),
      // ADR-050 D2/P4 — a bring-your-own agent may declare a LIVE transport, so
      // live sessions are not limited to the built-in catalog.
      ...(hosted.transport ? { sessionTransport: hosted.transport } : {}),
      ...(hosted.transportArgs ? { sessionArgs: hosted.transportArgs } : {}),
    };
  }
  const adapter = getAgentAdapter(name);
  if (adapter?.engineArgs && findExecutable(adapter.command)) {
    return { name: adapter.id, command: adapter.command, args: [...adapter.engineArgs], protocol: 'stdio' };
  }
  return undefined;
}

/**
 * Flatten a chat-message array into a single prompt an external agent can read.
 * BrainRouter passes the FULL conversation each turn, so the agent sees the whole
 * context here rather than relying on its own cross-turn memory.
 */
export function flattenMessagesToPrompt(messages: readonly unknown[]): string {
  const lines: string[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as { role?: unknown; content?: unknown };
    const role = typeof m.role === 'string' ? m.role : 'user';
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : '')).join('')
        : m.content == null ? '' : JSON.stringify(m.content);
    if (content.trim()) lines.push(`${role.toUpperCase()}: ${content.trim()}`);
  }
  return lines.join('\n\n');
}

/** The transport-layer return shape shared with `callOpenAI` — an engine turn is a terminal answer. */
export interface EngineTurnResult {
  content: string;
  toolCalls: undefined;
  usage: undefined;
  finishReason: 'stop';
}

/**
 * The engine hand-off used by `callOpenAI` / `callOpenAIStream`. Resolves the
 * engine target, runs the turn, emits the whole answer as ONE stream delta (when
 * a streaming caller passed a handler), and returns the terminal result shape.
 */
export async function callExternalAgentEngine(
  config: LLMConfig,
  messages: readonly unknown[],
  options: EngineRunOptions & {
    onTextDelta?: (delta: string) => void;
    permissionMode?: SessionPermissionMode;
    interactionPort?: InteractionPort;
  } = {},
): Promise<EngineTurnResult> {
  const target = resolveEngineTarget(config);
  if (!target) {
    const name = (config.model || config.provider || '').trim();
    const adapter = getAgentAdapter(name);
    const hint = adapter?.engineArgs
      ? `"${name}" is a known agent but its CLI ('${adapter.command}') was not found on PATH — install it, or declare it under cli.agents.hosted[].`
      : `declare it under cli.agents.hosted[], or use a known agent id (claude-code, codex, opencode, gemini-cli).`;
    throw new Error(`engine model "${name}" is not available — ${hint}`);
  }
  // ADR-050 P4 — the engine drives the ONE session seam, selecting the target's
  // DECLARED transport when live sessions are enabled (opt-in) so a structured
  // session streams and narrates tool activity; otherwise the one-shot transport
  // is byte-identical to the pre-ADR-050 spawn. Precedence: a bring-your-own
  // hosted agent's own `sessionTransport`, then the built-in catalog adapter. A
  // structured transport builds its own args (claude/codex) or takes the
  // declared/catalog session args (ACP).
  const adapter = getAgentAdapter(target.name);
  const transport = resolveEngineTransport(target.name, getCliKnobs().agents.liveSessions ?? false, target.sessionTransport);
  const args = transport === 'stdio-oneshot' ? target.args : (target.sessionArgs ?? adapter?.sessionArgs ?? []);
  const session = createAgentSession(
    transport,
    {
      command: target.command,
      args,
      agentId: target.name,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      // ADR-050 D5 — the instance's isolated-home env reaches every transport
      // (one-shot and structured) through the session spec.
      ...(target.env ? { env: target.env } : {}),
    },
    { ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}) },
  );
  await session.open();
  let content = '';
  let error: string | undefined;
  // ADR-050 P3 — when the caller wires an InteractionPort, a live agent's
  // permission requests (a command it wants to run, an edit it wants to make)
  // surface as host confirms; without one, a structured transport default-denies
  // (fail-closed) and a one-shot transport never asks.
  const onPermission = options.interactionPort
    ? bridgeInteractionToPermission(options.interactionPort)
    : undefined;
  const turn = await session.prompt(flattenMessagesToPrompt(messages), {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(onPermission ? { onPermission } : {}),
    onEvent: (event) => {
      if (event.kind === 'text') {
        content += event.delta;
        if (event.delta && options.onTextDelta) options.onTextDelta(event.delta);
      } else if (event.kind === 'done' && event.error) {
        error = event.error;
      }
    },
  });
  await session.close();
  // A terminal engine turn preserves the failure: rethrow exactly what the
  // pre-ADR-050 path threw (the runner's message, or the abort message).
  if (turn.reason !== 'stop') throw new Error(error ?? `external agent turn ${turn.reason}`);
  return { content, toolCalls: undefined, usage: undefined, finishReason: 'stop' };
}
