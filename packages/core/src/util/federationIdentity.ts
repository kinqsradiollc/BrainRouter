/**
 * Federation identity injection for agent-initiated tool calls (0.4.1 fix).
 *
 * The CLI registers + polls its inbox under a per-process *federation*
 * session key (a stable per-launch UUID — distinct from the agent's
 * *chat* sessionKey, which is resolved via `memory_resolve_session` and
 * rotates on `/new`). The two-key split is deliberate: it's what keeps
 * two CLIs in the same workspace from colliding in `/agents --remote`.
 *
 * But the LLM only sees the chat key in its system prompt, so when an
 * agent calls `session_inbox_read` / `session_send` itself it passes the
 * WRONG key and reads an empty inbox (the message landed under the
 * federation key — that's why the banner showed but the read came back
 * empty). Rather than ask the model to juggle two keys, we rewrite the
 * identity fields at the tool-call boundary:
 *
 *   - `session_inbox_read` / `session_inbox_ack` → force `sessionKey` to
 *     the federation key. An agent only ever reads/acks its OWN inbox;
 *     it has no business addressing another session's mail.
 *   - `session_send` → force `from` to the federation key so recipients
 *     see the identity that appears in `/agents --remote`. `to` is left
 *     exactly as the agent specified.
 *
 * Pure + side-effect free so it unit-tests without a live brain.
 */

const FED_READ_TOOLS = ["session_inbox_read", "session_inbox_ack", "session_delegations"];
const FED_SEND_TOOLS = ["session_send", "session_delegate_task"];

/**
 * The MCP pool may normalise a tool name to `mcp_<server>_<tool>`, so
 * match the bare name OR any `_<base>` suffix.
 */
function matches(name: string, base: string): boolean {
  return name === base || name.endsWith(`_${base}`);
}

/**
 * Returns args with the federation identity injected for federation
 * tools; returns the original args unchanged for everything else (or
 * when federation isn't attached, i.e. `federationKey` is null/empty).
 */
export function applyFederationIdentity(
  name: string,
  args: unknown,
  federationKey: string | null | undefined,
): unknown {
  if (!federationKey) return args;
  const base = (args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {}) as Record<
    string,
    unknown
  >;

  if (FED_READ_TOOLS.some((t) => matches(name, t))) {
    base.sessionKey = federationKey;
    return base;
  }
  if (FED_SEND_TOOLS.some((t) => matches(name, t))) {
    base.from = federationKey;
    return base;
  }
  return args;
}
