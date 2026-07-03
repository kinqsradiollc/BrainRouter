import { Router } from "express";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { memoryEngine } from "../../../memory/engine.js";
import { hashPassword, signJwt, verifyJwt, verifyPassword } from "../../auth/crypto.js";
import { JWT_SECRET, requireJwt, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";

// Short-lived access token (default 1h) + long-lived refresh token (default 30d).
// The client silently mints a fresh access token from the refresh token, so the
// session persists across tabs and browser restarts without re-login.
const jwtExpiry = Number.parseInt(process.env.BRAINROUTER_JWT_EXPIRES_SECS ?? "3600", 10);
const refreshExpiry = Number.parseInt(process.env.BRAINROUTER_REFRESH_EXPIRES_SECS ?? "2592000", 10);

function createJwt(user: { userId: string; isAdmin: boolean; email: string; displayName: string }) {
  return signJwt(
    {
      userId: user.userId,
      isAdmin: user.isAdmin,
      email: user.email,
      displayName: user.displayName,
    },
    JWT_SECRET,
    Number.isFinite(jwtExpiry) ? jwtExpiry : 3600,
  );
}

/** Opaque-ish refresh token: a signed JWT carrying only the user id + a refresh
 *  marker, so /refresh can verify it without a server-side store. */
function createRefreshToken(userId: string) {
  return signJwt({ userId, type: "refresh" }, JWT_SECRET, Number.isFinite(refreshExpiry) ? refreshExpiry : 2592000);
}

async function userIdFromEmail(email: string): Promise<string> {
  const base = email
    .split("@")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "user";
  let userId = base;
  while (await memoryEngine.getUserById(userId)) {
    userId = `${base}_${randomBytes(3).toString("hex")}`;
  }
  return userId;
}

export const authRouter = Router();

authRouter.post("/signin", async (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!email || !password) {
    sendError(res, 400, "email and password are required");
    return;
  }

  const user = await memoryEngine.getUserByEmail(email);
  if (!user || !user.passwordHash) {
    sendError(res, 401, "Invalid email or password");
    return;
  }
  if (user.status === "disabled") {
    sendError(res, 403, "Account disabled");
    return;
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    sendError(res, 401, "Invalid email or password");
    return;
  }

  const jwt = createJwt(user);
  res.json({ jwt, refreshToken: createRefreshToken(user.userId), userId: user.userId, isAdmin: user.isAdmin, displayName: user.displayName, apiKey: user.apiKey });
});

authRouter.post("/signup", async (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  const password = String(req.body?.password ?? "");
  const displayName = String(req.body?.displayName ?? "").trim();

  if (!email || !password) {
    sendError(res, 400, "email and password are required");
    return;
  }
  if (email.length > 254) {
    sendError(res, 400, "Email too long");
    return;
  }
  if (password.length < 8) {
    sendError(res, 400, "Password must be at least 8 characters");
    return;
  }
  if (displayName.length > 100) {
    sendError(res, 400, "Display name too long");
    return;
  }
  if (await memoryEngine.getUserByEmail(email)) {
    sendError(res, 409, "Email already registered");
    return;
  }

  const userId = await userIdFromEmail(email);
  const apiKey = `br_${randomBytes(24).toString("hex")}`;
  const passwordHash = await hashPassword(password);

  try {
    const created = await memoryEngine.createUser(userId, apiKey, displayName || userId, false);
    await memoryEngine.updateUserEmail(created.userId, email);
    await memoryEngine.updatePassword(created.userId, passwordHash);
    const user = await memoryEngine.getUserById(created.userId);
    if (!user) {
      sendError(res, 500, "Failed to load user after signup");
      return;
    }

    const jwt = createJwt(user);
    res.status(201).json({ jwt, refreshToken: createRefreshToken(user.userId), userId: user.userId, isAdmin: user.isAdmin, displayName: user.displayName });
  } catch (error: any) {
    sendError(res, 400, error?.message ?? "Failed to create user");
  }
});

authRouter.post("/refresh", async (req, res) => {
  const refreshToken = String(req.body?.refreshToken ?? "");
  if (!refreshToken) {
    sendError(res, 400, "refreshToken is required");
    return;
  }
  const payload = verifyJwt(refreshToken, JWT_SECRET);
  if (!payload || payload.type !== "refresh" || typeof payload.userId !== "string") {
    sendError(res, 401, "Invalid or expired refresh token");
    return;
  }
  const user = await memoryEngine.getUserById(payload.userId);
  if (!user || user.status === "disabled") {
    sendError(res, 401, "Account not found or disabled");
    return;
  }
  // Rotate: hand back a fresh access token AND a fresh refresh token.
  res.json({ jwt: createJwt(user), refreshToken: createRefreshToken(user.userId) });
});

authRouter.post("/signout", (_req, res) => {
  // Stateless tokens: the client discards both. Server-side revocation would
  // need a refresh-token denylist (future hardening).
  res.json({ success: true });
});

authRouter.get("/me", requireJwt, async (req: AuthedRequest, res) => {
  const user = await memoryEngine.getUserById(req.userId!);
  if (!user) {
    sendError(res, 404, "User not found");
    return;
  }
  res.json({
    userId: user.userId,
    displayName: user.displayName,
    email: user.email,
    isAdmin: user.isAdmin,
    // API-AUTHN (0.4.9) — /me must NOT expose the raw API key; it is returned
    // only at signup / signin / rotate-key. /me is read repeatedly.
    createdAt: user.createdAt,
    status: user.status,
    mcpPath: path.resolve(process.cwd(), "dist/index.js")
  });
});

authRouter.put("/me", requireJwt, async (req: AuthedRequest, res) => {
  const displayName = String(req.body?.displayName ?? "").trim();
  if (!displayName) {
    sendError(res, 400, "displayName required");
    return;
  }
  if (displayName.length > 100) {
    sendError(res, 400, "Display name too long");
    return;
  }
  await memoryEngine.updateUserDisplayName(req.userId!, displayName);
  res.json({ success: true });
});

authRouter.post("/rotate-key", requireJwt, async (req: AuthedRequest, res) => {
  const apiKey = `br_${randomBytes(24).toString("hex")}`;
  await memoryEngine.updateUserApiKey(req.userId!, apiKey);
  res.json({ apiKey });
});
