import { Router } from "express";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { memoryEngine } from "../../memory/engine.js";
import { hashPassword, signJwt, verifyPassword } from "../auth/crypto.js";
import { JWT_SECRET, requireJwt, type AuthedRequest } from "../middleware/auth.js";

const jwtExpiry = Number.parseInt(process.env.BRAINROUTER_JWT_EXPIRES_SECS ?? "86400", 10);

function createJwt(user: { userId: string; isAdmin: boolean; email: string; displayName: string }) {
  return signJwt(
    {
      userId: user.userId,
      isAdmin: user.isAdmin,
      email: user.email,
      displayName: user.displayName,
    },
    JWT_SECRET,
    Number.isFinite(jwtExpiry) ? jwtExpiry : 86400,
  );
}

function userIdFromEmail(email: string): string {
  const base = email
    .split("@")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "user";
  let userId = base;
  while (memoryEngine.getUserById(userId)) {
    userId = `${base}_${randomBytes(3).toString("hex")}`;
  }
  return userId;
}

export const authRouter = Router();

authRouter.post("/signin", async (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const user = memoryEngine.getUserByEmail(email);
  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  if (user.status === "disabled") {
    res.status(403).json({ error: "Account disabled" });
    return;
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const jwt = createJwt(user);
  res.json({ jwt, userId: user.userId, isAdmin: user.isAdmin, displayName: user.displayName, apiKey: user.apiKey });
});

authRouter.post("/signup", async (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  const password = String(req.body?.password ?? "");
  const displayName = String(req.body?.displayName ?? "").trim();

  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  if (email.length > 254) {
    res.status(400).json({ error: "Email too long" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  if (displayName.length > 100) {
    res.status(400).json({ error: "Display name too long" });
    return;
  }
  if (memoryEngine.getUserByEmail(email)) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const userId = userIdFromEmail(email);
  const apiKey = `br_${randomBytes(24).toString("hex")}`;
  const passwordHash = await hashPassword(password);

  try {
    const created = memoryEngine.createUser(userId, apiKey, displayName || userId, false);
    memoryEngine.updateUserEmail(created.userId, email);
    memoryEngine.updatePassword(created.userId, passwordHash);
    const user = memoryEngine.getUserById(created.userId);
    if (!user) {
      res.status(500).json({ error: "Failed to load user after signup" });
      return;
    }

    const jwt = createJwt(user);
    res.status(201).json({ jwt, userId: user.userId, isAdmin: user.isAdmin, displayName: user.displayName });
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? "Failed to create user" });
  }
});

authRouter.get("/me", requireJwt, (req: AuthedRequest, res) => {
  const user = memoryEngine.getUserById(req.userId!);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({
    userId: user.userId,
    displayName: user.displayName,
    email: user.email,
    isAdmin: user.isAdmin,
    apiKey: user.apiKey,
    createdAt: user.createdAt,
    status: user.status,
    mcpPath: path.resolve(process.cwd(), "dist/index.js")
  });
});

authRouter.put("/me", requireJwt, (req: AuthedRequest, res) => {
  const displayName = String(req.body?.displayName ?? "").trim();
  if (!displayName) {
    res.status(400).json({ error: "displayName required" });
    return;
  }
  if (displayName.length > 100) {
    res.status(400).json({ error: "Display name too long" });
    return;
  }
  memoryEngine.updateUserDisplayName(req.userId!, displayName);
  res.json({ success: true });
});

authRouter.post("/rotate-key", requireJwt, (req: AuthedRequest, res) => {
  const apiKey = `br_${randomBytes(24).toString("hex")}`;
  memoryEngine.updateUserApiKey(req.userId!, apiKey);
  res.json({ apiKey });
});
