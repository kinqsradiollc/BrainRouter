import { execSync } from 'node:child_process';
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';

/**
 * Lifecycle shell hooks. A hook is a shell command string that runs at a
 * specific agent-loop point (pre-tool, post-tool, stop). Non-zero exit codes
 * from `pre-tool` hooks can block the tool call ("approval gate"); other
 * events are informational.
 *
 * Persisted at <workspace>/.brainrouter/cli/hooks.json so they survive CLI
 * restarts and travel with the project.
 */

export type HookEvent =
  | 'pre-tool'    // Fired before a tool runs; non-zero exit OR a {"decision":"deny"} JSON denies the call.
  | 'post-tool'   // Fired after a tool returns; informational.
  | 'pre-turn'    // Fired before each LLM turn.
  | 'post-turn'   // Fired after the assistant's final message of a turn.
  | 'user-prompt-submit' // CC-P4.2 — fired on prompt submit; a deny decision blocks the turn.
  | 'pre-compact' // CC-P4.2 — fired before auto/manual compaction; advisory.
  | 'session-start'
  | 'session-end'
  // ---- CC-hooks parity (0.4.17) -----------------------------------------
  | 'message-display' // Fired with the assistant's about-to-display text; a hook may transform (updatedOutput) or hide (decision:"deny") it.
  | 'stop'            // Fired when the top-level agent finishes a turn; may return additionalContext injected into the next turn.
  | 'subagent-stop'   // Fired when a subagent/background worker finishes; may return additionalContext bubbled to the parent.
  | 'notification-agent-needs-input'   // Fired when a background/subagent blocks awaiting input — wire desktop/OS notifications.
  | 'notification-agent-completed';    // Fired on agent/background completion — wire desktop/OS notifications.

export interface Hook {
  id: string;
  event: HookEvent;
  command: string;
  match?: string; // Optional substring match on tool name (for pre-tool / post-tool).
  enabled: boolean;
  createdAt: string;
}

interface HooksFile {
  hooks: Hook[];
}

const EMPTY: HooksFile = { hooks: [] };

export function readHooks(workspaceRoot: string): Hook[] {
  return readJsonFile<HooksFile>(getStateFile(workspaceRoot, 'hooks.json'), EMPTY).hooks;
}

export function addHook(workspaceRoot: string, input: { event: HookEvent; command: string; match?: string }): Hook {
  const all = readHooks(workspaceRoot);
  const hook: Hook = {
    id: `hook_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    event: input.event,
    command: input.command,
    match: input.match,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  all.push(hook);
  writeJsonFile(getStateFile(workspaceRoot, 'hooks.json'), { hooks: all });
  return hook;
}

export function removeHook(workspaceRoot: string, id: string): boolean {
  const all = readHooks(workspaceRoot);
  const filtered = all.filter((h) => h.id !== id);
  if (filtered.length === all.length) return false;
  writeJsonFile(getStateFile(workspaceRoot, 'hooks.json'), { hooks: filtered });
  return true;
}

export function setHookEnabled(workspaceRoot: string, id: string, enabled: boolean): boolean {
  const all = readHooks(workspaceRoot);
  const target = all.find((h) => h.id === id);
  if (!target) return false;
  target.enabled = enabled;
  writeJsonFile(getStateFile(workspaceRoot, 'hooks.json'), { hooks: all });
  return true;
}

export interface HookRunResult {
  hook: Hook;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run all enabled hooks for the given event. The CLI uses synchronous spawning
 * with a hard timeout — hooks are meant for fast lifecycle taps (lint, notify,
 * log), not long-running work. A `pre-tool` hook returning non-zero blocks the
 * tool call; other events are advisory.
 */
export function runHooks(
  workspaceRoot: string,
  event: HookEvent,
  context: { tool?: string; payload?: Record<string, unknown> } = {},
  timeoutMs = 5000,
): HookRunResult[] {
  const results: HookRunResult[] = [];
  for (const hook of readHooks(workspaceRoot)) {
    if (!hook.enabled || hook.event !== event) continue;
    if (hook.match && context.tool && !hookMatchesTool(hook.match, context.tool)) continue;
    const env = {
      ...process.env,
      BRAINROUTER_HOOK_EVENT: event,
      BRAINROUTER_HOOK_TOOL: context.tool ?? '',
      BRAINROUTER_HOOK_PAYLOAD: context.payload ? JSON.stringify(context.payload) : '',
    };
    try {
      const stdout = execSync(hook.command, { env, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      results.push({ hook, exitCode: 0, stdout, stderr: '' });
    } catch (err: any) {
      results.push({
        hook,
        exitCode: typeof err.status === 'number' ? err.status : 1,
        stdout: typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString?.() ?? ''),
        stderr: typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString?.() ?? err.message ?? ''),
      });
    }
  }
  return results;
}

/**
 * CC-P4.2 — structured hook decision contract. A hook may print JSON on
 * stdout instead of relying on its exit code:
 *
 *   { "decision": "deny",  "reason": "touching prod config is forbidden" }
 *   { "decision": "allow", "reason": "pre-approved by policy bot" }
 *   { "decision": "allow", "updatedInput": { "command": "git status" } }
 *
 * `deny` blocks even with exit 0 (the reason reaches the model); `allow` can
 * downgrade an approval prompt; `updatedInput` REPLACES the tool arguments
 * (pre-tool only). Non-JSON stdout → null (legacy exit-code semantics). Pure.
 */
export interface HookDecision {
  decision?: 'allow' | 'deny';
  reason?: string;
  /** pre-tool: REPLACE the tool arguments before execution. */
  updatedInput?: Record<string, unknown>;
  /** user-prompt-submit: extra context appended to the prompt the model sees. */
  additionalContext?: string;
  /**
   * post-tool: REPLACE the tool result text the model receives (e.g. redact).
   * message-display: REPLACE the assistant text shown to the user (transform).
   */
  updatedOutput?: string;
  /** post-tool: mark the tool result an error (e.g. a lint/policy breach). */
  isError?: boolean;
  // ---- CC-hooks parity (0.4.17) -----------------------------------------
  /**
   * session-start: rename the session. The CLI/desktop applies this via
   * `setSessionMeta(ws, sessionKey, { title })` so the sidebar shows the
   * hook-chosen name instead of the first user message.
   */
  sessionTitle?: string;
  /**
   * session-start: `true` asks the host to rescan its skill roots
   * (`skills/` + `.brainrouter/skills`) — e.g. after a hook synced a fresh
   * skill pack onto disk. Advisory; a host with no skill cache just re-reads.
   */
  reloadSkills?: boolean;
}

export function parseHookDecision(stdout: string): HookDecision | null {
  const t = (stdout ?? '').trim();
  if (!t.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(t) as HookDecision;
    if (parsed && typeof parsed === 'object') {
      const ok =
        parsed.decision === 'allow' ||
        parsed.decision === 'deny' ||
        parsed.updatedInput !== undefined ||
        parsed.additionalContext !== undefined ||
        parsed.updatedOutput !== undefined ||
        parsed.isError !== undefined ||
        parsed.sessionTitle !== undefined ||
        parsed.reloadSkills !== undefined;
      return ok ? parsed : null;
    }
  } catch { /* non-JSON stdout — legacy semantics */ }
  return null;
}

/**
 * Match a hook's `match` pattern against a tool name. A pattern containing glob
 * metacharacters (`*` / `?`) is an ANCHORED glob (`read_*` → any `read_` tool,
 * `*_file` → `read_file`/`write_file`); any other pattern keeps the legacy
 * SUBSTRING behaviour (`list` → `list_dir`) so existing hooks are unchanged. An
 * empty pattern matches everything. Pure.
 */
export function hookMatchesTool(pattern: string, tool: string): boolean {
  if (!pattern) return true;
  if (/[*?]/.test(pattern)) {
    const rx = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return rx.test(tool);
  }
  return tool.includes(pattern);
}

// ---- CC-hooks parity (0.4.17) helpers ---------------------------------------

/** Outcome of running the `message-display` hooks over one assistant message. */
export interface MessageDisplayOutcome {
  /** The (possibly transformed) text to display; `''` when hidden. */
  text: string;
  /** `true` when a hook hid the message (`{"decision":"deny"}`). */
  hidden: boolean;
  /** `true` when a hook replaced the text (`{"updatedOutput":"…"}`). */
  transformed: boolean;
}

/**
 * Fold `message-display` hook stdout over the assistant's about-to-display text.
 * A `{"decision":"deny"}` HIDES the message (returns empty, `hidden:true`); a
 * `{"updatedOutput":"…"}` REPLACES it (last transform wins, chained). Non-JSON
 * or exit-only stdout is a no-op. Pure over `results` so it unit-tests without
 * spawning a shell. Deny short-circuits — a hidden message can't be transformed.
 */
export function applyMessageDisplayHooks(text: string, results: HookRunResult[]): MessageDisplayOutcome {
  let out = text;
  let transformed = false;
  for (const r of results) {
    const d = parseHookDecision(r.stdout);
    if (!d) continue;
    if (d.decision === 'deny') return { text: '', hidden: true, transformed };
    if (typeof d.updatedOutput === 'string') { out = d.updatedOutput; transformed = true; }
  }
  return { text: out, hidden: false, transformed };
}

/** Structured session-start directives folded from the hooks' stdout. */
export interface SessionStartDirectives {
  /** Rename the session (last non-empty `sessionTitle` wins). */
  sessionTitle?: string;
  /** Any hook asked for a skill rescan (`reloadSkills:true`). */
  reloadSkills: boolean;
  /** Extra context any hook injected (`additionalContext`), joined by newline. */
  additionalContext?: string;
}

/**
 * Fold `session-start` hook stdout into structured directives the host applies
 * (rename via setSessionMeta, rescan skill roots, inject startup context). Pure
 * over `results`. Later `sessionTitle` overrides earlier; `reloadSkills` is a
 * logical OR; `additionalContext` accumulates.
 */
export function parseSessionStartDirectives(results: HookRunResult[]): SessionStartDirectives {
  const out: SessionStartDirectives = { reloadSkills: false };
  const ctx: string[] = [];
  for (const r of results) {
    const d = parseHookDecision(r.stdout);
    if (!d) continue;
    if (typeof d.sessionTitle === 'string' && d.sessionTitle.trim()) out.sessionTitle = d.sessionTitle.trim();
    if (d.reloadSkills === true) out.reloadSkills = true;
    if (typeof d.additionalContext === 'string' && d.additionalContext.trim()) ctx.push(d.additionalContext.trim());
  }
  if (ctx.length > 0) out.additionalContext = ctx.join('\n');
  return out;
}

/**
 * Fold `additionalContext` out of `stop` / `subagent-stop` hook stdout — the
 * string a hook injects back into the model's context on the next turn (Stop)
 * or bubbles to the parent (SubagentStop). Pure over `results`; accumulates in
 * order, newline-joined; empty → `undefined`.
 */
export function collectStopAdditionalContext(results: HookRunResult[]): string | undefined {
  const ctx: string[] = [];
  for (const r of results) {
    const d = parseHookDecision(r.stdout);
    if (typeof d?.additionalContext === 'string' && d.additionalContext.trim()) ctx.push(d.additionalContext.trim());
  }
  return ctx.length > 0 ? ctx.join('\n') : undefined;
}

