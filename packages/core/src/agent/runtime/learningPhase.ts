/**
 * ADR-032 D1/D5 — where learning touches a live turn, and where it does not.
 *
 * Two directions, and they are deliberately in one file so the round trip is
 * readable in one screen:
 *
 * - **in** (`applyLearnedContext`) — the learned block is attached as a tagged
 *   system message before the model runs, exactly the way the goal anchor and
 *   the required-skill anchor are. Nothing here edits the base system prompt;
 *   D1's whole argument is that the assembled prompt must stay explicable from
 *   its declared sources.
 * - **out** (`scheduleLearningCheckpoint`) — the checkpoint is DISPATCHED, never
 *   awaited. D5 is explicit: a person waiting on an answer must not wait on
 *   reflection. Every caller is fire-and-forget for that reason, and the
 *   promise is swallowed here rather than at each call site so no caller can
 *   accidentally make it blocking.
 *
 * The retrieval accounting also lives on the "in" side, because that is the
 * only place that knows an item was really placed in front of the model. D6
 * measures whether a learned item paid off; counting a retrieval anywhere else
 * would count intentions instead of deliveries.
 */
import type { Agent } from '../agent.js';
import {
  applyCentralLearnedRevert, applyLearnedTransition, buildLearnedContext, getLearnedItem,
  learnedItemMemoryMetadata, LEARNED_CONTEXT_TAG, listLearnedItems, noteLearnedRetrieval,
  runLearningCheckpoint, selectLearnedForTurn,
  type LearnedTenant, type LearningCheckpointReason,
} from '../../learning/index.js';
import { fenceMarkerPattern } from '../../planner/agentContext.js';
import { getRawCliKnobs } from '../../config/config.js';
import type { CliAccountIdentity } from '../../config/configTypes.js';
import { eligibleCorroboratingActions, emptySessionProvenance } from './contentProvenance.js';
import { callOpenAI } from '../transport/llmTransport.js';

/**
 * The partition this process learns into.
 *
 * Read from the signed-in BrainRouter account in `config.json` — the only place
 * on a client where either id exists. The first cut declared a host-settable
 * field on the Agent instead, which nothing ever wrote: D8's partition was
 * present in the store's API and absent in every install, so every machine wrote
 * into `personal__local`. A partition key with no writer is not a partition.
 *
 * `local` is the honest identity when nobody is signed in, and it is the same
 * fallback `notesFile`/`plannerFile` use, so the learned store and the other
 * user-scoped stores agree about whose records these are. An absent org means
 * PERSONAL, never "any": a lesson learned in one customer's workspace reaching
 * another is a data leak with a pleasant name.
 *
 * `agent` is taken so the signature can carry a per-agent identity the day a
 * host multiplexes tenants in one process; today every agent in a process
 * shares the machine's account.
 */
export function learnedTenantForAgent(agent: Agent): LearnedTenant {
  if (agent.learnedTenant) return { ...agent.learnedTenant };
  try {
    agent.learnedTenant = learnedTenantFromAccount(getRawCliKnobs().account);
  } catch {
    // No config, unreadable config, or a first run: the personal partition is
    // the right answer, and learning must never be what fails on a fresh box.
    agent.learnedTenant = learnedTenantFromAccount(undefined);
  }
  return { ...agent.learnedTenant };
}

/** The pure half, so the partition rule is testable without a config file. */
export function learnedTenantFromAccount(account: CliAccountIdentity | undefined): LearnedTenant {
  const orgId = account?.orgId?.trim();
  return {
    orgId: orgId || null,
    userId: account?.userId?.trim() || 'local',
  };
}

/**
 * Attach the learned block, and record that the items in it were delivered.
 *
 * Removes the tagged message when there is nothing to say — a section that
 * always appears trains the model to skip it (ADR-028 D6), and a stale block
 * left behind after every item retired would be worse than none.
 */
export function applyLearnedContext(agent: Agent): void {
  // Sub-agents share the partition but run bounded, single-purpose turns;
  // spending their context on a parent's behavioural history buys little and
  // would inflate retrieval counts with deliveries nobody acted on.
  if (agent.learningEnabled === false) {
    agent.removeTaggedSystemMessage(LEARNED_CONTEXT_TAG);
    return;
  }
  if (agent.silent) return;
  let selected;
  try {
    // The workspace decides RELEVANCE, not access: the partition is still
    // `(orgId, userId)`, so this only reorders and bounds what a turn sees.
    // Without it, advice about one repository arrives as a system message in
    // every other repository the same person opens.
    selected = selectLearnedForTurn(
      listLearnedItems(learnedTenantForAgent(agent)),
      agent.workspaceRoot,
    );
  } catch {
    // A corrupt or unreadable store must not take the turn down with it.
    agent.removeTaggedSystemMessage(LEARNED_CONTEXT_TAG);
    return;
  }
  const block = buildLearnedContext(selected);
  if (!block) {
    agent.removeTaggedSystemMessage(LEARNED_CONTEXT_TAG);
    return;
  }
  agent.replaceTaggedSystemMessage(LEARNED_CONTEXT_TAG, block);
  try {
    noteLearnedRetrieval(
      learnedTenantForAgent(agent),
      agent.sessionKey,
      selected.map((item) => item.id),
    );
  } catch {
    // The counter is D6's weak signal; losing one delivery is survivable.
  }
}

/** Trajectory characters handed to a checkpoint. The reflector caps again. */
const MAX_TRAJECTORY_WINDOW = 12_000;

/**
 * The session window a checkpoint reflects on.
 *
 * The TAIL of the history, because the end of a session is where the outcome
 * is: whether the fix worked, whether the command finally ran. Tool results are
 * included but each is capped — a checkpoint reading one enormous file dump and
 * nothing else would learn about that file rather than about the work.
 */
export function sessionTrajectory(agent: Agent): string {
  const lines: string[] = [];
  for (const message of agent.chatHistory.slice(-60) as Array<Record<string, unknown>>) {
    const role = String(message.role ?? '');
    if (role === 'system') continue;
    const content = typeof message.content === 'string'
      ? message.content
      : message.content === undefined || message.content === null
        ? ''
        : JSON.stringify(message.content);
    const calls = Array.isArray(message.tool_calls)
      ? ` [tools: ${(message.tool_calls as Array<Record<string, any>>)
        .map((call) => String(call?.function?.name ?? call?.name ?? 'tool'))
        .join(', ')}]`
      : '';
    const body = content.slice(0, 1_200);
    if (!body && !calls) continue;
    lines.push(`${role}${calls}: ${body}`);
  }
  const joined = lines.join('\n');
  return joined.length > MAX_TRAJECTORY_WINDOW ? joined.slice(-MAX_TRAJECTORY_WINDOW) : joined;
}

/**
 * Every fence the codebase actually opens around attacker-influenced content.
 *
 * Built with `fenceMarkerPattern` from the tags that exist — `planner_data`
 * (mirrored issue titles and calendar text), `workspace_data` (resolved
 * references, and the wrapper attachment extracts reuse) and `design_artifact`.
 * Naming a tag nothing emits would make this check quietly answer "no" for a
 * class of content, which is the failure mode where a security check reads as
 * present and is not.
 */
const UNTRUSTED_FENCES = ['planner_data', 'workspace_data', 'design_artifact']
  .map((tag) => fenceMarkerPattern(tag));

/**
 * D7, first signal — untrusted content that arrived already FENCED.
 *
 * This is the narrow half of the question, and it is deliberately kept narrow:
 * those modules already decide what to fence, and an untrusted marker two
 * subsystems compute independently is one that eventually disagrees. It cannot
 * be the whole answer, because the loudest untrusted channel — a fetched page,
 * a search result, a browser read — carries no fence at all. `contentProvenance`
 * scores that half from the tool that produced it; `sessionUntrustedContent`
 * below is the union, and the union is what D7 is asked.
 */
export function sessionSawUntrustedContent(agent: Agent): boolean {
  for (const message of agent.chatHistory.slice(-60) as Array<Record<string, unknown>>) {
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content) continue;
    // `fenceMarkerPattern` returns a global regex, so `lastIndex` persists
    // between calls; reset it or every second test of the same pattern starts
    // mid-string and misses.
    for (const fence of UNTRUSTED_FENCES) {
      fence.lastIndex = 0;
      if (fence.test(content)) return true;
    }
  }
  return false;
}

/**
 * D7's two inputs, computed from what the PROCESS did rather than asked of the
 * model: a document can claim corroboration, a tool tally cannot.
 *
 * - `saw` is the union of the fenced channel and the tool-scored one. A session
 *   that fetched a page saw untrusted content whether or not anyone fenced it.
 * - `corroborated` requires a trusted action AFTER the untrusted read. The
 *   earlier `lastTurnToolCalls > 0` let the very call that fetched the hostile
 *   document vouch for the hostile document, which defeated the rule in exactly
 *   the case it was written for.
 *
 * When the only signal is a fence, the read has no position to order against —
 * fenced content can be injected into the prompt without a tool call at all — so
 * corroboration falls back to "a trusted action happened at some point this
 * session". Still stricter than before: a read is never corroboration.
 */
export function sessionUntrustedContent(agent: Agent): {
  saw: boolean;
  corroborated: boolean;
  eligibleActions: ReturnType<typeof eligibleCorroboratingActions>;
} {
  const provenance = agent.sessionProvenance ?? emptySessionProvenance();
  const fromTools = provenance.untrustedReads > 0;
  const saw = fromTools || sessionSawUntrustedContent(agent);
  const eligibleActions = fromTools ? eligibleCorroboratingActions(provenance) : [];
  return {
    saw,
    // A fence with no ordered source event cannot be safely corroborated by a
    // global action tally. It remains untrusted-only and will fail the gate.
    corroborated: fromTools ? eligibleActions.length > 0 : !saw && provenance.trustedActions > 0,
    eligibleActions,
  };
}

interface PendingCheckpoint {
  readonly sessionKey: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

const pendingCheckpoints = new WeakMap<Agent, Set<PendingCheckpoint>>();
const endingSessions = new WeakMap<Agent, Map<string, Promise<void>>>();

/**
 * Dispatch a checkpoint. Returns immediately; the work happens after the turn.
 *
 * `silent` agents are excluded: a sub-agent's trajectory is a fragment of
 * somebody else's task, and learning a "lesson" from half a delegated job is
 * how a store fills with statements that were only ever true inside one
 * assignment.
 */
export function scheduleLearningCheckpoint(
  agent: Agent,
  reason: LearningCheckpointReason,
): Promise<void> {
  if (agent.silent || agent.learningEnabled === false) return Promise.resolve();
  const tenant = learnedTenantForAgent(agent);
  const sessionKey = agent.sessionKey;
  // A completed close is idempotent only until this logical session becomes
  // active again. Resuming the same key and completing another turn must earn
  // a new final checkpoint rather than returning the old completed Promise.
  if (reason !== 'session-end') endingSessions.get(agent)?.delete(sessionKey);
  const trajectory = sessionTrajectory(agent);
  const {
    saw: sawUntrustedContent,
    corroborated: corroboratedByTrustedAction,
    eligibleActions,
  } =
    sessionUntrustedContent(agent);
  const controller = new AbortController();
  const llmConfig = { ...agent.llmConfig };
  const mcpClient = agent.mcpClient;
  const correctionPointerStatuses = new Map<string, 'active' | 'demoted' | 'retired' | 'reverted'>();
  const updateMemoryStatus = async (
    item: { id: string; memoryRecordId?: string },
    reasonText: string,
    status: 'active' | 'archived',
  ): Promise<void> => {
    if (!item.memoryRecordId) return;
    const operation = status === 'active' ? 'restore' : 'archive';
    const result = await mcpClient.callHostLearning({
      operation: 'lifecycle',
      input: {
        operation,
        recordId: item.memoryRecordId,
        itemId: item.id,
        reason: reasonText.slice(0, 400),
      },
    });
    const text = Array.isArray((result as any)?.content)
      ? String((result as any).content[0]?.text ?? '')
      : '';
    if ((result as any)?.isError) throw new Error(text || `central learned memory ${operation} failed`);
    let parsed: {
      found?: boolean;
      learnedStatus?: string;
      learnedStatusReason?: string;
      memoryStatus?: string;
      blockedByHumanRevert?: boolean;
    } | undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { /* handled below */ }
    if (!parsed?.found) throw new Error('central learned memory record was not found');
    if (parsed.learnedStatus === 'reverted' || parsed.blockedByHumanRevert) {
      applyCentralLearnedRevert({
        tenant,
        id: item.id,
        reason: parsed.learnedStatusReason?.trim()
          || 'reverted from the hosted learning dashboard during lifecycle reconciliation',
      });
      throw new Error('central learned behaviour was reverted by a person');
    }
    if (parsed.memoryStatus !== status) {
      throw new Error(`central learned memory remained ${String(parsed.memoryStatus ?? 'unknown')}`);
    }
  };

  const work: Promise<void> = runLearningCheckpoint({
    tenant,
    sessionKey,
    // Record WHERE this was learned. Selection uses it to stop repo-specific
    // advice being delivered, confidently and wrongly, in another codebase.
    ...(agent.workspaceRoot ? { project: agent.workspaceRoot } : {}),
    reason,
    trajectory,
    sawUntrustedContent,
    corroboratedByTrustedAction,
    eligibleCorroboratingActions: eligibleActions,
    llm: async ({ system, user }) => {
      const response: any = await callOpenAI(
        llmConfig,
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        [],
        // Independent from the turn's Stop controller, but abortable by the
        // bounded session-close drain so Ctrl+C cannot orphan the request.
        { effort: 'low', signal: controller.signal, maxResponseBytes: 64 * 1024 },
      );
      return String(response?.content ?? '');
    },
    // BrainRouter memory stays central: the durable FACT goes to the memory
    // engine like every other durable fact, and the learned store keeps only
    // the lifecycle memory does not model — the tier, the falsifier, the
    // expectation, and the counters D6 retires on. This is not a second memory
    // system; it is the ledger beside the one we already have.
    recordToMemory: async (item) => {
      const result = item.origin === 'human-correction'
        ? await mcpClient.callHostLearning({
          operation: 'correct',
          input: {
            itemId: item.id,
            statement: item.statement,
            falsifier: item.falsifier,
            expectation: item.outcome.expectation,
          },
        })
        : await mcpClient.callHostLearning({
          operation: 'record',
          input: {
            text: item.statement,
            evidence: `learned:${item.tier} · wrong if: ${item.falsifier}`,
            sessionKey,
            learned: learnedItemMemoryMetadata(item),
          },
        });
      const text = Array.isArray((result as any)?.content)
        ? String((result as any).content[0]?.text ?? '')
        : '';
      try {
        const parsed = text ? JSON.parse(text) : undefined;
        if ((result as any)?.isError) throw new Error(text || 'central memory rejected lesson');
        if (item.origin === 'human-correction') {
          if (parsed?.found !== true || parsed?.itemId !== item.id || typeof parsed?.recordId !== 'string') {
            return undefined;
          }
          if (
            parsed.status === 'active'
            || parsed.status === 'demoted'
            || parsed.status === 'retired'
            || parsed.status === 'reverted'
          ) {
            correctionPointerStatuses.set(item.id, parsed.status);
          }
        }
        return typeof parsed?.recordId === 'string' ? parsed.recordId : undefined;
      } catch {
        if ((result as any)?.isError) throw new Error(text || 'central memory rejected lesson');
        return undefined;
      }
    },
    syncMemory: async (item) => {
      if (!item.memoryRecordId) return;
      let projection = item;
      const correctionStatus = correctionPointerStatuses.get(item.id);
      if (correctionStatus) {
        const current = getLearnedItem(tenant, item.id) ?? item;
        if (correctionStatus === 'reverted') {
          if (current.status !== 'reverted') {
            applyCentralLearnedRevert({
              tenant,
              id: item.id,
              reason: 'the existing hosted correction was already reverted by a person',
            });
          }
          correctionPointerStatuses.delete(item.id);
          return;
        }
        if (correctionStatus === 'demoted' && (current.status !== 'demoted' || current.tier !== 'evidence')) {
          applyLearnedTransition(tenant, [{
            id: item.id,
            tier: 'evidence',
            status: 'demoted',
            reason: 'the existing hosted correction was already demoted',
          }]);
        } else if (correctionStatus === 'retired' && current.status !== 'retired') {
          applyLearnedTransition(tenant, [{
            id: item.id,
            status: 'retired',
            reason: 'the existing hosted correction was already retired',
          }]);
        }
        projection = getLearnedItem(tenant, item.id) ?? item;
        correctionPointerStatuses.delete(item.id);
      }
      const result = await mcpClient.callHostLearning({
        operation: 'sync',
        input: {
          recordId: projection.memoryRecordId ?? item.memoryRecordId,
          itemId: projection.id,
          learned: learnedItemMemoryMetadata(projection),
        },
      });
      const text = Array.isArray((result as any)?.content)
        ? String((result as any).content[0]?.text ?? '')
        : '';
      if ((result as any)?.isError) throw new Error(text || 'central learned-behaviour sync failed');
      let parsed: {
        found?: boolean;
        blockedByHumanRevert?: boolean;
      } | undefined;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { /* handled below */ }
      if (!parsed?.found) throw new Error('central learned-behaviour record was not found');
      // Close the read/sync race in the same checkpoint. The database protects
      // the human decision; the local ledger must immediately follow it.
      if (parsed.blockedByHumanRevert) {
        applyCentralLearnedRevert({
          tenant,
          id: item.id,
          reason: 'reverted from the hosted learning dashboard while synchronizing',
        });
      }
    },
    syncOutcome: async (event) => {
      const result = await mcpClient.callHostLearning({
        operation: 'outcome',
        input: {
          recordId: event.recordId,
          itemId: event.itemId,
          sessionIdentity: event.sessionIdentity,
          outcome: event.outcome,
          detail: event.detail.slice(0, 240),
        },
      });
      const text = Array.isArray((result as any)?.content)
        ? String((result as any).content[0]?.text ?? '')
        : '';
      if ((result as any)?.isError) throw new Error(text || 'central learned outcome sync failed');
      let parsed: { found?: boolean; accepted?: boolean } | undefined;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { /* handled below */ }
      if (!parsed?.found || !parsed.accepted) {
        throw new Error('central learned outcome record was not accepted');
      }
    },
    archiveMemory: (item, reasonText) => updateMemoryStatus(item, reasonText, 'archived'),
    restoreMemory: (item, reasonText) => updateMemoryStatus(item, reasonText, 'active'),
    readMemoryLifecycle: async (item) => {
      if (!item.memoryRecordId) return { status: 'missing' as const };
      const result = await mcpClient.callHostLearning({
        operation: 'lifecycle',
        input: {
          operation: 'inspect',
          recordId: item.memoryRecordId,
          itemId: item.id,
        },
      });
      const text = Array.isArray((result as any)?.content)
        ? String((result as any).content[0]?.text ?? '')
        : '';
      if ((result as any)?.isError) throw new Error(text || 'central learned memory inspection failed');
      let parsed: {
        found?: boolean;
        learnedStatus?: string;
        learnedStatusReason?: string;
      } | undefined;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { return { status: 'missing' as const }; }
      if (!parsed?.found) return { status: 'missing' as const };
      if (parsed.learnedStatus === 'reverted') {
        return {
          status: 'reverted' as const,
          reason: parsed.learnedStatusReason ?? 'reverted from the hosted learning dashboard',
        };
      }
      return {
        status: parsed.learnedStatus === 'demoted' || parsed.learnedStatus === 'retired'
          ? parsed.learnedStatus
          : 'active',
      };
    },
  }).then(() => undefined).catch(() => {
    // Learning is an improvement path, never a liability. A checkpoint that
    // could surface an error into a finished turn would make the feature
    // something to switch off.
  });
  let tracked!: PendingCheckpoint;
  tracked = {
    sessionKey,
    controller,
    promise: work.finally(() => pendingCheckpoints.get(agent)?.delete(tracked)),
  };
  const pending = pendingCheckpoints.get(agent) ?? new Set<PendingCheckpoint>();
  pending.add(tracked);
  pendingCheckpoints.set(agent, pending);
  return tracked.promise;
}

/** Schedule the final checkpoint and wait only for a bounded drain. Normal
 * turn-end/compaction checkpoints remain non-blocking. */
export function finishLearningSession(agent: Agent, timeoutMs = 2_500): Promise<void> {
  if (agent.silent || agent.learningEnabled === false) return Promise.resolve();
  const sessionKey = agent.sessionKey;
  const bySession = endingSessions.get(agent) ?? new Map<string, Promise<void>>();
  const existing = bySession.get(sessionKey);
  if (existing) return existing;
  const boundedMs = Math.max(100, Math.min(10_000, Math.floor(timeoutMs)));
  const work = (async () => {
    void scheduleLearningCheckpoint(agent, 'session-end');
    const relevant = [...(pendingCheckpoints.get(agent) ?? [])]
      .filter((checkpoint) => checkpoint.sessionKey === sessionKey);
    if (relevant.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(relevant.map((checkpoint) => checkpoint.promise)).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), boundedMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      for (const checkpoint of relevant) checkpoint.controller.abort();
    }
  })();
  bySession.set(sessionKey, work);
  while (bySession.size > 8) bySession.delete(bySession.keys().next().value!);
  endingSessions.set(agent, bySession);
  return work;
}
