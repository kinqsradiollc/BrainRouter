/**
 * DESK-1 — agent-host core: the pure command router between the protocol and
 * the agent runtime. `host.ts` is a thin bootstrap that builds the REAL agent
 * (same loadConfig / McpClientPool / Agent as the CLI — that's the
 * settings-reuse contract) and hands it here; tests hand in a fake. No
 * Electron imports in this file, so the whole router is unit-testable.
 *
 * DESK-5v — CONCURRENT SESSIONS. The host keeps a POOL of agents keyed by
 * sessionKey instead of one mutable agent. Switching sessions no longer stops
 * the turn you were running: the running session keeps its own agent (and keeps
 * streaming, tagged with its sessionKey) while the session you switch to gets
 * its own agent. You can start a turn in the new session while the first is
 * still going — work on several chats at once, the way you would with several
 * terminals. Memory stays bounded: the pool only holds sessions that are
 * actually running plus the one you're viewing; a finished background agent is
 * dropped (its result is on disk, re-read on switch-back).
 *
 * When no `spawnAgent` factory is supplied (unit tests), the core degrades to
 * the original single-agent behavior — including interrupt-and-defer for a
 * switch requested mid-turn — because one agent can't safely run two turns.
 */
import {
  createCallbackBridge,
  InteractionBroker,
  isAgentCommand,
  type AgentCommand,
  type AgentEvent,
  type AgentEventMessage,
  type AgentImage,
  type InteractionResponse,
} from '@kinqs/brainrouter-agent-protocol';
import {
  InputQueue,
  drainExternalSteering,
  pendingCompletionCount,
  peekCompletions,
  subscribeCompletions,
  subscribeExternalSteering,
  type SteeringInput,
} from '@kinqs/brainrouter-core/session';
import { buildChildResumePrompt } from '@kinqs/brainrouter-core/util';

/**
 * The slice of the CLI Agent the host needs — structural, so tests can fake
 * it. `callbacks` is deliberately `any`: the real Agent declares the stricter
 * `RunTurnCallbacks`, and a structural supertype here would be contravariant-
 * incompatible with it.
 */
export interface AgentLike {
  sessionKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runTurn(prompt: string, callbacks: any, opts?: { hiddenPrompt?: boolean; images?: AgentImage[]; preplanned?: boolean }): Promise<string>;
  /** DESK-2 — cooperative stop; the turn unwinds at the next boundary. */
  requestInterrupt?(): void;
  requestSteer?(text: string, options?: { id?: string; source?: SteeringInput['source'] }): SteeringInput;
  consumePendingSteering?(): SteeringInput[];
  readonly pendingSteeringCount?: number;
  // DESK-3 — session lifecycle + model control (all present on the real Agent).
  clearHistory?(): void;
  resetSessionCounters?(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadHistory?(entries: any[]): number;
  setModel?(model: string): void;
  /** Per-session provider switch — rebuild the whole LLM config (provider/model/
   *  endpoint/key), not just the model string. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setLLMConfig?(config: any): void;
  getModel?(): string;
  /** DESK-4 — cumulative session token usage (mirrors the CLI's /tokens). */
  sessionUsage?: { promptTokens: number; completionTokens: number; calls: number; turns: number; cachedTokens?: number };
}

/** Named read-only queries the renderer can issue (sessions list, recap, …). */
export type QueryHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

/**
 * A brand-new chat's transcript isn't written to disk until its first turn, so
 * its `<workspaceHash>:new-…` key has no transcript yet. Resuming such a key
 * must self-heal (create the empty session) rather than hard-error — whereas a
 * missing transcript for a SAVED key is a real error. `applyNew` mints keys as
 * `<hash>:new-<base36 ts>`, so the session-name segment (after the first ':')
 * starting with `new-` is the unsaved-new marker.
 */
export function isUnsavedNewSessionKey(key: string): boolean {
  const seg = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  return seg.startsWith('new-');
}

/**
 * DESK-3 — InteractionPort backed by the broker: agent approval/choice asks
 * become `interaction-request` events; the renderer answers with an
 * `interaction-response` command. 5-minute timeout → dismissed → the agent's
 * fail-closed paths (deny / decide-yourself) fire instead of hanging.
 */
export function createBrokerPort(
  broker: InteractionBroker,
  emit: (event: { kind: 'interaction-request'; request: import('@kinqs/brainrouter-agent-protocol').InteractionRequest }) => void,
  timeoutMs = 300_000,
) {
  return {
    async confirm(req: { title: string; detail?: string; dangerous?: boolean; tool?: string }): Promise<boolean> {
      const { request, response } = broker.request({ type: 'confirm', ...req }, { timeoutMs });
      emit({ kind: 'interaction-request', request });
      const r = await response;
      return r.type === 'confirm' ? r.approved : false;
    },
    async choice(req: { question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect?: boolean }): Promise<string[] | null> {
      const { request, response } = broker.request({ type: 'choice', ...req }, { timeoutMs });
      emit({ kind: 'interaction-request', request });
      const r = await response;
      return r.type === 'choice' ? r.labels : null;
    },
  };
}

export interface HostCore {
  /** Feed one decoded wire message in; invalid shapes are ignored (logged via status). */
  handle(message: unknown): Promise<void>;
  /** Pending interaction count (exposed for tests + drain-on-shutdown). */
  readonly broker: InteractionBroker;
}

/** One pooled agent and whether it currently has a turn in flight. */
interface Runtime {
  agent: AgentLike;
  running: boolean;
  queue: InputQueue;
  /**
   * DESK-6t — LAZY HISTORY: when a session is resumed for VIEWING, its full
   * transcript is NOT loaded into the agent (which is the expensive part — it
   * blocked the message loop and made clicking a chat feel stuck). Instead the
   * key is parked here and the history is loaded on the FIRST turn (when the
   * user actually sends a message and LLM latency hides the cost).
   */
  pendingHistoryKey?: string;
}

export function createHostCore(input: {
  /** The initial/foreground agent; seeds the pool under its sessionKey. */
  agent: AgentLike;
  /**
   * DESK-5v — build a fresh agent for a session OTHER than the one currently
   * running, so two sessions can run at once. Omitted in unit tests → the core
   * stays single-agent (a mid-turn switch interrupts-and-defers as before).
   */
  spawnAgent?: (sessionKey: string) => AgentLike;
  /** DESK-5v — notified whenever the viewed/active agent changes, so the host's
   * read-only queries can report the agent the user is actually looking at. */
  onActiveAgentChange?: (agent: AgentLike) => void;
  send: (msg: AgentEventMessage) => void;
  /**
   * Verification scoping — observe EVERY event a main-session turn emits, tagged
   * with the turn's own sessionKey (so it stays correct even after the user
   * switches away). The host uses this to surface build/test/typecheck/lint
   * commands as durable `verification` background tasks scoped to the workspace
   * that ran them. Best-effort: a throw here must never break the turn.
   */
  observeTurnEvent?: (sessionKey: string, event: AgentEvent) => void;
  queries?: Record<string, QueryHandler>;
  /** DESK-3 — load a persisted transcript (FULL) — for agent continuation only. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadTranscript?: (sessionKey: string) => any[];
  /** OOM-safe — cheap O(1) existence check used by lazy resume to avoid a full
   *  transcript read just to compute "are there messages to render". */
  transcriptExists?: (sessionKey: string) => boolean;
  /** DESK-3 — persist a model choice into the shared config.json (GLOBAL default). */
  persistModel?: (model: string) => void;
  /** Item 10 — the model stored for a SPECIFIC session (per-session override),
   *  applied when that session's agent is (re)spawned so it keeps its own model. */
  getSessionModel?: (sessionKey: string) => string | undefined;
  /** Item 10 — persist a model choice for THIS session only (sessionRuntimeStore),
   *  not the global config. Used when set-model arrives with persist:false. */
  setSessionModel?: (sessionKey: string, model: string) => void;
  /** Clear a stale per-session model override when the user intentionally picks
   *  a GLOBAL default for the active chat. */
  clearSessionModel?: (sessionKey: string) => void;
  /** Per-session provider+model: persist the full runtime override (no secret). */
  setSessionLlm?: (sessionKey: string, patch: { provider?: string; model?: string; endpoint?: string }) => void;
  /** Resolve a saved connection (by name) + chosen model to a full LLM config
   *  (incl. key) so the active agent can be rebuilt for a cross-provider pick. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveProviderLlm?: (providerName: string, model: string) => Promise<any | undefined> | any | undefined;
  /** Full per-session LLM (provider/model/endpoint + key) for a session switch. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveSessionLlm?: (sessionKey: string) => any | undefined;
  /** Set the GLOBAL default from a named connection + chosen model. */
  persistProviderModel?: (providerName: string, model: string) => void;
  /** DESK-3 — share the broker with the agent's InteractionPort adapter. */
  broker?: InteractionBroker;
  /** Called on `shutdown` after pending interactions are dismissed. */
  onShutdown?: () => void;
  /** Fail-closed policy check immediately before a turn starts. Returning a
   * message blocks execution and surfaces that recovery prompt to the user. */
  validateTurn?: (sessionKey: string) => Promise<string | null> | string | null;
}): HostCore {
  const broker = input.broker ?? new InteractionBroker();

  // One shared, monotonic seq across every session stream — the renderer can
  // rely on global ordering; each event still carries its own sessionKey.
  let seq = 0;
  const stamp = (sessionKey: string, event: AgentEvent): void =>
    input.send({ seq: ++seq, ts: Date.now(), sessionKey, event });

  // DESK-5v — the agent pool. Seeded with the initial agent; grows only with
  // sessions that are running or being viewed.
  const pool = new Map<string, Runtime>();
  pool.set(input.agent.sessionKey, { agent: input.agent, running: false, queue: new InputQueue() });
  let activeKey = input.agent.sessionKey;

  // Control/status events (interrupt notices, model changes) belong to whatever
  // session the user is currently looking at.
  const emit = (event: AgentEvent): void => stamp(activeKey, event);

  function setActive(key: string): void {
    activeKey = key;
    const rt = pool.get(key);
    if (rt) input.onActiveAgentChange?.(rt.agent);
  }

  // DESK-5q (retained for the single-agent path) — a switch requested while the
  // ONLY agent is busy is queued here and applied once its turn unwinds.
  let pendingSwitch: (() => void) | null = null;

  let deliverySequence = 0;
  const nextDeliveryId = (): string => `delivery-${Date.now().toString(36)}-${++deliverySequence}`;

  async function startTurnForKey(
    key: string,
    prompt: string,
    hidden?: boolean,
    images?: AgentImage[],
    delivery?: { id: string; mode: 'queue' | 'steer'; source: SteeringInput['source'] },
  ): Promise<void> {
    const rt = pool.get(key);
    if (!rt) { stamp(key, { kind: 'turn-error', message: 'No active session to run in.' }); return; }
    if (rt.running) {
      stamp(key, { kind: 'turn-error', message: 'A turn is already running in this session.' });
      return;
    }
    // Reserve the session before an async policy refresh so a second send cannot
    // race through validation and start another turn.
    rt.running = true;
    try {
      const policyError = input.validateTurn ? await input.validateTurn(key) : null;
      if (policyError) { rt.running = false; stamp(key, { kind: 'turn-error', message: policyError }); return; }
    } catch (error) {
      rt.running = false;
      stamp(key, { kind: 'turn-error', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    // DESK-6t — LAZY HISTORY lands here: if this session was resumed for viewing
    // and never loaded into the agent, load its transcript NOW (before the turn)
    // so the model has the full conversation. Hidden behind LLM latency.
    if (rt.pendingHistoryKey) {
      const entries = input.loadTranscript?.(rt.pendingHistoryKey) ?? [];
      if (entries.length) rt.agent.loadHistory?.(entries);
      rt.pendingHistoryKey = undefined;
    }
    // Capture the session this turn belongs to: the user may switch away while
    // it runs, but every event it emits stays tagged with ITS key so the
    // renderer routes it to the right chat (and never the one now on screen).
    const sk = rt.agent.sessionKey;
    const turnEmit = (event: AgentEvent): void => {
      // Verification scoping — let the host see this turn's tool stream (tagged
      // with the turn's own sessionKey) to track build/test/lint as durable
      // tasks; never let an observer error break the turn.
      try { input.observeTurnEvent?.(sk, event); } catch { /* advisory */ }
      stamp(sk, event);
    };
    const turnCallbacks = createCallbackBridge(turnEmit) as unknown as Record<string, unknown>;
    if (delivery) turnEmit({ kind: 'input-delivery', id: delivery.id, mode: delivery.mode, state: 'running', text: prompt, source: delivery.source });
    turnEmit({ kind: 'turn-start', prompt });
    try {
      const answer = await rt.agent.runTurn(prompt, turnCallbacks, { hiddenPrompt: hidden, images });
      turnEmit({ kind: 'turn-complete', answer });
      if (delivery) turnEmit({ kind: 'input-delivery', id: delivery.id, mode: delivery.mode, state: 'completed', text: prompt, source: delivery.source });
      const u = rt.agent.sessionUsage;
      if (u) turnEmit({ kind: 'tokens-updated', promptTokens: u.promptTokens, completionTokens: u.completionTokens, calls: u.calls, turns: u.turns, cachedTokens: u.cachedTokens });
    } catch (err) {
      turnEmit({ kind: 'turn-error', message: err instanceof Error ? err.message : String(err) });
      if (delivery) turnEmit({ kind: 'input-delivery', id: delivery.id, mode: delivery.mode, state: 'canceled', text: prompt, source: delivery.source });
    } finally {
      rt.running = false;
      // A steer accepted during late turn-finalization missed the last model
      // boundary. Convert it into a normal queued follow-up instead of losing it.
      for (const pending of rt.agent.consumePendingSteering?.() ?? []) {
        const queued = rt.queue.enqueue(pending.text, {
          deliveryId: pending.id,
          deliveryMode: 'steer',
          deliverySource: pending.source,
        });
        turnEmit({
          kind: 'input-delivery',
          id: pending.id,
          mode: 'steer',
          state: 'queued',
          text: pending.text,
          position: queued.position,
          source: pending.source,
        });
      }
      const next = rt.queue.dequeue();
      // A finished BACKGROUND agent (not the one on screen) is disposable — its
      // result is persisted to the transcript and re-read on switch-back. Drop
      // it so the pool can't grow without bound. Only spawned agents are dropped;
      // the single shared agent of the no-factory path is never evicted.
      if (sk !== activeKey && input.spawnAgent && !next) pool.delete(sk);
      // Single-agent path: a switch was deferred until this turn ended.
      if (pendingSwitch) { const fn = pendingSwitch; pendingSwitch = null; fn(); }
      // WS1 — a detached child/worker may have finished mid-turn; fold its result
      // in now (idle) instead of waiting for the user's next prompt.
      maybeScheduleResume();
      if (next) {
        setImmediate(() => {
          void startTurnForKey(sk, next.text, false, undefined, {
            id: next.deliveryId ?? nextDeliveryId(),
            mode: next.deliveryMode ?? 'queue',
            source: next.deliverySource ?? 'user',
          });
        });
      }
    }
  }

  async function startTurn(prompt: string, hidden?: boolean, images?: AgentImage[]): Promise<void> {
    await startTurnForKey(activeKey, prompt, hidden, images);
  }

  async function deliverInput(
    prompt: string,
    mode: 'immediate' | 'queue' | 'steer',
    hidden?: boolean,
    images?: AgentImage[],
    requestedId?: string,
  ): Promise<void> {
    const key = activeKey;
    const rt = pool.get(key);
    if (!rt) { emit({ kind: 'turn-error', message: 'No active session to run in.' }); return; }
    if (!rt.running) {
      await startTurnForKey(key, prompt, hidden, images, mode === 'immediate'
        ? undefined
        : { id: requestedId?.trim() || nextDeliveryId(), mode, source: 'user' });
      return;
    }
    const id = requestedId?.trim() || nextDeliveryId();
    if (mode === 'queue') {
      const queued = rt.queue.enqueue(prompt, {
        deliveryId: id,
        deliveryMode: 'queue',
        deliverySource: 'user',
      });
      stamp(key, { kind: 'input-delivery', id, mode, state: 'queued', text: prompt, position: queued.position, source: 'user' });
      return;
    }
    if (mode === 'steer') {
      if (!rt.agent.requestSteer) {
        stamp(key, { kind: 'turn-error', message: 'This agent runtime does not support steering.' });
        return;
      }
      rt.agent.requestSteer(prompt, { id, source: 'user' });
      stamp(key, { kind: 'input-delivery', id, mode, state: 'steered', text: prompt, source: 'user' });
      return;
    }
    emit({ kind: 'turn-error', message: 'A turn is already running. Choose Queue or Steer.' });
  }

  // WS1 — auto-resume the active session when detached background work (a
  // fire-and-forget delegate_agent child or a worker) finishes while the session
  // is IDLE, so the user no longer has to send a second prompt to fold the result
  // in. The resumed turn drains the completion inbox at its top (the normal path),
  // so this only needs to TRIGGER a turn. Debounced so a quick user message
  // preempts it; scoped to the on-screen session (a background session still
  // delivers its result the moment the user switches back to it).
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  function cancelResume(): void { if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; } }
  function maybeScheduleResume(): void {
    const rt = pool.get(activeKey);
    if (!rt || rt.running || resumeTimer) return;
    if (pendingCompletionCount(activeKey) === 0) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      const r = pool.get(activeKey);
      if (!r || r.running || pendingCompletionCount(activeKey) === 0) return;
      const ids = peekCompletions(activeKey).map((c) => c.id);
      emit({ kind: 'status', text: '🎯 Background work finished — continuing…' });
      void startTurn(buildChildResumePrompt(ids), true);
    }, 1500);
  }
  const unsubscribeCompletions = subscribeCompletions((parentKey) => { if (parentKey === activeKey) maybeScheduleResume(); });

  /**
   * PR-OBS-1 — extension results use the same delivery semantics as a human
   * Steer. A running session receives them at its next safe model boundary; an
   * idle pooled session starts an extension-labelled follow-up. Events for an unloaded
   * session remain in the core inbox until that session is focused again.
   */
  function deliverExternalSteeringForKey(key: string): void {
    const rt = pool.get(key);
    if (!rt) return;
    const events = drainExternalSteering(key);
    if (!events.length) return;
    if (rt.running && rt.agent.requestSteer) {
      for (const event of events) {
        rt.agent.requestSteer(event.text, { id: event.id, source: 'extension' });
        stamp(key, {
          kind: 'input-delivery',
          id: event.id,
          mode: 'steer',
          state: 'steered',
          text: event.text,
          source: 'extension',
        });
      }
      return;
    }
    for (const event of events) {
      const queued = rt.queue.enqueue(event.text, {
        deliveryId: event.id,
        deliveryMode: 'steer',
        deliverySource: 'extension',
      });
      stamp(key, {
        kind: 'input-delivery',
        id: event.id,
        mode: 'steer',
        state: 'queued',
        text: event.text,
        position: queued.position,
        source: 'extension',
      });
    }
    if (!rt.running) {
      const next = rt.queue.dequeue();
      if (next) {
        setImmediate(() => {
          void startTurnForKey(key, next.text, false, undefined, {
            id: next.deliveryId ?? nextDeliveryId(),
            mode: 'steer',
            source: 'extension',
          });
        });
      }
    }
  }

  const unsubscribeExternalSteering = subscribeExternalSteering(deliverExternalSteeringForKey);

  /**
   * Acquire a runtime to host `targetKey`. Reuses the currently-viewed agent
   * when it's idle (no need to spawn); otherwise spawns a fresh one. Returns
   * null only when the viewed agent is busy AND there's no spawn factory — the
   * single-agent path, which the caller handles by deferring.
   */
  function acquireRuntime(): Runtime | null {
    const cur = pool.get(activeKey);
    if (cur && !cur.running) { pool.delete(activeKey); return cur; }
    if (input.spawnAgent) return { agent: input.spawnAgent(activeKey), running: false, queue: new InputQueue() };
    return null;
  }

  /** Switch the viewed session to `targetKey`, loading it via `init`. Never
   *  stops a running turn (it keeps going in the pool, in the background). */
  function focusOrCreate(targetKey: string, init: (rt: Runtime) => number): void {
    // Already pooled — i.e. running in the background, or the active one. Just
    // refocus; the renderer reloads the view from the (on-disk) transcript.
    const existing = pool.get(targetKey);
    if (existing) {
      setActive(targetKey);
      // OOM-safe: sentinel (1 = "has history to render", 0 = empty) via the cheap
      // existence check — the renderer fetches the real rows via the bounded
      // transcript query. Avoids a full read just to refocus.
      const count = input.transcriptExists ? (input.transcriptExists(targetKey) ? 1 : 0) : (input.loadTranscript?.(targetKey)?.length ?? 1);
      // Authoritative running state — the renderer reconciles its own per-session
      // flag against this so a resumed chat never shows a stale "working…" spinner
      // (a dropped turn-complete used to leave the flag stuck forever).
      stamp(targetKey, { kind: 'session-changed', sessionKey: targetKey, loadedMessages: count, model: existing.agent.getModel?.() ?? '', running: existing.running });
      deliverExternalSteeringForKey(targetKey);
      return;
    }
    const rt = acquireRuntime();
    if (!rt) {
      // Single-agent path, agent busy: preserve the safe interrupt-and-defer.
      pendingSwitch = () => focusOrCreate(targetKey, init);
      pool.get(activeKey)?.agent.requestInterrupt?.();
      broker.dismissAll();
      emit({ kind: 'status', text: `Stopping the current turn to switch to ${targetKey}…` });
      return;
    }
    rt.agent.sessionKey = targetKey;
    rt.agent.resetSessionCounters?.();
    // A runtime can be reused after viewing a lazily-resumed session whose
    // transcript has not been loaded yet. That pending history belongs to the
    // old session; clear it before retargeting so a fresh chat cannot ingest the
    // previous transcript on its first turn.
    rt.pendingHistoryKey = undefined;
    // Item 10 — restore this session's per-session runtime (if any) so a resumed/
    // backgrounded chat keeps the provider+model it was set to, independent of the
    // global default and of whatever the previous agent in this slot was using.
    // Prefer the full LLM (handles a cross-provider override + its key); fall back
    // to the model string alone.
    const sessLlm = input.resolveSessionLlm?.(targetKey);
    if (sessLlm) rt.agent.setLLMConfig?.(sessLlm);
    else {
      const sessModel = input.getSessionModel?.(targetKey);
      if (sessModel) rt.agent.setModel?.(sessModel);
    }
    const loaded = init(rt);
    pool.set(targetKey, rt);
    setActive(targetKey);
    deliverExternalSteeringForKey(targetKey);
    // A freshly-acquired runtime is never mid-turn → running:false reconciles
    // away any stale renderer flag for this key.
    stamp(targetKey, { kind: 'session-changed', sessionKey: targetKey, loadedMessages: loaded, model: rt.agent.getModel?.() ?? '', running: rt.running });
  }

  function applyResume(sessionKey: string): void {
    // An already-pooled (running) session refocuses without touching history.
    if (!pool.has(sessionKey)) {
      // OOM-safe: cheap existence check, NOT a full transcript read, just to
      // decide whether there's anything to render (huge sessions used to be
      // fully read here on every resume → heap OOM).
      const exists = input.transcriptExists
        ? input.transcriptExists(sessionKey)
        : ((input.loadTranscript?.(sessionKey)?.length ?? 0) > 0);
      if (!exists) {
        // A brand-new chat (its transcript isn't written until the first turn)
        // self-heals: create the empty session here so a turn can then write it,
        // instead of the confusing `No transcript found for "<hash>:new-…"`.
        if (isUnsavedNewSessionKey(sessionKey)) {
          focusOrCreate(sessionKey, (rt) => { rt.agent.clearHistory?.(); return 0; });
          return;
        }
        emit({ kind: 'turn-error', message: `No transcript found for "${sessionKey}".` });
        return;
      }
      // DESK-6t — LAZY: do NOT loadHistory now (the expensive replay). Park the
      // key; the first turn loads it. Resume just renders the (bounded) transcript;
      // loadedMessages=1 is a sentinel — the real rows come from q-transcript.
      focusOrCreate(sessionKey, (rt) => { rt.pendingHistoryKey = sessionKey; return 1; });
      return;
    }
    focusOrCreate(sessionKey, () => 0);
  }

  function applyNew(label?: string): void {
    const safe = (label ?? `new-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9._-]+/g, '-');
    const targetKey = `${activeKey.split(':')[0]}:${safe}`;
    focusOrCreate(targetKey, (rt) => { rt.agent.clearHistory?.(); return 0; });
  }

  async function handle(message: unknown): Promise<void> {
    if (!isAgentCommand(message)) return; // tolerate noise on the wire
    const cmd = message as AgentCommand;
    switch (cmd.kind) {
      case 'start-turn':
        cancelResume(); // a real user prompt preempts any queued auto-resume
        await deliverInput(cmd.prompt, cmd.delivery ?? 'immediate', cmd.hidden, cmd.images, cmd.deliveryId);
        return;
      case 'interrupt': {
        cancelResume(); // user stopped — never auto-resume on top of a stop
        // DESK-2 — cooperative stop of the VIEWED session's turn: flag its agent
        // (it unwinds at the next LLM/tool boundary) AND dismiss pending
        // approvals so a turn blocked on a dialog fails closed instead of hanging.
        pool.get(activeKey)?.agent.requestInterrupt?.();
        const dismissed = broker.dismissAll();
        emit({ kind: 'status', text: `Interrupt requested${dismissed ? ` — dismissed ${dismissed} pending approval(s)` : ''}.` });
        return;
      }
      case 'interaction-response': {
        const ok = broker.resolve(cmd.id, cmd.response as InteractionResponse);
        if (!ok) emit({ kind: 'status', text: `Stale interaction response ignored (${cmd.id}).` });
        return;
      }
      case 'query': {
        const handler = input.queries?.[cmd.name];
        if (!handler) {
          emit({ kind: 'query-result', id: cmd.id, ok: false, error: `Unknown query "${cmd.name}".` });
          return;
        }
        try {
          const result = await handler(cmd.args ?? {});
          emit({ kind: 'query-result', id: cmd.id, ok: true, result });
        } catch (err) {
          emit({ kind: 'query-result', id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      case 'new-session': {
        const label = (cmd.label ?? '').trim() || undefined;
        applyNew(label);
        return;
      }
      case 'resume-session': {
        applyResume(cmd.sessionKey);
        return;
      }
      case 'set-model': {
        const a = pool.get(activeKey)?.agent;
        if (cmd.model === 'auto') {
          try { input.clearSessionModel?.(activeKey); } catch { /* best effort */ }
          emit({ kind: 'status', text: 'Model set to Auto (primary chain).' });
          emit({ kind: 'session-changed', sessionKey: activeKey, loadedMessages: -1, model: cmd.model });
          return;
        }
        // Item 10 — persist:true → GLOBAL default (config.json, shared with the
        // CLI). persist:false → THIS SESSION ONLY (sessionRuntimeStore), so it
        // survives a respawn for this chat without changing every other chat.
        // A `providerName` means a CROSS-PROVIDER pick: rebuild the agent's whole
        // LLM (provider/model/endpoint/key) and write the full session override
        // (never the global default unless persist) — so it never syncs to others.
        const full = cmd.providerName ? await input.resolveProviderLlm?.(cmd.providerName, cmd.model) : undefined;
        if (cmd.providerName && !full) {
          emit({ kind: 'turn-error', message: `The selected provider or model “${cmd.model}” is unavailable. Refresh Models and choose again.` });
          return;
        }
        if (full) a?.setLLMConfig?.(full); else a?.setModel?.(cmd.model);
        if (cmd.persist) {
          try {
            if (cmd.providerName) input.persistProviderModel?.(cmd.providerName, cmd.model);
            else input.persistModel?.(cmd.model);
          } catch (err) {
            emit({ kind: 'status', text: `Model switched for this session, but persisting failed: ${err instanceof Error ? err.message : err}` });
            emit({ kind: 'session-changed', sessionKey: activeKey, loadedMessages: -1, model: cmd.model });
            return;
          }
          try { input.clearSessionModel?.(activeKey); } catch { /* global model still persisted */ }
        } else if (cmd.providerName) {
          // Per-session cross-provider override (provider/model/endpoint, no secret).
          try { input.setSessionLlm?.(activeKey, { provider: full?.provider, model: cmd.model, endpoint: full?.endpoint }); } catch { /* in-memory set already applied */ }
        } else {
          try { input.setSessionModel?.(activeKey, cmd.model); } catch { /* in-memory set already applied */ }
        }
        emit({ kind: 'status', text: `Model set to ${cmd.model}${cmd.persist ? ' (saved to config.json — shared with the CLI)' : ' (this chat only)'}.` });
        emit({ kind: 'session-changed', sessionKey: activeKey, loadedMessages: -1, model: cmd.model });
        return;
      }
      case 'shutdown':
        cancelResume();
        unsubscribeCompletions();
        unsubscribeExternalSteering();
        broker.dismissAll();
        input.onShutdown?.();
        return;
    }
  }

  return { handle, broker };
}
