// Internal implementation port for required core capability extensions.
// Public/user/workspace extensions never receive this runtime object.
import fs from 'node:fs';
// ADR-041 D8 — the builtin-tool handler registry. Importing the barrel runs each
// migrated tool's registration side effect; `builtinToolHandler` is consulted at
// the top of the switch so a migrated tool dispatches by lookup, not a case.
import { builtinToolHandler } from './handlers/index.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { NoTTYError } from '../../agent/support/prompter.js';
import { getCliKnobs, isRemoteBrainUrl } from '../../config/config.js';
import { formatWorkspaceRef, parseWorkspaceRef } from '../../workspace/references/index.js';
import {
  buildLocalWorkspaceRegistry, fenceWorkspaceResolutions, linkWorkspaceRef, localWorkspaceViewer,
} from '../../workspace/participants/index.js';

// Per-turn computer_use action cap — module const in the original agent.ts; kept
// here because the internal capability runtime is its only consumer.
const MAX_COMPUTER_ACTIONS_PER_TURN = 20;
import {
  runConnectorCheckpointCore, exportConnectorDocumentsForMemory,
  githubTokenClient, defaultEnvTokenResolver,
  type McpConnectorClient, type McpConnectorResource,
} from '../../connectors/index.js';
import { startBackgroundShell } from '../../exec/runtime/backgroundShell.js';
import { buildRunCommandPrompt, isDangerousCommand, resolveRunCommandApproval } from '../../exec/guard/dangerousCommand.js';
import { evaluateDestructiveCommand } from '../../exec/guard/destructiveCommandGuard.js';
import { evaluatePermissionRules, primaryArgText } from '../../exec/policy/permissionRules.js';
import { decideExecutionPolicy, egressDecision } from '../../exec/policy/execPolicy.js';
import { resolveSandboxConfig, runShell } from '../../exec/runtime/sandbox.js';
import { resolvePentestSandbox, runPentestCommand } from '../../review/pentestSandbox.js';
import { buildPentestDedupeMessages, findingKey, parsePentestDedupeDecision } from '../../review/reviewSynthesis.js';
import { callOpenAI } from '../../agent/transport/llmTransport.js';
import { enforceTaskBudget } from '../../provider/budget.js';
import { recordDenial } from '../../exec/runtime/recentDenials.js';
import { gitHeadSha } from '../../git/workspaceGit.js';
import { readGoal } from '../../goal/store/goalStore.js';
import { extractToolText } from '../../mcp/mcpUtils.js';
import { ownershipWriteViolation } from '../../orchestration/ownership/ownership.js';
import { spawnWorkerThread } from '../../orchestration/agents/workerTools.js';
import { readPreferences } from '../../session/preferences/preferencesStore.js';
import { resolveActiveMode } from '../../session/state/sessionModeStore.js';
import { isTelemetryEnabled } from '../../telemetry/recorder/telemetry.js';
import { parseTrackQuery } from '../../track/query/index.js';
import {
  ensureProject as trackEnsureProject,
  getProject as trackGetProject,
  listWorkItems as trackListWorkItems,
  getWorkItem as trackGetWorkItem,
  createWorkItem as trackCreateWorkItem,
  transitionWorkItem as trackTransitionWorkItem,
  updateWorkItem as trackUpdateWorkItem,
  addComment as trackAddComment,
  linkWorkItem as trackLinkWorkItem,
  createSprint as trackCreateSprint,
  listSprints as trackListSprints,
  setSprintState as trackSetSprintState,
  updateSprint as trackUpdateSprint,
  sprintVelocity as trackSprintVelocity,
} from '../../track/trackStore.js';
import { recordDailyUsage } from '../../usage/usageHistoryStore.js';
import { applyFederationIdentity } from '../../util/agentloop/federationIdentity.js';
import { runPostEditCheck } from '../../util/agentloop/postEditCheck.js';
import { estimateTokens as estimateTokensContentAware } from '../../util/tokens/tokenEstimate.js';
import { fetchAndExtract } from '../../websearch/crawler.js';
import { buildSearchProvider } from '../../websearch/factory.js';
import { parseGoogleHtml, googleSearchUrl } from '../../websearch/providers/google.js';
import type { WebSearchResult } from '../../websearch/types.js';
import { canSpawnWorker } from '../../worker/workerStore.js';
import { getLatestReview, saveReview } from '../../review/reviewStore.js';
import { redactReviewSourceText, assertSafeReviewerFilesystemPath } from '../../review/sourceSafety.js';
import { validatePentestFinding } from '../../review/pentestFinding.js';
import { applyPatchEnvelope, assessPatchSafety, parsePatchEnvelope } from '../../agent/fs/applyPatch.js';
import { applyNotebookEdit } from '../../agent/fs/notebookEdit.js';
import { evaluateDestructiveAction, isComputerActionMutating, validateComputerAction } from '../../agent/fs/computerUse.js';
import { nestArguments } from '../../agent/repair/flatten.js';
import { shrinkOversizedToolResults } from '../../agent/guards/turnEndShrink.js';
import { resolveWorkspacePath, resolveWorkspacePathInScope, singleRootScope } from '../../agent/fs/workspaceFs.js';
import { nodeFilesystemPort, type FilesystemPort } from '../../agent/fs/filesystemPort.js';
import type { SubprocessPort } from '../../agent/subprocess/subprocessPort.js';
import type { ShellPort } from '../../agent/shell/shellPort.js';

// ADR-041 D3 — default subprocess port: wraps `spawnWorkerThread` verbatim, so
// the local worker-spawn path is byte-identical. An execution world (D10) injects
// a port that spawns the worker in a container/remote.
const nodeSubprocessPort: SubprocessPort = { spawnWorker: spawnWorkerThread };

// ADR-041 D3 — default shell port: wraps runShell / startBackgroundShell verbatim,
// so the local exec path is byte-identical. An execution world (D10) injects a
// port that runs the command in a container/remote.
const nodeShellPort: ShellPort = { runShell, startBackgroundShell };
import { listWorktreesStructured, resolveAttachableWorktree } from '../../worktree/concurrentWorktrees.js';
import { createNamedWorktree, removeWorktreeAt } from '../../worktree/isolation/worktreeIsolation.impl.js';
import { liveForeignOwner, recordWorktreeOwner, clearWorktreeOwner } from '../../worktree/ownership/worktreeOwnership.js';
import { isWorkItemType, isWorkItemPriority } from '@kinqs/brainrouter-types';

/** Minimal shape of the per-Agent browser-control port (a bridge to the desktop
 *  WebContentsView). Typed loosely so the runtime pulls in no desktop imports. */
interface BrowserFetchPort { request(command: unknown, options?: { signal?: AbortSignal }): Promise<{ ok?: boolean; tabId?: string; data?: unknown }> }

/** True when a URL clearly points at STRUCTURED data (a JSON/XML/CSV/feed or an
 *  API endpoint) rather than a rendered web page. Those must NOT go through the
 *  browser — Chromium renders the response into a DOM view and innerText scraping
 *  mangles it; the HTTP crawler returns the bytes near-verbatim (parseable). */
export function looksStructuredUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.toLowerCase();
    if (/\.(json|xml|csv|tsv|txt|rss|atom|ndjson|yaml|yml)$/.test(path)) return true;
    if (path.includes('/api/') || path.startsWith('/api') || path.includes('/v1/') || path.includes('/v2/')) return true;
    if (/^(api|data|feeds?)\./i.test(u.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * How the agent's `web_search` / `fetch_url` fast-path drives the in-app browser.
 *
 * When `live` is set, the fetch is made WATCHABLE: it opens (or reuses via
 * `tabRef`) a single VISIBLE research tab, activates it, and LEAVES it open so
 * the user sees the agent navigate to the URL / search / page forward — one tab
 * moving page→page rather than throwaway tabs flashing open and closed. Without
 * `live` (the default) it keeps the original silent behavior: a NON-active
 * background tab that is always closed after the read.
 */
export interface InAppBrowseOptions {
  live?: boolean;
  /** Mutable holder for the reused research tab id, shared across an agent's
   *  web_search / fetch_url calls so the user watches ONE tab, not many. */
  tabRef?: { id?: string };
}

/**
 * Open a browse tab, or — in `live` mode with a known `tabRef.id` — reuse and
 * navigate the existing research tab (and re-activate it) so the user watches a
 * single tab move. Returns the tab id, or undefined if a fresh tab won't open.
 */
async function openOrReuseBrowseTab(port: BrowserFetchPort, url: string, signal: AbortSignal, opts: InAppBrowseOptions): Promise<string | undefined> {
  const live = opts.live === true;
  const ref = opts.tabRef;
  if (live && ref?.id) {
    const nav = await port.request({ kind: 'page.navigate', url, tabId: ref.id }, { signal }).catch(() => null);
    if (nav?.ok) {
      // Bring the reused research tab to the front so the user watches it move.
      await port.request({ kind: 'tabs.select', tabId: ref.id }, { signal }).catch(() => undefined);
      return ref.id;
    }
    ref.id = undefined; // stale/closed — fall through and open a fresh visible tab
  }
  const open = await port.request({ kind: 'tabs.open', url, activate: live }, { signal });
  if (!open?.ok || !open.tabId) return undefined;
  if (live && ref) ref.id = open.tabId;
  return open.tabId;
}

/**
 * Fetch a URL through the in-app browser (real Chromium, JS-rendered, using the
 * user's logged-in session), returning the page's rendered text — the SAME view
 * the agent gets from the browser tools. In `live` mode it drives a VISIBLE,
 * reused research tab the user can watch; otherwise a NON-active background tab
 * that is always closed after the read.
 *
 * Best-effort by design: a hard timeout bounds the whole flow and ANY failure
 * returns null so the caller falls back to the HTTP crawler — fetch_url can
 * never be made worse than the crawler baseline. SSRF is enforced by the desktop
 * browser's own onBeforeRequest destination gate, so no extra check is needed.
 */
export async function fetchViaInAppBrowser(port: BrowserFetchPort, url: string, timeoutMs: number, outerSignal?: AbortSignal, opts: InAppBrowseOptions = {}): Promise<{ title: string; url: string; text: string } | null> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  const live = opts.live === true;
  let tabId: string | undefined;
  try {
    tabId = await openOrReuseBrowseTab(port, url, signal, opts);
    if (!tabId) return null;
    // Wait for load, but ignore its timeout — we still read whatever rendered.
    await port.request({ kind: 'page.wait', tabId, loadState: 'load', timeoutMs: Math.min(15_000, timeoutMs) }, { signal }).catch(() => undefined);
    // page.text returns the page's clean rendered innerText (article text, not the
    // structural agent snapshot). Fall back to the semantic snapshot's node text
    // if page.text is somehow empty, and to the crawler (return null) if both are.
    const textRes = await port.request({ kind: 'page.text', tabId, maxChars: 100_000 }, { signal }).catch(() => null);
    const td = (textRes?.ok ? textRes.data : null) as { url?: string; title?: string; text?: string } | null;
    let title = String(td?.title ?? '');
    let finalUrl = String(td?.url ?? url);
    let text = String(td?.text ?? '').replace(/\n{3,}/g, '\n\n').slice(0, 60_000).trim();
    if (!text) {
      const snap = await port.request({ kind: 'page.snapshot', tabId, maxChars: 50_000 }, { signal }).catch(() => null);
      const sd = (snap?.ok ? snap.data : null) as { url?: string; title?: string; nodes?: Array<{ name?: unknown; value?: unknown }> } | null;
      const nodes = Array.isArray(sd?.nodes) ? sd!.nodes : [];
      text = nodes.map((n) => String(n?.name ?? n?.value ?? '').trim()).filter(Boolean).join('\n').slice(0, 40_000);
      if (sd?.title) title = String(sd.title);
      if (sd?.url) finalUrl = String(sd.url);
    }
    return text ? { title, url: finalUrl, text } : null;
  } catch {
    return null;
  } finally {
    // Live mode keeps the reused research tab open (the user is watching it;
    // reapAgentTabs cleans it up between turns). Headless mode always closes.
    if (tabId && !live) { try { await port.request({ kind: 'tabs.close', tabId }); } catch { /* best effort */ } }
  }
}

/**
 * Fetch a page's RENDERED HTML through the in-app browser (real Chromium + the
 * user's session), so structured extraction (e.g. web_search parsing a results
 * page) runs over what the browser actually rendered — the network/JS/session
 * all go through the browser, never a raw HTTP scrape. In `live` mode it drives
 * a VISIBLE, reused research tab (so the user watches the search happen);
 * otherwise a background tab that is always closed. Returns null on any failure.
 */
export async function fetchHtmlViaInAppBrowser(port: BrowserFetchPort, url: string, timeoutMs: number, outerSignal?: AbortSignal, opts: InAppBrowseOptions = {}): Promise<string | null> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  const live = opts.live === true;
  let tabId: string | undefined;
  try {
    tabId = await openOrReuseBrowseTab(port, url, signal, opts);
    if (!tabId) return null;
    await port.request({ kind: 'page.wait', tabId, loadState: 'load', timeoutMs: Math.min(15_000, timeoutMs) }, { signal }).catch(() => undefined);
    const res = await port.request({ kind: 'page.html', tabId, maxChars: 500_000 }, { signal }).catch(() => null);
    const data = (res?.ok ? res.data : null) as { html?: string } | null;
    const html = String(data?.html ?? '');
    return html.length > 100 ? html : null;
  } catch {
    return null;
  } finally {
    // Live mode leaves the reused research tab open for the user to watch.
    if (tabId && !live) { try { await port.request({ kind: 'tabs.close', tabId }); } catch { /* best effort */ } }
  }
}

/** Reviewer reads never follow aliases: policy is evaluated on lexical and canonical paths. */

export async function invokeBuiltinToolRuntime(
  this: any,
  name: string,
  args: Record<string, any>,
  authorizeMcpTarget?: (
    name: string,
    args: Record<string, unknown>,
    descriptor: unknown,
  ) => void,
): Promise<string> {
    // Bind path resolution to this agent's workspace, never to process.cwd().
    // The Agent might have been constructed with a workspace different from
    // the launching shell's cwd (e.g. /resume from another dir), and cwd can
    // drift in unexpected ways. Explicit beats implicit here.
    const resolveHere = (p: string, opts: { forWrite?: boolean } = {}) =>
      resolveWorkspacePathInScope(
        // `this` is the Agent; its scope carries any entered worktrees (ADR-042
        // D1). Falls back to a single-root scope for any non-Agent caller.
        this.workspaceScope ?? singleRootScope(this.workspaceRoot),
        p,
        opts,
      );
    // ADR-042 D6 — a write into a worktree owned by a live foreign session is
    // refused with the owner named, BEFORE resolveHere (edit/notebook resolve
    // for read, so the escape guard alone would not catch them).
    const readOnlyGuard = (p: string) => {
      const owner = typeof this.readOnlyWorktreeOwner === 'function' ? this.readOnlyWorktreeOwner(p) : null;
      if (owner) {
        throw new Error(`Cannot write ${p}: it is in a worktree owned by session ${owner} (attached read-only). Coordinate with them, or re-enter it with override once they are done.`);
      }
    };
    // ADR-041 D3 — filesystem side effects go through the injected capability
    // port (default `nodeFilesystemPort` = the previous inline `node:fs`), so an
    // execution world (D10) can back them with container/remote I/O.
    const fsPort: FilesystemPort = this.filesystemPort ?? nodeFilesystemPort;
    // ADR-041 D8 — strangler dispatch: a migrated tool resolves to a registered
    // handler and returns here; everything else falls through to the switch below
    // unchanged. As tools migrate, the switch shrinks one case at a time.
    const migratedHandler = builtinToolHandler(name);
    if (migratedHandler) {
      return migratedHandler({
        args,
        invokedName: name,
        host: this,
        resolveHere,
        readOnlyGuard,
        fsPort,
        authorizeMcpTarget,
      });
    }
    switch (name) {
      // ADR-042 D3 — worktrees the agent can enter. `worktree_list` is the
      // structured, agent-facing inventory; `worktree_enter` attaches a listed
      // same-repo worktree (D2 derivation) so its files resolve. Non-destructive
      // and reversible — unlike `/cd`, it widens scope without moving the anchor.
      case 'worktree_enter': {
        if (this.reviewSourceSafety) {
          throw new Error('worktree_enter is disabled while reviewing untrusted source.');
        }
        const target = typeof args.target === 'string' ? args.target
          : typeof args.path === 'string' ? args.path
          : typeof args.branch === 'string' ? args.branch
          : '';
        const res = resolveAttachableWorktree(this.workspaceRoot, target);
        if (!res.ok) throw new Error(res.reason);
        // ADR-042 D6 — if a LIVE foreign session owns this worktree, attach it
        // read-only (writes refused, owner named) unless the user overrides.
        const override = args.override === true || args.force === true;
        const foreignOwner = !override && this.sessionKey
          ? liveForeignOwner(this.workspaceRoot, res.info.path, this.sessionKey)
          : null;
        if (foreignOwner && typeof this.attachReadOnlyWorktree === 'function') {
          this.attachReadOnlyWorktree(res.info.path, foreignOwner);
          return JSON.stringify({
            entered: res.info.path,
            branch: res.info.branch,
            readOnly: true,
            owner: foreignOwner,
            note: `Attached READ-ONLY — session ${foreignOwner} is working in this worktree. You can read it; writes are refused. Pass override:true to take it read/write anyway.`,
          });
        }
        if (typeof this.attachWorktree === 'function') this.attachWorktree(res.info.path);
        if (this.sessionKey) { try { recordWorktreeOwner(this.workspaceRoot, res.info.path, this.sessionKey); } catch { /* best-effort */ } }
        return JSON.stringify({
          entered: res.info.path,
          branch: res.info.branch,
          detached: res.info.detached || undefined,
          note: 'Attached for this repository — files under this worktree now resolve for read and edit. The exec default cwd still points at the primary root; pass an explicit cwd to run commands there.',
        });
      }
      case 'worktree_create': {
        if (this.reviewSourceSafety) {
          throw new Error('worktree_create is disabled while reviewing untrusted source.');
        }
        const branch = typeof args.branch === 'string' ? args.branch
          : typeof args.name === 'string' ? args.name : '';
        const fromRef = typeof args.from === 'string' && args.from.trim() ? args.from.trim() : 'HEAD';
        const created = createNamedWorktree(this.workspaceRoot, branch, fromRef);
        if ('error' in created) throw new Error(created.error);
        if (typeof this.attachWorktree === 'function') this.attachWorktree(created.worktreeRoot);
        if (this.sessionKey) { try { recordWorktreeOwner(this.workspaceRoot, created.worktreeRoot, this.sessionKey); } catch { /* best-effort */ } }
        return JSON.stringify({
          created: created.worktreeRoot,
          branch: created.branch,
          from: fromRef,
          attached: true,
          note: 'A new worktree on this branch, attached for read and edit. Run commands there by passing cwd to run_command; finish with worktree_done once the work is committed or merged.',
        });
      }
      case 'worktree_done': {
        const target = typeof args.path === 'string' ? args.path
          : typeof args.target === 'string' ? args.target : '';
        if (!target.trim()) {
          throw new Error('worktree_done requires a worktree path or branch. Run worktree_list to see them.');
        }
        const list = listWorktreesStructured(this.workspaceRoot, undefined, { withDirty: true });
        const asPath = path.isAbsolute(target) ? path.resolve(target) : path.resolve(this.workspaceRoot, target);
        const match = list.find((w) => path.resolve(w.path) === asPath) ?? list.find((w) => w.branch === target.trim());
        if (!match) {
          throw new Error(`No git worktree of this repository matches "${target}". Run worktree_list.`);
        }
        if (match.isSelf) {
          throw new Error(`"${target}" is the current workspace root — worktree_done cannot remove it.`);
        }
        const force = args.force === true;
        // Uncommitted work is preserved by default: surface it and stop, unless
        // the caller explicitly forces (which discards it).
        if (match.dirty && !force) {
          return JSON.stringify({
            removed: false,
            path: match.path,
            branch: match.branch,
            reason: 'This worktree has uncommitted changes. Commit or push them first, or call worktree_done with force:true to discard them.',
          });
        }
        // Route the removal through the SAME destructive-command guard as a
        // hand-typed `git worktree remove` (worktree-remove rule): the user's
        // intent authorizes it, otherwise a silent agent is refused and an
        // attended one is asked.
        const verdict = evaluateDestructiveCommand(`git worktree remove ${match.path}`, {
          userIntent: this.lastUserPrompt,
          headSha: gitHeadSha(this.workspaceRoot),
          agentAuthoredCommits: this.agentAuthoredCommits,
        });
        if (verdict.decision === 'block') {
          if (this.silent || (!this.interactionPort && !this.prompter)) {
            return JSON.stringify({ removed: false, path: match.path, reason: `${verdict.rule}: ${verdict.reason}` });
          }
          const approved = this.interactionPort
            ? await this.interactionPort.confirm({ title: 'Remove worktree?', detail: `${match.path}\n\n${verdict.reason}`, dangerous: true, tool: 'worktree_done' })
            : await this.prompter.askYesNo(`${verdict.reason}\nRemove it? (y/N) `, false);
          if (!approved) return JSON.stringify({ removed: false, path: match.path, reason: 'Removal declined.' });
        }
        const removed = removeWorktreeAt(this.workspaceRoot, match.path, { force });
        if (!removed.ok) throw new Error(removed.error ?? 'git worktree remove failed.');
        if (typeof this.detachWorktree === 'function') this.detachWorktree(match.path);
        try { clearWorktreeOwner(this.workspaceRoot, match.path); } catch { /* best-effort */ }
        return JSON.stringify({ removed: true, path: match.path, branch: match.branch });
      }
      // ADR-029 C3 — the same verbs the UI calls, over the same registry.
      case 'workspace_resolve': {
        const registry = buildLocalWorkspaceRegistry({ workspaceRoot: this.workspaceRoot });
        const viewer = localWorkspaceViewer({ workspaceRoot: this.workspaceRoot });
        const resolution = await registry.resolveUri(String(args.uri ?? ''), viewer);
        // C4 — fenced and neutralised before it is a tool result. Any mode is a
        // delivery vector for every other, so the boundary is drawn where the
        // content enters the turn rather than where it was written.
        return fenceWorkspaceResolutions([resolution]) ?? 'Nothing to show for that reference.';
      }
      case 'workspace_create': {
        const title = String(args.title ?? '').trim();
        if (!title) throw new Error('A title is required.');
        const registry = buildLocalWorkspaceRegistry({ workspaceRoot: this.workspaceRoot });
        const viewer = localWorkspaceViewer({ workspaceRoot: this.workspaceRoot });
        const from = typeof args.from === 'string' ? parseWorkspaceRef(args.from) : null;
        // A malformed `from` is refused rather than dropped: the caller asked
        // for the new record to remember where it came from, and silently
        // creating one that does not is the quietly-wrong outcome A3 rules out.
        if (from && !from.ok) throw new Error(`"from" is not a reference: ${from.detail}`);
        const outcome = await registry.create(
          {
            mode: String(args.mode ?? ''),
            kind: String(args.kind ?? ''),
            title,
            ...(from?.ok ? { from: from.ref } : {}),
            // ADR-029 Part E — the fields a created record arrives WITH. A
            // database row created without its cells needs a second call to
            // become what was asked for, and the window between the two is a row
            // whose every column is empty.
            ...(args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
              ? { fields: args.fields as Record<string, unknown> }
              : {}),
          },
          viewer,
        );
        if (outcome.status === 'refused') throw new Error(outcome.detail);
        return JSON.stringify({ status: outcome.status, uri: formatWorkspaceRef(outcome.ref) });
      }
      case 'workspace_update': {
        const target = parseWorkspaceRef(args.uri);
        if (!target.ok) throw new Error(`"uri" is not a reference: ${target.detail}`);
        const registry = buildLocalWorkspaceRegistry({ workspaceRoot: this.workspaceRoot });
        const viewer = localWorkspaceViewer({ workspaceRoot: this.workspaceRoot });
        const outcome = await registry.update(
          {
            ref: target.ref,
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            ...(args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
              ? { fields: args.fields as Record<string, unknown> }
              : {}),
          },
          viewer,
        );
        if (outcome.status === 'refused') throw new Error(outcome.detail);
        return JSON.stringify({
          status: outcome.status,
          uri: formatWorkspaceRef(outcome.ref),
          changed: outcome.changed,
          // Returned rather than dropped: a caller told only about the four
          // fields that worked concludes the fifth did too, and finds out a long
          // way from here.
          ...(outcome.ignored?.length ? { ignored: outcome.ignored } : {}),
          ...(outcome.label ? { label: outcome.label } : {}),
        });
      }
      case 'workspace_link': {
        const from = parseWorkspaceRef(args.from);
        const to = parseWorkspaceRef(args.to);
        if (!from.ok) throw new Error(`"from" is not a reference: ${from.detail}`);
        if (!to.ok) throw new Error(`"to" is not a reference: ${to.detail}`);
        const outcome = linkWorkspaceRef({ workspaceRoot: this.workspaceRoot }, from.ref, to.ref);
        if (!outcome.ok) throw new Error(outcome.detail);
        return JSON.stringify({
          from: formatWorkspaceRef(outcome.from),
          to: formatWorkspaceRef(outcome.to),
          alreadyLinked: outcome.alreadyLinked,
        });
      }
      case 'notebook_edit': {
        readOnlyGuard(args.path);
        const resolved = resolveHere(args.path);
        const ownErr = ownershipWriteViolation(this.ownership, this.workspaceRoot, resolved);
        if (ownErr) throw new Error(ownErr);
        if (!/\.ipynb$/i.test(resolved)) throw new Error('notebook_edit targets a .ipynb (Jupyter notebook) file.');
        if (!(await fsPort.exists(resolved))) throw new Error(`Notebook not found: ${args.path}`);
        const editMode = args.edit_mode === 'insert' || args.edit_mode === 'delete' ? args.edit_mode : 'replace';
        const cellIndex = args.cell_index === undefined || args.cell_index === null ? undefined : Number(args.cell_index);
        const cellType = args.cell_type === 'markdown' ? 'markdown' : args.cell_type === 'code' ? 'code' : undefined;
        const parentDenial = await this.confirmSilentChildToolApproval({
          tool: 'notebook_edit', path: String(args.path ?? ''),
          summary: `${editMode} cell ${cellIndex ?? '(append)'}`,
          reason: 'silent child agent requested a notebook edit',
        });
        if (parentDenial) return parentDenial;
        this.assertInheritedExecutionAuthorityCurrent();
        this.captureFileSnapshot(resolved); // undo log for /rewind --files
        const result = applyNotebookEdit(await fsPort.readFile(resolved), { editMode, cellIndex, cellType, source: String(args.source ?? '') });
        await fsPort.writeFile(resolved, result.content);
        this.filesReadThisSession.add(resolved);
        return JSON.stringify({ path: args.path, edit_mode: editMode, cells: result.cells });
      }
      case 'edit_file': {
        readOnlyGuard(args.path);
        const resolved = resolveHere(args.path);
        const ownErr = ownershipWriteViolation(this.ownership, this.workspaceRoot, resolved);
        if (ownErr) throw new Error(ownErr);
        if (!(await fsPort.exists(resolved))) {
          throw new Error(`File not found: ${args.path}`);
        }
        // CC-P6.4 — read-before-edit. Editing a file the agent hasn't read this
        // session risks clobbering content it can't see (stale assumptions,
        // mismatched indentation). Require a read_file first.
        if (!this.filesReadThisSession.has(resolved)) {
          throw new Error(`Read-before-edit: you must read_file("${args.path}") before editing it — you have not read this file this session. Read it first, then edit with targetContent that matches the current contents.`);
        }
        const content = await fsPort.readFile(resolved);
        const target = args.targetContent;
        const replacement = args.replacementContent;

        const occurrences = content.split(target).length - 1;
        if (occurrences === 0) {
          throw new Error(`Target content not found in ${args.path}. Ensure targetContent matches exact indentation and newlines.`);
        }
        if (occurrences > 1) {
          throw new Error(`Target content found ${occurrences} times in ${args.path}. Specify more surrounding context to target uniquely.`);
        }

        // Use a replacer FUNCTION so `replacement` is inserted verbatim. A string
        // second arg makes String.replace interpret `$&`, `$1`, `$$`, `` $` ``, `$'`
        // as special patterns, silently corrupting any edit whose replacement text
        // contains a `$` (regex source, shell vars, template literals, prices…).
        const updated = content.replace(target, () => replacement);
        const parentDenial = await this.confirmSilentChildToolApproval({
          tool: 'edit_file',
          path: String(args.path ?? ''),
          summary: `replace ${String(target ?? '').length} chars with ${String(replacement ?? '').length} chars`,
          reason: 'silent child agent requested a file edit',
        });
        if (parentDenial) return parentDenial;
        this.assertInheritedExecutionAuthorityCurrent();
        this.captureFileSnapshot(resolved); // 0.4.x-3b — undo log for /rewind --files
        await fsPort.writeFile(resolved, updated);
        const editNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: resolved, cwd: this.workspaceRoot });
        const editReindex = await this.maybeReindexSource(resolved, updated);
        return `Successfully edited ${args.path}` + editNotice + editReindex;
      }
      case 'run_command': {
        const cmd = args.command;
        // ADR-042 D4 — an optional validated `cwd`. The default stays the
        // workspace root (the pin that stopped a drifted process.cwd() writing
        // into ~/.brainrouter); a passed cwd is validated against the workspace
        // SCOPE (primary + entered worktrees) and rejected with the same escape
        // error otherwise. It is a validated override, never an unpin.
        let cwdOverride: string | undefined;
        if (typeof args.cwd === 'string' && args.cwd.trim() !== '') {
          cwdOverride = this.workspaceScope
            ? resolveWorkspacePathInScope(this.workspaceScope, args.cwd)
            : resolveWorkspacePath(this.workspaceRoot, args.cwd);
          if (!fs.existsSync(cwdOverride) || !fs.statSync(cwdOverride).isDirectory()) {
            throw new Error(`run_command cwd is not a directory: ${args.cwd}`);
          }
        }
        const effectiveCwd = cwdOverride ?? this.workspaceRoot;
        // CLI-11 — route the shell gate through the unified execution policy
        // (same outcome as the previous `accessMode !== 'shell'` check).
        const shellPolicy = decideExecutionPolicy('shell', this.accessMode);
        if (shellPolicy.decision === 'deny') {
          return `Command execution denied: ${shellPolicy.reason}.`;
        }
        // WS5 — destructive-command guard: BLOCK git/IaC actions the user didn't
        // ask for (reset --hard / checkout -- / clean -f / stash drop, an --amend
        // of a commit we didn't author this session, or an IaC destroy without the
        // stack named). Attended users can override via a confirm; silent/headless
        // agents are refused outright (they can't answer a prompt).
        let destructiveOverride = false;
        {
          const verdict = evaluateDestructiveCommand(cmd, {
            userIntent: this.lastUserPrompt,
            headSha: gitHeadSha(this.workspaceRoot),
            agentAuthoredCommits: this.agentAuthoredCommits,
          });
          if (verdict.decision === 'block') {
            // CC-SAFETY-B2 — the destructive-command guard's reason flows into the
            // session's recent-denials ring (best-effort) so `/recent-denials` can
            // surface WHY the command was blocked.
            const recordBlocked = () => {
              try { recordDenial(this.workspaceRoot, this.sessionKey, 'run_command', `${verdict.rule}: ${verdict.reason}`); } catch { /* best-effort */ }
            };
            if (this.silent || (!this.interactionPort && !this.prompter)) {
              recordBlocked();
              return `Command blocked (${verdict.rule}): ${verdict.reason}`;
            }
            const approved = this.interactionPort
              ? await this.interactionPort.confirm({ title: 'Run destructive command?', detail: `${cmd}\n\n${verdict.reason}`, dangerous: true, tool: 'run_command' })
              : await this.prompter.askYesNo(`${verdict.reason}\nRun it anyway? (y/N) `, false);
            if (!approved) { recordBlocked(); return `Command blocked (${verdict.rule}): ${verdict.reason}`; }
            destructiveOverride = true; // user explicitly authorized — skip the redundant approval below
          }
        }
        // Approval gating routes through the pure resolver in
        // runtime/dangerousCommand.ts. Three outcomes:
        //   • auto-approve: fast mode + safe command (or silent child whose
        //     parent has opted in via fast mode).
        //   • ask: planning mode, OR fast mode but the command matched the
        //     dangerous heuristic (rm -rf, sudo, force-push, …).
        //   • deny-silent: silent child agents can't answer y/N, so safe
        //     commands need parent opt-in (fast mode) and dangerous commands
        //     are always denied.
        const prefs = readPreferences(this.workspaceRoot);
        // Gate from the ACTIVE SESSION's executionMode (session override >
        // workspace pref) so two chats in the same workspace can sit in
        // different modes — a `fast` chat auto-approves safe commands while a
        // `planning` chat still confirms.
        const baseMode = resolveActiveMode(this.workspaceRoot, this.sessionKey);
        // CHILD-EXEC-INHERIT — a silent child runs under its OWN childKey session
        // (orchestration/tools.ts), which carries no `/mode` override, so
        // resolveActiveMode falls back to the WORKSPACE default (often
        // `planning`) even when the PARENT is in fast/YOLO. That made a fast/YOLO
        // parent's workers stall on a parent-approval card for SAFE commands
        // (e.g. `ls`) despite "all permissions on". Mirror DESK-5n (which threads
        // `parentReviewPolicy` for the write/edit/patch gate): a silent child
        // inherits the parent's executionMode so it auto-approves SAFE commands
        // under fast/YOLO. The dangerous-command floor is UNCHANGED —
        // resolveRunCommandApproval still returns 'deny-silent' for dangerous
        // commands, which gates/denies below.
        const activeMode = this.silent && this.parentExecutionMode
          ? { ...baseMode, executionMode: this.parentExecutionMode }
          : baseMode;
        // 0.3.9 — pass `goalActive` so the resolver can auto-approve
        // SAFE commands when a /goal is active. Without this, the very
        // first run_command of a goal-mode session blocks the auto-
        // continuation on the askYesNo prompt, defeating the purpose of
        // "type a goal, walk away". Dangerous commands still ask.
        const goalForApproval = readGoal(this.workspaceRoot, this.sessionKey);
        const goalIsActive = !!(goalForApproval?.text && goalForApproval.status === 'active');
        const approval = destructiveOverride
          ? ('auto-approve' as const) // user already authorized the destructive command above — don't double-prompt
          : resolveRunCommandApproval(activeMode, cmd, { silent: this.silent, goalActive: goalIsActive, allowlist: getCliKnobs().commandAllowlist });
        let parentApproved = false;
        if (approval === 'deny-silent') {
          const dangerous = isDangerousCommand(cmd);
          if (this.confirmToolApproval) {
            const approved = await this.confirmToolApproval({
              tool: 'run_command',
              command: cmd,
              dangerous,
              reason: dangerous
                ? 'dangerous command requested by a silent child agent'
                : 'silent child agent shell command requires parent approval',
            });
            this.assertInheritedExecutionAuthorityCurrent();
            if (!approved) return 'Command execution rejected by parent approval.';
            parentApproved = true;
          } else if (dangerous) {
            return (
              `Command execution denied: dangerous command in a silent child agent. ` +
              `Silent children can't answer the y/N prompt, so destructive commands ` +
              `(rm -rf, sudo, force-push, …) are refused regardless of /mode. ` +
              `Have a parent agent run this command, or split it into a safer ` +
              `equivalent.`
            );
          } else {
            return (
              `Command execution denied: silent child agents may not run shell ` +
              `without parent opt-in. Switch the session to \`/mode fast\` (or set ` +
              `the legacy \`autoApproveShell\` pref) to let silent children run ` +
              `safe commands, or have a parent agent run this command.`
            );
          }
        }
        if (approval === 'auto-approve' || parentApproved) {
          const tag = this.silent
            ? (parentApproved ? 'Parent-approved (silent child)' : 'Auto-approved (silent child)')
            : goalIsActive && activeMode.executionMode !== 'fast'
              ? 'Auto-approved (/goal active)'
              : 'Auto-approved';
          console.log(chalk.gray(`▶  ${tag}: ${chalk.cyan(cmd)}`));
        } else {
          // approval === 'ask' — interactive y/N. Use the parent REPL's
          // readline interface; spinning up an inquirer prompt opens a second
          // readline against the same stdin and dumps a stray "line" event
          // back into the parent rl when it exits, which used to surface as
          // the bogus "A previous turn is still running" warning.
          //
          // The question we hand to `askYesNo` ALWAYS includes the command
          // itself. The legacy split — print command via `console.log`, then
          // ask "Allow execution? (y/N)" — works in the readline path because
          // both land on the same stream, but the Ink overlay (`runInkYesNo`)
          // only sees the question string. Without the command embedded here
          // the modal renders "Allow execution? (y/N)" with no context, and
          // the user has to take it on faith. Embedding the command keeps
          // both surfaces honest. (Fix flagged on 2026-05-27.)
          const dangerous = isDangerousCommand(cmd);
          // Legacy console.log kept so the readline path also has a visible
          // record above the prompt; the Ink path renders the same content
          // inside the modal title via the helper's structured string.
          // No leading `\n` — patchConsole already inserts a row boundary
          // when promoting this above the Ink frame, and adding our own
          // newline pushes the frame down an extra row every approval,
          // contributing to the "frame keeps growing / viewport scrolls
          // up" feel in main-screen mode. (0.3.9 — 2026-05-27)
          console.log(`${chalk.yellow('⚠️  Command execution request:')} ${chalk.cyan(cmd)}${dangerous ? chalk.red(' (potentially destructive)') : ''}`);
          const question = buildRunCommandPrompt(cmd);
          const approved = this.interactionPort
            ? await this.interactionPort.confirm({ title: 'Run shell command?', detail: cmd, dangerous, tool: 'run_command' })
            : await this.prompter.askYesNo(question, false);
          this.assertInheritedExecutionAuthorityCurrent();
          if (!approved) {
            return 'Command execution rejected by user.';
          }
        }

        // CC-P11.1 — background run: same approval gating as foreground (we are
        // past it here), but detach instead of blocking the turn. v1 runs
        // unsandboxed, so it is refused while cli.sandbox=on.
        if (args.background === true) {
          this.assertInheritedExecutionAuthorityCurrent();
          if (this.inheritedExecutionAuthorityGuard()) {
            return 'Background run_command is unavailable inside reviewed execution until detached processes have an execution-owned revocation lease.';
          }
          if (this.pentestMode) return 'Background run_command is disabled for pentests; commands must remain in the Docker/proxy perimeter.';
          // CODEX-SANDBOX-UNATTENDED — background runs are unsandboxed (v1), so
          // they are refused whenever the sandbox is active: either the user
          // turned it on, or this is a silent/unattended agent where the
          // sandbox is enforced regardless of the global knob.
          // HONK-H0 — a fleet/background executor's `forceFleetSandbox` also makes
          // the detached (unsandboxed) background path off-limits, so it can't be
          // used to escape the forced sandbox + network-deny the foreground path
          // applies — even when the operator opted out of silent enforcement.
          const sandboxActive =
            getCliKnobs().sandbox === 'on' ||
            (this.silent && (this.sandboxEnforceWhenSilent || this.forceFleetSandbox));
          if (sandboxActive) {
            return 'Background run_command is not supported while the sandbox is active (v1) — run it foreground or disable the sandbox.';
          }
          const bg = (this.shellPort ?? nodeShellPort).startBackgroundShell({ command: cmd, cwd: cwdOverride ?? this.launchCwd, workspaceRoot: this.workspaceRoot });
          return JSON.stringify({
            id: bg.id,
            status: bg.status,
            logPath: bg.logPath,
            note: 'Detached. Poll with task_output({ id }) — pass back nextOffset as fromByte to read incrementally. The turn is NOT blocked.',
          });
        }
        if (this.pentestMode) {
          this.assertInheritedExecutionAuthorityCurrent();
          const result = runPentestCommand(cmd, this.pentestSandbox
            ? { ...this.pentestSandbox, workspaceRoot: this.workspaceRoot }
            : resolvePentestSandbox(this.workspaceRoot));
          return `[pentest Docker/proxy sandbox] Exit Code: ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
        }
        // The sandbox is rooted at the EFFECTIVE cwd (the entered worktree, if
        // any); the rest of the scope (primary + other attached roots) is granted
        // write so a command run in a worktree can still touch the primary tree.
        const scopeWriteGrants = [this.workspaceRoot, ...(this.attachedRoots ?? [])].filter((r: string) => r !== effectiveCwd);
        const sandboxConfig = resolveSandboxConfig(
          effectiveCwd,
          { readPaths: prefs.sandboxReadPaths, writePaths: [...prefs.sandboxWritePaths, ...scopeWriteGrants] },
          { silent: this.silent, enforceWhenSilent: this.sandboxEnforceWhenSilent, forceEnforce: this.forceFleetSandbox, scopeSecrets: this.forceFleetSandbox },
        );
        this.assertInheritedExecutionAuthorityCurrent();
        // ADR-041 D3 — the bare exec runs through the injected shell port; the
        // sandbox config was already resolved (approval/policy/guards) above.
        const result = await (this.shellPort ?? nodeShellPort).runShell(cmd, sandboxConfig, undefined, this.turnAbort?.signal);
        // WS5 — remember commits WE authored this session, so a later
        // `git commit --amend` of one of them is allowed (vs. amending a
        // pre-existing/user commit, which the guard blocks).
        if (result.exitCode === 0 && /\bgit\b[^|;&]*\bcommit\b/i.test(cmd)) {
          const head = gitHeadSha(this.workspaceRoot);
          if (head) this.agentAuthoredCommits.add(head);
        }
        const enforcedTag = sandboxConfig.enforcedUnattended ? ' (enforced: unattended)' : '';
        const sandboxBadge = result.sandboxed
          ? `[sandboxed via ${result.sandboxTool}${enforcedTag}] `
          : sandboxConfig.enabled
            ? `[sandbox requested but unavailable${enforcedTag}] `
            : '';
        const notice = result.notice ? `${result.notice}\n` : '';
        return `${notice}${sandboxBadge}Exit Code: ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
      }
      case 'computer_use': {
        if (!getCliKnobs().computerUse.enabled) return 'computer_use is disabled. Set cli.computerUse.enabled=true to enable it.';
        if (!this.computerUsePort) return 'computer_use is unavailable in this runtime.';
        if (this.silent) return 'computer_use denied: silent child agents cannot control the desktop.';
        if (isRemoteBrainUrl(getCliKnobs().brainUrl)) return 'computer_use denied: remote-brain sessions cannot control the local desktop.';
        if (this.computerActionsThisTurn >= MAX_COMPUTER_ACTIONS_PER_TURN) {
          return `computer_use denied: per-turn action cap (${MAX_COMPUTER_ACTIONS_PER_TURN}) reached.`;
        }
        const validation = validateComputerAction(args);
        if (!validation.ok) return `computer_use invalid action: ${validation.error}`;
        const action = validation.action;
        this.computerActionsThisTurn += 1;

        if (action.action === 'screenshot') {
          try {
            const image = await this.computerUsePort.screenshot();
            return JSON.stringify({
              success: true,
              action: 'screenshot',
              image,
              note: 'Screenshot captured at full logical resolution.',
            }, null, 2);
          } catch (err: any) {
            return JSON.stringify({
              success: false,
              action: 'screenshot',
              permissionDenied: /permission|screen recording|accessibility/i.test(String(err?.message ?? err)),
              error: err?.message ?? String(err),
            }, null, 2);
          }
        }

        const destructive = evaluateDestructiveAction(action, { userIntent: this.lastUserPrompt });
        const activeMode = resolveActiveMode(this.workspaceRoot, this.sessionKey);
        const shouldAsk = destructive.dangerous || (isComputerActionMutating(action.action) && activeMode.executionMode !== 'fast');
        if (shouldAsk) {
          const detail = `${JSON.stringify(action, null, 2)}${destructive.reason ? `\n\n${destructive.reason}` : ''}`;
          const approved = this.interactionPort
            ? await this.interactionPort.confirm({ title: 'Allow computer control?', detail, dangerous: destructive.dangerous, tool: 'computer_use' })
            : await this.prompter.askYesNo(`${detail}\nAllow computer control? (y/N) `, false);
          if (!approved) return 'computer_use rejected by user.';
        }

        const result = await this.computerUsePort.act(action);
        return JSON.stringify({ action: action.action, ...result }, null, 2);
      }
      case 'fetch_url': {
        // A pentest turn must never reach the network from the HOST — that path
        // bypasses the scope-pinned Docker/proxy sandbox entirely (SSRF to
        // internal services / cloud metadata). Force target interaction through
        // the sandboxed run_command or the scoped proxy tools.
        if (this.pentestMode) return 'fetch_url is disabled for pentests; reach the target via run_command inside the sandbox, or view_request/repeat_request through the scoped proxy.';
        const url = args.url;
        // POLICY-3 — per-host egress allowlist (empty = unrestricted).
        const egressAllowlist = getCliKnobs().egressAllowlist;
        const egress = egressDecision(url, egressAllowlist);
        if (egress.decision === 'deny') {
          return `fetch_url blocked by egress policy: ${egress.reason}.`;
        }
        const knobs = getCliKnobs();
        // BROWSER-FIRST: when the in-app browser is available (desktop, top-level,
        // not a silent child), fetch through it so JS-rendered / logged-in /
        // bot-guarded pages return their REAL rendered content. Falls back to the
        // HTTP crawler on any failure or when there is no browser (CLI/server).
        // EXCEPT structured/API URLs (JSON/XML/feeds): the browser would render
        // them into a DOM and innerText-scrape a mangled copy — send those
        // straight to the crawler, which returns the raw bytes.
        if (this.browserControlPort && !this.silent && !looksStructuredUrl(String(url))) {
          // Read through a background agent-owned tab, then close it. The human's
          // selected tab and panel remain untouched while the real browser
          // session, JavaScript, and authentication are still available.
          const viaBrowser = await fetchViaInAppBrowser(this.browserControlPort, String(url), 25_000, this.turnAbort?.signal);
          if (viaBrowser?.text) {
            return JSON.stringify({ ok: true, via: 'in-app-browser', title: viaBrowser.title, url: viaBrowser.url, text: viaBrowser.text }, null, 2);
          }
        }
        const result = await fetchAndExtract(String(url), {
          ...knobs.webSearch.crawler,
          signal: this.turnAbort?.signal,
          // Re-apply the allowlist on every redirect hop (the crawler also blocks
          // private/loopback/metadata IPs on each hop as an always-on SSRF guard).
          isEgressAllowed: (target) => egressDecision(target, egressAllowlist).decision !== 'deny',
        });
        return JSON.stringify(result, null, 2);
      }
      case 'web_search': {
        // Host-side egress; disabled in a pentest for the same reason as fetch_url.
        if (this.pentestMode) return 'web_search is disabled for pentests; stay inside the authorized target using the sandboxed tools.';
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('web_search requires a non-empty query.');
        const knobs = getCliKnobs();
        const maxResults = Math.max(1, Math.min(10, Number(args.maxResults ?? knobs.webSearch.maxResults)));
        const page = Math.max(1, Math.min(10, Math.floor(Number(args.page ?? 1))));
        // BROWSER-ONLY when available: run the search THROUGH the in-app browser
        // (real Chromium, the user's session, no raw HTTP scrape / bot-challenge).
        // Google runs through the real browser so the search shares the user's
        // locale and session. A consent wall, challenge, or parser miss falls
        // through to an explicitly configured HTTP provider; there is no hidden
        // second search engine.
        if (this.browserControlPort && !this.silent) {
          const port = this.browserControlPort;
          const sig = this.turnAbort?.signal;
          const tryEngine = async (url: string, parsers: Array<(h: string, n: number) => WebSearchResult[]>): Promise<WebSearchResult[]> => {
            try {
              const html = await fetchHtmlViaInAppBrowser(port, url, 25_000, sig);
              if (html) for (const parse of parsers) { const r = parse(html, maxResults); if (r.length) return r; }
            } catch { /* fall through to the explicitly configured HTTP provider */ }
            return [];
          };
          const results = await tryEngine(googleSearchUrl(query, maxResults, page), [parseGoogleHtml]);
          if (results.length) return JSON.stringify(results.slice(0, maxResults), null, 2);
        }
        if (page > 1) return 'web_search pagination requires the managed Desktop browser; headless API providers currently support page 1 only.';
        try {
          const provider = buildSearchProvider(knobs);
          const results = await provider.search(query, maxResults, this.turnAbort?.signal);
          return JSON.stringify(results.slice(0, maxResults), null, 2);
        } catch (err: any) {
          return `web_search failed: ${err?.message ?? err}`;
        }
      }
      case 'mcp_call': {
        const target = String(args.name ?? '').trim();
        if (!target) throw new Error('mcp_call requires a tool `name` (use mcp_search to find one).');
        const tool = await this.findVisibleMcpTool(target);
        this.assertInheritedExecutionAuthorityCurrent();
        if (!tool) throw new Error(`mcp_call: "${target}" is not an available MCP tool. Use mcp_search to find the exact name.`);
        const callArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
          ? (args.args as Record<string, any>)
          : {};
        const toolName = String(tool.name);
        const mcpArgs = applyFederationIdentity(toolName, callArgs, this.federationSessionKey) as Record<string, any>;
        authorizeMcpTarget?.(toolName, mcpArgs, tool);
        const permissionNames = [
          toolName,
          String(tool.__rawName ?? '').trim(),
        ].filter((name, index, names) => name && names.indexOf(name) === index);
        if (permissionNames.some((permissionName) => evaluatePermissionRules(
          getCliKnobs().permissions,
          permissionName,
          primaryArgText(permissionName, mcpArgs),
          { workspace: this.workspaceRoot },
        ) === 'deny')) {
          throw new Error(`mcp_call target "${toolName}" denied by cli.permissions.`);
        }
        await this.approveMcpToolCall(toolName, tool, mcpArgs);
        this.assertInheritedExecutionAuthorityCurrent();
        const mcpRes = await this.mcpClient.callTool(toolName, mcpArgs, { signal: this.turnAbort?.signal });
        return extractToolText(mcpRes);
      }
      case 'spawn_worker_thread': {
        if (!canSpawnWorker(this.agentDepth)) {
          throw new Error('Workers cannot spawn workers (MAX_WORKER_DEPTH=1).');
        }
        const goal = String(args.goal ?? '').trim();
        if (!goal) throw new Error('spawn_worker_thread requires a goal.');
        // ADR-041 D3 — spawn via the injected subprocess port (default wraps
        // spawnWorkerThread; an execution world can spawn in a container/remote).
        const worker = (this.subprocessPort ?? nodeSubprocessPort).spawnWorker(this.mcpClient, this.llmConfig, {
          workspaceRoot: this.workspaceRoot,
          launchCwd: this.launchCwd,
          role: String(args.role ?? 'worker'),
          goal,
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          ownership: typeof args.ownership === 'string' ? args.ownership : (this.ownership ?? null),
          parentSessionKey: this.sessionKey,
          parentAccessMode: this.accessMode,
          spawnerDepth: this.agentDepth,
          effortOverride: this.effortOverride,
          ancestorFleet: this.forceFleetSandbox, // HONK-H0 — cascade fleet lockdown
        });
        return JSON.stringify({ id: worker.id, status: worker.status, goal: worker.goal });
      }
      case 'apply_patch': {
        const patch = String(args.patch ?? '');
        if (!patch.trim()) throw new Error('apply_patch requires a non-empty patch.');
        const ops = parsePatchEnvelope(patch);
        const safety = assessPatchSafety(ops);
        const parentDenial = await this.confirmSilentChildToolApproval({
          tool: 'apply_patch',
          summary: `${safety.adds} add, ${safety.updates} update, ${safety.deletes} delete, ${safety.renames} rename`,
          reason: safety.touchesVcs
            ? 'silent child agent requested a patch touching VCS metadata'
            : 'silent child agent requested a patch',
          dangerous: safety.touchesVcs || safety.deletes > 0,
        });
        if (parentDenial) return parentDenial;
        this.assertInheritedExecutionAuthorityCurrent();
        // 0.4.x-3b — capture each target file's prior content before the patch
        // applies (undo log for /rewind --files). Parse the envelope's file
        // headers (`*** Add/Update/Delete File: <path>`).
        for (const m of patch.matchAll(/^\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+)\s*$/gm)) {
          const p = m[1].trim();
          if (p) { try { this.captureFileSnapshot(path.resolve(this.workspaceRoot, p)); } catch { /* noop */ } }
        }
        {
          const result = applyPatchEnvelope(patch, this.workspaceRoot, this.ownership);
          const firstFile = patch.match(/^\*\*\*\s+(?:Add|Update) File:\s*(.+)\s*$/m)?.[1]?.trim();
          const checkFile = firstFile ? path.resolve(this.workspaceRoot, firstFile) : this.workspaceRoot;
          const patchNotice = runPostEditCheck({ template: getCliKnobs().postEditCheck, file: checkFile, cwd: this.workspaceRoot });
          let patchReindex = '';
          if (firstFile) {
            try { patchReindex = await this.maybeReindexSource(checkFile, fs.readFileSync(checkFile, 'utf8')); } catch { /* file may have been deleted */ }
          }
          return result + patchNotice + patchReindex;
        }
      }
      case 'track_update': {
        const action = String(args.action ?? '');
        if (action === 'create') {
          const item = trackCreateWorkItem(this.workspaceRoot, {
            title: String(args.title ?? 'Untitled'),
            type: isWorkItemType(args.type) ? args.type : 'task',
            status: typeof args.status === 'string' ? args.status : undefined,
            priority: isWorkItemPriority(args.priority) ? args.priority : undefined,
            sessionKey: this.sessionKey, actor: 'agent',
          });
          return `Created ${item.key} [${item.status}]: ${item.title}`;
        }
        if (action === 'transition') {
          try {
            const item = trackTransitionWorkItem(this.workspaceRoot, String(args.key ?? ''), String(args.toStatus ?? ''), 'agent');
            return item ? `${item.key} → ${item.status}` : `No work item "${args.key}".`;
          } catch (e) { return (e as Error).message; }
        }
        if (action === 'comment') {
          const item = trackAddComment(this.workspaceRoot, String(args.key ?? ''), 'agent', String(args.body ?? ''));
          return item ? `Commented on ${item.key}.` : `No work item "${args.key}".`;
        }
        if (action === 'link') {
          const item = trackLinkWorkItem(this.workspaceRoot, String(args.key ?? ''), {
            codeLinks: Array.isArray(args.codeLinks) ? (args.codeLinks as Array<{ kind: 'branch' | 'commit' | 'pull-request' | 'file'; ref: string }>) : undefined,
            linkedMemoryIds: Array.isArray(args.linkedMemoryIds) ? (args.linkedMemoryIds as string[]) : undefined,
            links: typeof args.blocks === 'string' ? [{ type: 'blocks', targetId: args.blocks }] : undefined,
          });
          return item ? `Linked ${item.key}.` : `No work item "${args.key}".`;
        }
        if (action === 'assign-sprint') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          const item = trackUpdateWorkItem(this.workspaceRoot, String(args.key ?? ''), { sprintId }, 'agent');
          return item ? `Assigned ${item.key} to ${sprint.name}.` : `No work item "${args.key}".`;
        }
        if (action === 'sprint-create') {
          const name = String(args.name ?? '').trim();
          if (!name) return 'sprint-create requires a name.';
          const sprint = trackCreateSprint(this.workspaceRoot, {
            name,
            goal: typeof args.goal === 'string' ? args.goal : undefined,
          });
          return `Created ${sprint.name} (${sprint.id}).`;
        }
        if (action === 'batch-transition') {
          const query = String(args.query ?? '').trim();
          if (!query) return 'batch-transition requires a query.';
          const parsed = parseTrackQuery(query);
          if (!parsed.ok) return `Bad query: ${parsed.error}`;
          const toStatus = String(args.toStatus ?? '');
          const project = trackGetProject(this.workspaceRoot) ?? trackEnsureProject(this.workspaceRoot);
          if (!project.workflowStates.some((state) => state.id === toStatus)) {
            return `Unknown workflow state "${toStatus}". Valid: ${project.workflowStates.map((state) => state.id).join(', ')}`;
          }
          const items = trackListWorkItems(this.workspaceRoot, { query }).filter((item) => item.status !== toStatus);
          for (const item of items) trackTransitionWorkItem(this.workspaceRoot, item.key, toStatus, 'agent');
          return `Transitioned ${items.length} work item${items.length === 1 ? '' : 's'} to ${toStatus}.`;
        }
        if (action === 'sprint-start') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          if (args.capacity !== undefined && (typeof args.capacity !== 'number' || !Number.isFinite(args.capacity) || args.capacity < 0)) {
            return 'Sprint capacity must be a non-negative number.';
          }
          try {
            trackSetSprintState(this.workspaceRoot, sprintId, 'active');
          } catch (error) {
            return (error as Error).message;
          }
          const updated = trackUpdateSprint(this.workspaceRoot, sprintId, {
            startDate: sprint.startDate ?? new Date().toISOString(),
            ...(typeof args.capacity === 'number' ? { capacity: args.capacity } : {}),
          })!;
          return `Started ${updated.name}.`;
        }
        if (action === 'sprint-complete') {
          const sprintId = String(args.sprintId ?? '');
          const sprint = trackListSprints(this.workspaceRoot).find((candidate) => candidate.id === sprintId);
          if (!sprint) return `No sprint "${sprintId}".`;
          const velocity = trackSprintVelocity(this.workspaceRoot, sprintId)!;
          trackUpdateSprint(this.workspaceRoot, sprintId, { velocity });
          trackSetSprintState(this.workspaceRoot, sprintId, 'completed');
          return `Completed ${sprint.name} (velocity: ${velocity}).`;
        }
        return `Unknown track_update action "${action}". Use create · transition · comment · link · sprint-create · assign-sprint · batch-transition · sprint-start · sprint-complete.`;
      }
      case 'connector_run': {
        const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
        if (!connectorId) throw new Error('connector_run requires a `connectorId` (see connector_list).');
        // Agent deps: static/dynamic-token GitHub client (NO keychain — oauth
        // github without a token throws the desktop-only guidance in the runner),
        // the agent's own MCP client for the `mcp` source, and env-token creds.
        const runResult = await runConnectorCheckpointCore(this.workspaceRoot, connectorId, {
          envToken: defaultEnvTokenResolver,
          githubClient: (connector) => {
            const cred = defaultEnvTokenResolver(connector, 'GitHub');
            if (!cred.token) return undefined; // → runner throws the OAuth/keychain guidance
            const apiBase = typeof connector.config.baseUrl === 'string' ? connector.config.baseUrl : undefined;
            return githubTokenClient(cred.token, { apiBase });
          },
          mcpClient: () => this.agentMcpConnectorClient(),
        });
        // Import the freshly-persisted documents into memory so future recall can
        // cite them — mirror the host's `indexConnectorMemory` via `memory_import`.
        let importedRecords = 0;
        let importError: string | undefined;
        if (runResult.documents.length > 0) {
          try {
            // Omit sessionKey (mirror the desktop host): connector documents are
            // workspace knowledge, not session-scoped, so future recall in any
            // session can cite them.
            const bundle = exportConnectorDocumentsForMemory(this.workspaceRoot, { connectorId });
            if (bundle.recordCount > 0) {
              const res = await this.mcpClient.callTool('memory_import', { data: bundle.data }, { signal: this.turnAbort?.signal });
              if ((res as { isError?: boolean })?.isError) {
                const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
                importError = typeof text === 'string' ? text : 'memory_import failed.';
              } else {
                importedRecords = bundle.recordCount;
              }
            }
          } catch (err) {
            importError = err instanceof Error ? err.message : String(err);
          }
        }
        const lines = [
          `Connector ${connectorId}: ${runResult.ok ? 'ran' : 'ran with failures'}.`,
          `Documents seen: ${runResult.run.documentsSeen ?? runResult.documents.length}; persisted: ${runResult.documents.length}; imported to memory: ${importedRecords}.`,
        ];
        // Failures are already source-sanitized by the runtimes (repo/channel +
        // HTTP status, never tokens). Cap the list so a broad failure set can't
        // flood the transcript.
        if (runResult.failures.length) {
          lines.push(`Failures (${runResult.failures.length}):`);
          for (const failure of runResult.failures.slice(0, 10)) lines.push(`  - ${failure}`);
          if (runResult.failures.length > 10) lines.push(`  … and ${runResult.failures.length - 10} more.`);
        }
        if (importError) lines.push(`Memory import error: ${importError}`);
        return lines.join('\n');
      }
      case 'file_vulnerability': {
        const run = getLatestReview(this.workspaceRoot);
        if (!run || run.status !== 'running') throw new Error('file_vulnerability requires an active pentest review run.');
        const input = validatePentestFinding({
          file: String(args.file ?? ''), line: Number.isInteger(args.line) ? Number(args.line) : undefined,
          endLine: Number.isInteger(args.endLine) ? Number(args.endLine) : undefined,
          summary: String(args.summary ?? ''), details: typeof args.details === 'string' ? args.details : undefined,
          confidence: Math.max(0, Math.min(100, Number(args.confidence) || 0)),
          cvssVector: String(args.cvssVector ?? ''), cwe: String(args.cwe ?? ''),
          cve: typeof args.cve === 'string' ? args.cve : undefined,
          poc: String(args.poc ?? ''), remediation: String(args.remediation ?? ''),
        });
        const key = findingKey({ file: input.file, line: input.line, lineEnd: input.endLine, severity: input.severity, confidence: input.confidence, summary: input.summary, rootCause: input.cwe });
        const duplicate = run.findings.find((existing) => findingKey({ file: existing.file, line: existing.line, lineEnd: existing.endLine, severity: existing.severity, confidence: existing.confidence, summary: existing.summary, rootCause: existing.cwe }) === key);
        if (duplicate) return JSON.stringify({ accepted: false, duplicate_of: duplicate.id, reason: 'Same file, location, and root cause already recorded.' });
        if (run.findings.length) {
          try {
            const judged: any = await callOpenAI(this.llmConfig, buildPentestDedupeMessages(input, run.findings.map((finding) => ({ id: finding.id, file: finding.file, line: finding.line, endLine: finding.endLine, summary: finding.summary, details: finding.details, cwe: finding.cwe, poc: finding.poc }))), [], { effort: 'low', signal: this.turnAbort?.signal });
            if (judged?.usage) {
              this.lastTurnUsage.promptTokens += judged.usage.prompt_tokens ?? 0;
              this.lastTurnUsage.completionTokens += judged.usage.completion_tokens ?? 0;
              this.lastTurnUsage.calls += 1;
              enforceTaskBudget({ caps: this.taskBudgetCaps ?? getCliKnobs().budget, modelId: this.llmConfig.model, usage: { promptTokens: this.sessionUsage.promptTokens + this.lastTurnUsage.promptTokens, completionTokens: this.sessionUsage.completionTokens + this.lastTurnUsage.completionTokens, cachedTokens: this.sessionUsage.cachedTokens + this.lastTurnUsage.cachedTokens, missedTokens: this.sessionUsage.missedTokens + this.lastTurnUsage.missedTokens } });
            }
            const decision = parsePentestDedupeDecision(String(judged?.content ?? ''));
            if (decision?.is_duplicate && decision.duplicate_id && decision.confidence >= 0.75 && run.findings.some((finding) => finding.id === decision.duplicate_id)) {
              return JSON.stringify({ accepted: false, duplicate_of: decision.duplicate_id, confidence: decision.confidence, reason: decision.reason });
            }
          } catch (error) {
            // Deterministic same-location/root-cause protection above remains
            // authoritative if the optional semantic judge is unavailable.
            if (error instanceof Error && error.name === 'BudgetExceededError') throw error;
          }
        }
        const finding = { ...input, id: `pentest_${randomUUID().slice(0, 12)}` };
        saveReview(this.workspaceRoot, { ...run, updatedAt: new Date().toISOString(), findings: [...run.findings, finding] });
        return JSON.stringify({ accepted: true, finding: { id: finding.id, severity: finding.severity, cvss: finding.cvss } });
      }
      default:
        throw new Error(`Unknown local tool: ${name}`);
    }
  }
