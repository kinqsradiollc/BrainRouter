/**
 * ADR-032 D7 — where a session's content CAME FROM, recorded at the tool call.
 *
 * D7's clause 2 says a lesson may not be derived solely from untrusted content,
 * and it names the sources first: "a PDF, a fetched page, a mirrored issue
 * title, a synced note". The first implementation scored that from three fence
 * tags, which meant the highest-volume untrusted channel — `fetch_url`,
 * `web_search`, a browser page — was invisible, because those tools return bare
 * JSON with no fence. A hostile page could therefore mint a lesson that arrives
 * in every future session as a `role: 'system'` message. Provenance is scored
 * from the SOURCE instead: the tool that produced the content is the one fact
 * about it a document cannot argue with.
 *
 * The second half of the same defect is the corroboration input. Counting "did
 * this turn make a tool call" made the read of the hostile document corroborate
 * the hostile document. So a trusted action only counts when it happens AFTER an
 * untrusted read — ordering is the whole point, and it is why this is a running
 * tally on the agent rather than a property of one message.
 *
 * Deliberate boundary: the workspace is NOT untrusted here. `read_file` and
 * `grep_search` return the person's own project, which BrainRouter already gates
 * behind workspace trust; scoring every file read as attacker-influenced would
 * make the gate fire on nearly every session and the store would learn nothing,
 * which ADR-029 F1 rates worse than the noise D2 exists to prevent.
 *
 * Pure classification + one small mutator, so the rules are testable without an
 * agent, a model, or a network.
 */

import { redactText } from '../../session/transcript/sessionStore.js';

/** What one tool call tells us about the content it produced. */
export type ToolProvenance =
  /** Content authored outside the workspace and outside the person. */
  | 'untrusted-read'
  /** Something the agent or the person DID, whose outcome can corroborate. */
  | 'trusted-action'
  /** Neither: a workspace read, a memory lookup, a planner query. */
  | 'neutral';

/**
 * Tools that return content somebody else wrote.
 *
 * `connector_run` is the synced-note / mirrored-issue channel; `mcp_call` and
 * `read_mcp_resource` reach a third-party server; the rest are the network.
 */
const UNTRUSTED_SOURCE_TOOLS = new Set([
  'fetch_url',
  'web_search',
  'list_sitemap',
  'research_brief',
  'connector_run',
  'mcp_call',
  'mcp_search',
  'mcp_describe',
  'read_mcp_resource',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'computer_use',
]);

/**
 * Anything driving a page is reading one. Matched by prefix on purpose: the
 * browser surface grows, and a new `browser_*` tool that defaulted to "trusted"
 * would reopen this hole silently — the failure mode this module exists to end.
 */
const UNTRUSTED_TOOL_PREFIXES = ['browser_'];

/** Our own brain is not a third party; its tools are memory, not content. */
const TRUSTED_MCP_SERVER_PREFIX = 'mcp_brainrouter_';

/**
 * Actions whose OUTCOME is evidence: a command that ran, a file that changed, a
 * person who answered. A read is never in this set — reading more of what the
 * attacker wrote is not corroboration of what the attacker wrote.
 */
const TRUSTED_ACTION_TOOLS = new Set([
  'run_command',
  'terminal_write',
  'write_file',
  'edit_file',
  'apply_patch',
  'notebook_edit',
  'ask_user_choice',
]);

/** Classify one tool by name. Unknown tools are neutral, never corroborating. */
export function classifyToolProvenance(toolName: string): ToolProvenance {
  const name = String(toolName ?? '').trim().toLowerCase();
  if (!name) return 'neutral';
  if (UNTRUSTED_SOURCE_TOOLS.has(name)) return 'untrusted-read';
  if (UNTRUSTED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'untrusted-read';
  // A tool dispatched to some other MCP server returns that server's content.
  if (name.startsWith('mcp_') && !name.startsWith(TRUSTED_MCP_SERVER_PREFIX)) return 'untrusted-read';
  if (TRUSTED_ACTION_TOOLS.has(name)) return 'trusted-action';
  return 'neutral';
}

/** The running tally a session keeps. Session-scoped: a checkpoint reflects on
 *  the whole session, so a per-turn counter would forget the read that matters. */
export interface SessionProvenance {
  untrustedReads: number;
  trustedActions: number;
  /** Trusted actions taken after the first untrusted read — D7's real input. */
  trustedActionsAfterUntrusted: number;
  /** Monotonic model/tool batch. Calls in one parallel batch cannot
   * corroborate one another because neither could have observed the other. */
  currentBatch: number;
  lastSuccessfulUntrustedBatch?: number;
  successfulActions: CorroboratingAction[];
}

export interface CorroboratingAction {
  readonly id: string;
  readonly toolName: string;
  readonly batch: number;
  readonly summary?: string;
}

function boundedActionSummary(summary: string | undefined, args: unknown): string | undefined {
  let serializedArgs = '';
  try {
    serializedArgs = JSON.stringify(args ?? {}, (key, value) => (
      /(?:authorization|cookie|password|passwd|secret|token|api.?key|private.?key)/i.test(key)
        ? '[REDACTED]'
        : value
    ));
  } catch { /* an unserialisable argument contributes no semantic authority */ }
  const combined = [summary?.trim(), serializedArgs].filter(Boolean).join(' | ');
  return combined ? redactText(combined).slice(0, 400) : undefined;
}

export function emptySessionProvenance(): SessionProvenance {
  return {
    untrustedReads: 0,
    trustedActions: 0,
    trustedActionsAfterUntrusted: 0,
    currentBatch: 0,
    successfulActions: [],
  };
}

export function beginToolProvenanceBatch(provenance: SessionProvenance): number {
  provenance.currentBatch += 1;
  return provenance.currentBatch;
}

export function eligibleCorroboratingActions(
  provenance: SessionProvenance,
): CorroboratingAction[] {
  const readBatch = provenance.lastSuccessfulUntrustedBatch;
  if (readBatch === undefined) return [];
  return provenance.successfulActions.filter((action) => action.batch > readBatch).slice(-32);
}

/** Record a completed tool call. Failed, denied and skipped attempts are never
 * evidence. `batch` makes a parallel read/action batch ineligible. */
export function noteToolProvenance(
  provenance: SessionProvenance,
  toolName: string,
  result?: { success: boolean; batch?: number; callId?: string; summary?: string; args?: unknown },
): void {
  // Compatibility for direct callers: each completed call without an explicit
  // batch is a new sequential batch. Runtime callers always pass the real one.
  const batch = result?.batch ?? beginToolProvenanceBatch(provenance);
  if (result && !result.success) return;
  switch (classifyToolProvenance(toolName)) {
    case 'untrusted-read':
      provenance.untrustedReads += 1;
      provenance.lastSuccessfulUntrustedBatch = batch;
      return;
    case 'trusted-action':
      provenance.trustedActions += 1;
      if (
        provenance.lastSuccessfulUntrustedBatch !== undefined
        && batch > provenance.lastSuccessfulUntrustedBatch
      ) {
        provenance.trustedActionsAfterUntrusted += 1;
      }
      const summary = boundedActionSummary(result?.summary, result?.args);
      provenance.successfulActions.push({
        id: (result?.callId?.trim() || `action-${batch}-${provenance.trustedActions}`).slice(0, 160),
        toolName: toolName.slice(0, 80),
        batch,
        ...(summary ? { summary } : {}),
      });
      if (provenance.successfulActions.length > 64) {
        provenance.successfulActions = provenance.successfulActions.slice(-64);
      }
      return;
    default:
      return;
  }
}
