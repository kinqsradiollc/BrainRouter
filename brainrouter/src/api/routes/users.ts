import { Router } from "express";
import { randomBytes } from "node:crypto";
import { memoryEngine } from "../../memory/engine.js";
import { requireJwt, requireAdmin, type AuthedRequest } from "../middleware/auth.js";
import { decodeCursor, pageItems, PaginationQuerySchema } from "../pagination.js";

export const usersRouter = Router();
usersRouter.use(requireJwt, requireAdmin);

usersRouter.get("/", (req, res) => {
  try {
    const pagination = PaginationQuerySchema.parse(req.query);
    const users = memoryEngine.listUsers({
      cursor: decodeCursor<{ createdAt: string; userId: string }>(pagination.cursor),
      limit: pagination.limit + 1,
    }).map((u) => ({
      userId: u.userId,
      displayName: u.displayName,
      email: u.email,
      isAdmin: u.isAdmin,
      status: u.status,
      createdAt: u.createdAt,
    }));
    const page = pageItems(users, pagination.limit, (user) => ({
      createdAt: user.createdAt,
      userId: user.userId,
    }));
    res.json({ users: page.items, nextCursor: page.nextCursor, limit: pagination.limit, hasMore: Boolean(page.nextCursor) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid pagination parameters" });
  }
});

usersRouter.post("/", (req: AuthedRequest, res) => {
  const userId = String(req.body?.userId ?? "").trim();
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const displayName = String(req.body?.displayName ?? "").trim();
  const isAdmin = Boolean(req.body?.isAdmin);
  const apiKey = `br_${randomBytes(24).toString("hex")}`;
  try {
    const user = memoryEngine.createUser(userId, apiKey, displayName, isAdmin);
    res.status(201).json({ user });
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? "Failed to create user" });
  }
});

usersRouter.put("/:id/status", (req: AuthedRequest, res) => {
  const userId = String(req.params.id);
  const status = req.body?.status === "disabled" ? "disabled" : req.body?.status === "active" ? "active" : null;
  if (!status) {
    res.status(400).json({ error: "status must be active or disabled" });
    return;
  }
  if (userId === req.userId && status === "disabled") {
    res.status(400).json({ error: "Cannot disable the current admin user" });
    return;
  }
  memoryEngine.updateUserStatus(userId, status);
  res.json({ success: true });
});

usersRouter.post("/:id/reset-key", (req, res) => {
  const userId = String(req.params.id);
  const user = memoryEngine.getUserById(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const apiKey = `br_${randomBytes(24).toString("hex")}`;
  memoryEngine.updateUserApiKey(userId, apiKey);
  res.json({ apiKey });
});

usersRouter.delete("/:id", (req: AuthedRequest, res) => {
  const userId = String(req.params.id);
  if (userId === req.userId) {
    res.status(400).json({ error: "Cannot delete the current admin user" });
    return;
  }
  memoryEngine.deleteUser(userId);
  res.json({ success: true });
});
