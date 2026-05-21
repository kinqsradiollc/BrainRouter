// OpenAI-compatible /v1/chat/completions endpoint, memory-augmented.
//
// What this gives us:
//   - The MCP server speaks the OpenAI Chat Completions wire format so any
//     OpenAI SDK or fetch-based client (the BrainRouter web chat, third-party
//     tools, the CLI itself) can use it transparently.
//   - Before forwarding the request to the upstream LLM, we run BrainRouter
//     memory_recall and memory_working_context for the user and inject a
//     compact "## BrainRouter Memory Briefing" system message at the front
//     of the messages array. The user gets their own memory without lifting
//     a finger — the entire point of building this.
//   - After the upstream completes (streaming or not), we capture the turn
//     via memoryEngine.capture(...). This is what makes System-2 learn over
//     time.
//
// Auth: same Bearer header convention as the rest of the API
// (memory API key OR JWT, via requireAnyAuth).
//
// Upstream LLM: same env-driven config as the rest of the engine
// (BRAINROUTER_LLM_ENDPOINT / BRAINROUTER_LLM_API_KEY / BRAINROUTER_LLM_MODEL).
// We forward streaming requests as Server-Sent Events back to the client.

import { Router, type Response } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";

export const chatCompletionsRouter = Router();
chatCompletionsRouter.use(requireAnyAuth);

const DEFAULT_UPSTREAM_ENDPOINT =
  process.env.BRAINROUTER_LLM_ENDPOINT ?? "https://api.openai.com/v1/chat/completions";

interface IncomingMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string }>;
  name?: string;
}

interface IncomingBody {
  model?: string;
  messages: IncomingMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** BrainRouter-specific extensions. Optional; the endpoint stays OpenAI-shape if these are omitted. */
  brainrouter?: {
    sessionKey?: string;
    workspacePath?: string;
    activeSkill?: string;
    /** When false, the briefing system message is not injected. Useful for raw passthrough tests. */
    inject_briefing?: boolean;
    /**
     * Capture mode for the user+assistant exchange:
     *   "off"     — do nothing. Stateless chat.
     *   "sensory" — (default) write a sensory row only. No upstream LLM call.
     *               Backlogged extraction can be triggered explicitly later.
     *   "full"    — full memoryEngine.capture(): may invoke cognitive
     *               extraction, contradiction detection, persona distillation,
     *               and graph extraction. EACH of those can fire its own LLM
     *               call, so a single user turn can produce many upstream
     *               requests. Opt-in only — that's what was being reported as
     *               "requests keep coming nonstop."
     * Legacy boolean field `capture_turn` is honoured for back-compat:
     *   capture_turn === false maps to "off".
     */
    capture_mode?: "off" | "sensory" | "full";
    capture_turn?: boolean;
  };
}

function flattenContent(content: IncomingMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? part.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

function buildBriefingMessage(briefing: string, sessionKey: string): IncomingMessage {
  return {
    role: "system",
    content: [
      "## BrainRouter Memory Briefing",
      `Session: ${sessionKey}`,
      "",
      briefing.trim(),
      "",
      "Cite the IDs of records you actually used in your reasoning.",
    ].join("\n"),
  };
}

/**
 * Multi-source briefing. Pull whatever the BrainRouter brain already knows
 * about the authenticated user and stitch it into one compact system message.
 *
 * Sources (each is best-effort; missing sources are silently skipped):
 *   - Core identity / persona (cross-session — this is the big cross-session win)
 *   - Top focus scenes (what the user has been working on lately)
 *   - Cognitive recall against the current query
 *   - Working memory canvas for the current session
 *
 * recall is already user-scoped at the FTS layer, so memories from CLI
 * sessions surface here too — provided extraction has run on those sessions.
 */
async function fetchBriefing(
  userId: string,
  sessionKey: string,
  query: string,
  activeSkill?: string,
): Promise<string> {
  const sections: string[] = [];

  // 1. Persona (cross-session identity).
  try {
    const persona = memoryEngine.getPersona(userId);
    const personaMd = (persona as any)?.personaMd?.toString().trim();
    if (personaMd) {
      sections.push(`### Who I'm talking to (core identity)\n${personaMd.slice(0, 1600)}`);
    }
  } catch (err) {
    console.error("[BrainRouter:/v1] persona briefing failed:", err);
  }

  // 2. Recent focus scenes.
  try {
    const scenes = memoryEngine.getTopScenes(userId, 3);
    if (Array.isArray(scenes) && scenes.length > 0) {
      const lines: string[] = ["### Recent focus scenes (what they've been working on)"];
      for (const s of scenes) {
        const heatScore = (s as any).heatScore ?? "";
        const name = (s as any).sceneName ?? "";
        const summary = ((s as any).summary ?? "").toString().replace(/\s+/g, " ").slice(0, 220);
        if (name) lines.push(`- ${name}${heatScore !== "" ? ` · heat ${Number(heatScore).toFixed(2)}` : ""}: ${summary}`);
      }
      if (lines.length > 1) sections.push(lines.join("\n"));
    }
  } catch (err) {
    console.error("[BrainRouter:/v1] scenes briefing failed:", err);
  }

  // 3. Cognitive recall against the query (FTS + vector + graph).
  const recalledIds = new Set<string>();
  try {
    const recall = await memoryEngine.recall({ userId, sessionKey, query, activeSkill });
    const records = (recall as any)?.recalledCognitiveRecords ?? [];
    if (Array.isArray(records) && records.length > 0) {
      const lines: string[] = ["### Recalled cognitive memories for this question"];
      for (const r of records.slice(0, 10)) {
        const id = (r.recordId ?? "").toString();
        if (id) recalledIds.add(id);
        const content = (r.content ?? "").toString().replace(/\s+/g, " ").slice(0, 240);
        lines.push(`- [${id}] (${r.type ?? "memory"}) ${content}`);
      }
      sections.push(lines.join("\n"));
    }
  } catch (err) {
    console.error("[BrainRouter:/v1] recall briefing failed:", err);
  }

  // 4. Recency-based memories — what we've been doing lately even when the
  //    user's query doesn't share keywords with cognitive content. This is
  //    what makes "what did we talk about last time?" / "remind me about the
  //    previous bug" actually work; FTS alone misses them.
  try {
    const recent: any[] = memoryEngine.store.listMemories(userId, { archived: false }, { limit: 8 }) ?? [];
    const deduped = recent.filter((r) => !recalledIds.has((r.recordId ?? "").toString()));
    if (deduped.length > 0) {
      const lines: string[] = ["### Most recent memories (chronological, may or may not match the question)"];
      for (const r of deduped.slice(0, 6)) {
        const id = (r.recordId ?? "").toString();
        const content = (r.content ?? "").toString().replace(/\s+/g, " ").slice(0, 240);
        const when = (r.createdTime ?? "").toString().slice(0, 10);
        lines.push(`- [${id}] (${r.type ?? "memory"}, ${when}) ${content}`);
      }
      sections.push(lines.join("\n"));
    }
  } catch (err) {
    console.error("[BrainRouter:/v1] recency briefing failed:", err);
  }

  return sections.join("\n\n");
}

/** Lightweight per-user memory counts for the chat status badge. */
export function getMemoryStatusForUser(userId: string): {
  cognitive: number;
  scenes: number;
  hasPersona: boolean;
} {
  let cognitive = 0;
  let scenes = 0;
  let hasPersona = false;
  try {
    const stats = memoryEngine.store?.getMemoryStats?.(userId);
    if (stats && typeof stats.total === "number") cognitive = stats.total;
  } catch { /* ignore */ }
  try {
    const list = memoryEngine.getTopScenes(userId, 50) as any[];
    if (Array.isArray(list)) scenes = list.length;
  } catch { /* ignore */ }
  try {
    const p: any = memoryEngine.getPersona(userId);
    hasPersona = Boolean(p?.personaMd?.trim());
  } catch { /* ignore */ }
  return { cognitive, scenes, hasPersona };
}

/**
 * Record the exchange into BrainRouter memory.
 *
 *   mode === "sensory"  → cheap: just store sensory rows. No upstream LLM
 *                          call. This is the default for the web chat so a
 *                          single user message does NOT cascade into
 *                          extraction + contradiction + persona + graph
 *                          requests against the upstream model.
 *   mode === "full"     → full pipeline: cognitive extraction, contradiction
 *                          detection, persona distillation, graph build.
 *                          Multiple upstream LLM calls per turn. Use this
 *                          when the user explicitly asks for deep memory.
 *   mode === "off"      → no-op.
 */
async function captureTurn(
  userId: string,
  sessionKey: string,
  userText: string,
  assistantText: string,
  activeSkill: string | undefined,
  mode: "off" | "sensory" | "full",
): Promise<void> {
  if (mode === "off") return;
  if (!userText || !assistantText) return;
  try {
    if (mode === "sensory") {
      memoryEngine.capturePassiveL0({ userId, sessionKey, role: "user", content: userText, skillTag: activeSkill });
      memoryEngine.capturePassiveL0({ userId, sessionKey, role: "assistant", content: assistantText, skillTag: activeSkill });
      return;
    }
    await memoryEngine.capture({
      userId,
      sessionKey,
      messages: [
        { role: "user", content: userText, timestamp: Date.now() },
        { role: "assistant", content: assistantText, timestamp: Date.now() },
      ],
      activeSkill,
    });
  } catch (err) {
    console.error("[BrainRouter:/v1] capture failed:", err);
  }
}

function pickLastUserText(messages: IncomingMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return flattenContent(messages[i].content);
    }
  }
  return "";
}

function sseLine(data: unknown): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

// Idle watchdog: if the upstream stops sending bytes for this long and we
// haven't received [DONE], we treat the stream as dead and close the client.
// This prevents the "requests keep coming nonstop" symptom that happens when
// an upstream server holds a keep-alive connection open after the SSE body
// is logically complete.
const STREAM_IDLE_TIMEOUT_MS = 30_000;

async function streamUpstream(
  upstreamRes: globalThis.Response,
  clientRes: Response,
  onAssistantText: (chunk: string) => void,
): Promise<void> {
  clientRes.setHeader("Content-Type", "text/event-stream");
  clientRes.setHeader("Cache-Control", "no-cache");
  clientRes.setHeader("Connection", "keep-alive");
  clientRes.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering if proxied
  clientRes.flushHeaders?.();

  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    clientRes.end();
    return;
  }

  let clientClosed = false;
  let upstreamDone = false;
  let idleTimer: NodeJS.Timeout | undefined;

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!upstreamDone) {
        // Abandon the upstream and tell the client we're closing.
        try { void reader.cancel("idle-timeout"); } catch { /* noop */ }
      }
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  // If the browser tab closes mid-stream, the client TCP socket emits 'close'.
  // Cancel the upstream reader so we don't keep pulling bytes from OpenAI.
  clientRes.on("close", () => {
    clientClosed = true;
    if (idleTimer) clearTimeout(idleTimer);
    try { void reader.cancel("client-closed"); } catch { /* noop */ }
  });

  const decoder = new TextDecoder();
  let buffer = "";
  armIdleTimer();
  try {
    for (;;) {
      if (clientClosed) break;
      const { value, done } = await reader.read();
      if (done) break;
      armIdleTimer();
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      // Forward bytes as-is so client SSE parsing works.
      clientRes.write(chunk);
      // Sniff assistant content for capture, and detect [DONE].
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          upstreamDone = true;
          // Explicitly stop reading after [DONE] — some upstreams keep the
          // chunked connection open well past the logical end of the response,
          // which is exactly the case that made the browser appear to "keep
          // requesting" forever.
          try { void reader.cancel("done-sentinel"); } catch { /* noop */ }
          break;
        }
        try {
          const obj = JSON.parse(payload);
          const delta = obj?.choices?.[0]?.delta?.content;
          if (typeof delta === "string") onAssistantText(delta);
        } catch {
          // ignore malformed delta lines
        }
      }
      if (upstreamDone) break;
    }
  } catch (err: any) {
    if (!clientClosed) clientRes.write(sseLine({ error: { message: err?.message || "stream error" } }));
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (!clientClosed) {
      // Always emit a final [DONE] so the client's SSE parser sees a clean end
      // even if the upstream didn't send one.
      if (!upstreamDone) clientRes.write("data: [DONE]\n\n");
      clientRes.end();
    }
  }
}

chatCompletionsRouter.post("/chat/completions", async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const body = (req.body ?? {}) as IncomingBody;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: { message: "messages[] is required" } });
    return;
  }

  const sessionKey =
    body.brainrouter?.sessionKey ??
    (req.headers["x-brainrouter-session"] as string | undefined) ??
    `web:${userId}`;
  const activeSkill = body.brainrouter?.activeSkill;
  const injectBriefing = body.brainrouter?.inject_briefing !== false;
  // Capture mode. Default is "sensory" so a single chat turn NEVER triggers
  // the heavy cognitive cascade (extraction + per-memory contradiction checks +
  // graph build + persona distillation), each of which can fire its own upstream
  // LLM call. That cascade is what was bombarding LM Studio with hundreds of
  // queued requests. Run distillation explicitly via POST /v1/distill instead.
  const captureMode: "off" | "sensory" | "full" =
    body.brainrouter?.capture_mode ??
    (body.brainrouter?.capture_turn === false ? "off" : "sensory");

  const lastUserText = pickLastUserText(body.messages);

  // 1. Build memory briefing.
  let outboundMessages = [...body.messages];
  if (injectBriefing && lastUserText) {
    const briefing = await fetchBriefing(userId, sessionKey, lastUserText, activeSkill);
    if (briefing) {
      // Place briefing immediately after any caller-provided system messages
      // so it travels at the top of context without overwriting persona.
      const insertAt = outboundMessages.findIndex((m) => m.role !== "system");
      const briefMsg = buildBriefingMessage(briefing, sessionKey);
      if (insertAt === -1) outboundMessages.push(briefMsg);
      else outboundMessages.splice(insertAt, 0, briefMsg);
    }
  }

  // 2. Forward to upstream.
  const upstreamApiKey = process.env.BRAINROUTER_LLM_API_KEY;
  if (!upstreamApiKey) {
    res.status(503).json({
      error: {
        message:
          "Upstream LLM not configured. Set BRAINROUTER_LLM_API_KEY on the MCP server (or use the CLI which forwards it automatically).",
      },
    });
    return;
  }

  const upstreamPayload: Record<string, unknown> = {
    model: body.model ?? process.env.BRAINROUTER_LLM_MODEL ?? "gpt-4o-mini",
    messages: outboundMessages.map((m) => ({ role: m.role, content: flattenContent(m.content), name: m.name })),
    stream: Boolean(body.stream),
  };
  if (typeof body.temperature === "number") upstreamPayload.temperature = body.temperature;
  if (typeof body.max_tokens === "number") upstreamPayload.max_tokens = body.max_tokens;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(DEFAULT_UPSTREAM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamApiKey}`,
      },
      body: JSON.stringify(upstreamPayload),
    });
  } catch (err: any) {
    res.status(502).json({ error: { message: `Upstream fetch failed: ${err?.message || err}` } });
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    res.status(upstream.status).json({
      error: { message: `Upstream returned ${upstream.status}: ${text.slice(0, 500)}` },
    });
    return;
  }

  // 3. Stream or buffer.
  if (body.stream) {
    let collected = "";
    await streamUpstream(upstream as any, res, (delta) => { collected += delta; });
    void captureTurn(userId, sessionKey, lastUserText, collected, activeSkill, captureMode);
    return;
  }

  const json = (await upstream.json()) as any;
  const assistantText = json?.choices?.[0]?.message?.content ?? "";
  void captureTurn(userId, sessionKey, lastUserText, String(assistantText), activeSkill, captureMode);
  res.json(json);
});

// ─── Distillation ────────────────────────────────────────────────────────────
// One in-flight cognitive extraction per user at a time. The pipeline cascades
// into contradiction / graph / persona work that each issue their own upstream
// LLM calls; without serialization, two clicks of the "Distill" button (or
// multiple browser tabs) can pile dozens of jobs onto the upstream queue.
const distillInFlight = new Map<string, Promise<unknown>>();

chatCompletionsRouter.post("/distill", async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  if (distillInFlight.has(userId)) {
    res.status(202).json({ status: "already-running", message: "A distillation pass is already in flight for this user. Wait for it to finish." });
    return;
  }
  const sessionKey =
    (req.body?.sessionKey as string | undefined) ??
    (req.headers["x-brainrouter-session"] as string | undefined) ??
    `web:${userId}`;
  const work = (async () => {
    try {
      // capture() with an empty messages array still drains the existing
      // unextracted sensory backlog and runs the threshold check. We DO want
      // the cascade here because the user explicitly asked for it.
      await memoryEngine.capture({ userId, sessionKey, messages: [] });
      return { status: "ok" };
    } catch (err: any) {
      return { status: "error", error: err?.message ?? String(err) };
    }
  })();
  distillInFlight.set(userId, work);
  work.finally(() => distillInFlight.delete(userId));
  const result = await work;
  res.json(result);
});

// Memory-status badge for the web chat: tells the user how much BrainRouter
// already knows about them (cognitive records + scenes + whether persona is
// distilled). Returning 0/0/false is the honest signal that the LLM truly has
// no cross-session context to draw on yet.
chatCompletionsRouter.get("/memory-status", (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  res.json(getMemoryStatusForUser(userId));
});

// Minimal /v1/models so OpenAI SDK clients that list models don't 404.
chatCompletionsRouter.get("/models", (_req: AuthedRequest, res: Response) => {
  const defaultModel = process.env.BRAINROUTER_LLM_MODEL ?? "gpt-4o-mini";
  res.json({
    object: "list",
    data: [
      {
        id: defaultModel,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "brainrouter",
      },
      {
        id: "brainrouter-default",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "brainrouter",
      },
    ],
  });
});
