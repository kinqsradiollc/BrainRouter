/**
 * POLISH-1 (0.4.13) — the key under which the REPL pairs a tool's start row with its
 * end row (to render `Read(foo.ts)` + its result + duration as one block).
 *
 * Prefer the LLM `tool_call` id so parallel SAME-NAME calls (e.g. two `Read`s at once)
 * don't collide on a name-keyed map — the bug where the second call's args overwrote
 * the first, so both results rendered under the last call's header. Fall back to the
 * tool name when a provider omits ids (sequential / single calls pair fine either way).
 * Pure.
 */
export function toolPairKey(name: string, callId?: string | null): string {
  return callId && callId.length > 0 ? callId : name;
}
