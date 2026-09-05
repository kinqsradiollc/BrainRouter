/**
 * ADR-050 P1 — pick a session implementation for a transport.
 *
 * In P1 only the one-shot fallback exists; the structured transports
 * (`claude-stream-json`, `codex-app-server`, `acp-stdio`) register their cases
 * here in P2. An unknown or not-yet-built transport degrades to one-shot rather
 * than throwing — the decision to REQUIRE a structured transport belongs at the
 * call site (which knows whether a fallback is acceptable), not here.
 */
import { OneShotStdioSession } from './oneShotSession.js';
import { ClaudeStreamJsonSession } from './claudeStreamJson.js';
import { CodexAppServerSession } from './codexAppServer.js';
import { AcpStdioSession } from './acpStdio.js';
import type {
  AgentSessionDeps,
  AgentSessionPort,
  AgentSessionSpec,
  AgentSessionTransport,
} from './types.js';

export function createAgentSession(
  transport: AgentSessionTransport,
  spec: AgentSessionSpec,
  deps: AgentSessionDeps = {},
): AgentSessionPort {
  switch (transport) {
    case 'claude-stream-json':
      return new ClaudeStreamJsonSession(spec, deps);
    case 'codex-app-server':
      return new CodexAppServerSession(spec, deps);
    case 'acp-stdio':
      return new AcpStdioSession(spec, deps);
    case 'stdio-oneshot':
    default:
      return new OneShotStdioSession(spec, deps);
  }
}
