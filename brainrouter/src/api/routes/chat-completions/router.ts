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
// Upstream LLM: the caller's org DB-configured LLM provider (ADR-012), resolved
// per request from the DB — falls back to the system org, never `.env`.
// We forward streaming requests as Server-Sent Events back to the client.

import { Router, type Response } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { DEFAULT_UPSTREAM_ENDPOINT, type IncomingBody } from "./types.js";
import { resolveProviderConfig } from "../../../providers/resolver.js";
import { systemProviderOrgId } from "../../../providers/runtime.js";
import { resolveOrgContext } from "../../../tenancy/context.js";
import {
  flattenContent,
  buildBriefingMessage,
  fetchBriefing,
  getMemoryStatusForUser,
  pickLastUserText,
} from "./briefing.js";
import { captureTurn } from "./capture.js";
import { parseAndFormatThink } from "./reasoning.js";
import { streamUpstream } from "./streaming.js";

export const chatCompletionsRouter = Router();
chatCompletionsRouter.use(requireAnyAuth);

/**
 * ADR-012 — resolve the upstream LLM from the DB provider config: the caller's
 * org first, then the system org. Returns null when neither has an LLM provider
 * (→ 503; configure one in the dashboard). Never reads `.env`.
 */
async function resolveUpstreamLlm(userId: string): Promise<{ endpoint: string; apiKey: string; model: string } | null> {
  let orgId = systemProviderOrgId();
  try {
    const ctx = await resolveOrgContext(memoryEngine.tenancy, userId);
    if (ctx?.orgId) orgId = ctx.orgId;
  } catch { /* fall back to the system org */ }
  const p = await resolveProviderConfig(memoryEngine.providers, orgId, "llm");
  if (!p?.apiKey) return null;
  return { endpoint: p.endpoint || DEFAULT_UPSTREAM_ENDPOINT, apiKey: p.apiKey, model: p.model };
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

  // 2. Forward to upstream — the DB-resolved LLM provider (ADR-012).
  const provider = await resolveUpstreamLlm(userId);
  if (!provider) {
    res.status(503).json({
      error: {
        message: "No LLM provider is configured. Add one in the dashboard → AI Providers (or POST /api/admin/providers).",
      },
    });
    return;
  }

  const upstreamPayload: Record<string, unknown> = {
    model: body.model ?? provider.model ?? "gpt-4o-mini",
    messages: outboundMessages.map((m) => ({ role: m.role, content: flattenContent(m.content), name: m.name })),
    stream: Boolean(body.stream),
  };
  if (typeof body.temperature === "number") upstreamPayload.temperature = body.temperature;
  if (typeof body.max_tokens === "number") upstreamPayload.max_tokens = body.max_tokens;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(provider.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
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
  const choice = json?.choices?.[0];
  if (choice?.message) {
    const msg = choice.message;
    const reasoning = msg.reasoning_content ?? msg.reasoning;
    if (reasoning && typeof reasoning === "string" && reasoning.length > 0) {
      const originalContent = msg.content ?? "";
      msg.content = `<details>\n<summary>Work Section (Reasoning)</summary>\n\n${reasoning.trim()}\n</details>\n\n${originalContent.trim()}`;
      delete msg.reasoning_content;
      delete msg.reasoning;
    } else if (typeof msg.content === "string") {
      msg.content = parseAndFormatThink(msg.content);
    }
  }

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
chatCompletionsRouter.get("/memory-status", async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  res.json(await getMemoryStatusForUser(userId));
});

// Minimal /v1/models so OpenAI SDK clients that list models don't 404.
chatCompletionsRouter.get("/models", async (req: AuthedRequest, res: Response) => {
  const provider = await resolveUpstreamLlm(req.userId ?? "").catch(() => null);
  const defaultModel = provider?.model || "gpt-4o-mini";
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
