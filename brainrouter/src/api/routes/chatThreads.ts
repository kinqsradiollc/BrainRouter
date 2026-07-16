/**
 * Chat-threads API — authenticated, org-scoped AND owner-guarded chat history
 * (migration 036). Unlike Track (an org-shared board), a chat thread is PERSONAL: every
 * handler keys the store call by both the caller's org and user id, so a member can never
 * read or mutate another member's threads — a wrong owner simply matches no row and yields
 * a 404. This is the server foundation the dashboard/desktop/CLI clients can later sync to.
 */
import { Router } from "express";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { attachOrgContext } from "../middleware/tenancy.js";
import * as chat from "../../memory/chat/backend.js";

export const chatThreadsRouter = Router();
chatThreadsRouter.use(requireAnyAuth);

// GET / — my threads (no messages), most-recently-touched first.
chatThreadsRouter.get("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json({ threads: await chat.listThreads(req.orgId!, req.userId!) });
});

// POST / — create a thread (optionally seeded with initial messages).
chatThreadsRouter.post("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const thread = await chat.createThread(req.orgId!, req.userId!, {
      title: typeof body.title === "string" ? body.title : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      messages: Array.isArray(body.messages) ? body.messages : undefined,
    });
    res.status(201).json({ thread });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Could not create thread" });
  }
});

// GET /:id — a thread with its messages (owner-only).
chatThreadsRouter.get("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const thread = await chat.getThread(req.orgId!, req.userId!, String(req.params.id));
  if (!thread) { res.status(404).json({ error: "Thread not found" }); return; }
  res.json({ thread });
});

// POST /:id/messages — append one message; the server assigns the next ordinal.
chatThreadsRouter.post("/:id/messages", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.content !== "string") { res.status(400).json({ error: "content is required" }); return; }
  const message = await chat.appendMessage(req.orgId!, req.userId!, String(req.params.id), body.role, body.content);
  if (!message) { res.status(404).json({ error: "Thread not found" }); return; }
  res.status(201).json({ message });
});

// PUT /:id — rename (and optionally re-model) a thread.
chatThreadsRouter.put("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.title !== "string") { res.status(400).json({ error: "title is required" }); return; }
  const thread = await chat.renameThread(
    req.orgId!, req.userId!, String(req.params.id), body.title,
    Object.prototype.hasOwnProperty.call(body, "model") ? body.model : undefined,
  );
  if (!thread) { res.status(404).json({ error: "Thread not found" }); return; }
  res.json({ thread });
});

// PUT /:id/messages — replace the whole message history (a client syncing its local copy up).
chatThreadsRouter.put("/:id/messages", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(body.messages)) { res.status(400).json({ error: "messages must be an array" }); return; }
  const thread = await chat.replaceMessages(req.orgId!, req.userId!, String(req.params.id), body.messages);
  if (!thread) { res.status(404).json({ error: "Thread not found" }); return; }
  res.json({ thread });
});

// DELETE /:id — remove a thread and its messages.
chatThreadsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const ok = await chat.deleteThread(req.orgId!, req.userId!, String(req.params.id));
  if (!ok) { res.status(404).json({ error: "Thread not found" }); return; }
  res.json({ ok });
});
