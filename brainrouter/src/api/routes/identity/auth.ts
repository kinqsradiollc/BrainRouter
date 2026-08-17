import { Router } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { memoryEngine } from "../../../memory/engine.js";
import { hashPassword, signJwt, verifyJwt, verifyPassword } from "../../auth/crypto.js";
import { JWT_SECRET, requireJwt, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";
import { generateToken, hashToken, expiryFrom } from "../../../tenancy/tokens.js";
import { sendVerificationEmail, sendPasswordResetEmail } from "../../../services/email/emailFlows.js";
import { issueRefreshSession, rotateRefreshSession, revokeAllSessions, type RotateOutcome } from "./refreshSessions.js";

// Short-lived access token (default 1h) + long-lived refresh token (default 30d).
// The client silently mints a fresh access token from the refresh token, so the
// session persists across tabs and browser restarts without re-login.
const jwtExpiry = Number.parseInt(process.env.BRAINROUTER_JWT_EXPIRES_SECS ?? "3600", 10);
const refreshExpiry = Number.parseInt(process.env.BRAINROUTER_REFRESH_EXPIRES_SECS ?? "2592000", 10);

function createJwt(user: { userId: string; isAdmin: boolean; email: string; displayName: string }) {
  return signJwt(
    {
      type: "access",
      aud: ["brainrouter-api", "brainrouter-model-gateway"],
      scope: ["api", "models:invoke"],
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

/** ADR-037 B1 — when a refresh session expires, mirroring the token's own TTL. */
function refreshExpiresAt(): Date {
  return new Date(Date.now() + (Number.isFinite(refreshExpiry) ? refreshExpiry : 2592000) * 1000);
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
  const refreshToken = createRefreshToken(user.userId);
  // ADR-037 B1 — record the session so it is revocable and reuse-detectable.
  try { await issueRefreshSession({ store: memoryEngine.refreshSessions, userId: user.userId, rawToken: refreshToken, expiresAt: refreshExpiresAt() }); } catch { /* best-effort: never block signin on the session store */ }
  res.json({ jwt, refreshToken, userId: user.userId, isAdmin: user.isAdmin, displayName: user.displayName, apiKey: user.apiKey });
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
    // ADR-010 P1 — every new user gets a personal org (owner) as their default,
    // so single-user works with zero config and the org tier is never empty.
    await memoryEngine.tenancy.ensurePersonalOrg(created.userId, displayName || userId);
    // Issue an email-verification token + best-effort send (never blocks signup;
    // NoopEmailService just logs when SMTP is off). New users start unverified.
    try {
      const { raw, hash } = generateToken();
      const now = new Date().toISOString();
      await memoryEngine.emailAuth.createAuthToken({ tokenHash: hash, kind: "email_verify", userId: created.userId, email, expiresAt: expiryFrom(now, 24 * 3600_000), createdAt: now });
      await sendVerificationEmail(email, raw);
    } catch { /* verification is optional; never fail signup on it */ }
    const user = await memoryEngine.getUserById(created.userId);
    if (!user) {
      sendError(res, 500, "Failed to load user after signup");
      return;
    }

    const jwt = createJwt(user);
    const refreshToken = createRefreshToken(user.userId);
    try { await issueRefreshSession({ store: memoryEngine.refreshSessions, userId: user.userId, rawToken: refreshToken, expiresAt: refreshExpiresAt() }); } catch { /* best-effort */ }
    res.status(201).json({ jwt, refreshToken, userId: user.userId, isAdmin: user.isAdmin, displayName: user.displayName });
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
  // ADR-037 B1 — rotate through the revocable store. Using a token consumes it
  // and mints a successor; presenting an already-rotated token is treated as
  // theft and revokes the whole chain. A signature-valid but UNKNOWN token is a
  // legacy (pre-B1) session with no row yet — ADOPT it rather than force-signing
  // out every existing session on deploy (this slice must not break sessions).
  const successorId = `rs_${randomUUID().replace(/-/g, "")}`;
  let outcome: RotateOutcome;
  try {
    outcome = await rotateRefreshSession({ store: memoryEngine.refreshSessions, presentedToken: refreshToken, successorId });
  } catch {
    outcome = { status: "unknown" }; // store unavailable → degrade to stateless re-issue
  }
  if (outcome.status === "reused") {
    sendError(res, 401, "This session was ended because a refresh token was used twice. Sign in again.");
    return;
  }
  if (outcome.status === "revoked") {
    sendError(res, 401, "This session has been revoked. Sign in again.");
    return;
  }
  if (outcome.status === "expired") {
    sendError(res, 401, "Refresh token expired. Sign in again.");
    return;
  }
  // ok (rotated) OR unknown (legacy adopt): mint fresh tokens and record the
  // successor session under the id we rotated onto.
  const newRefresh = createRefreshToken(user.userId);
  try { await issueRefreshSession({ store: memoryEngine.refreshSessions, id: successorId, userId: user.userId, rawToken: newRefresh, expiresAt: refreshExpiresAt() }); } catch { /* best-effort */ }
  res.json({ jwt: createJwt(user), refreshToken: newRefresh });
});

authRouter.post("/signout", async (req, res) => {
  // ADR-037 B1 — if the caller presents its refresh token, revoke EVERY session
  // for that user server-side, not just a client-side discard. Best-effort:
  // signout always reports success so a store hiccup never traps the user.
  const presented = String(req.body?.refreshToken ?? "");
  if (presented) {
    const payload = verifyJwt(presented, JWT_SECRET);
    if (payload && typeof payload.userId === "string") {
      try { await revokeAllSessions(memoryEngine.refreshSessions, payload.userId, "user signed out"); } catch { /* best-effort */ }
    }
  }
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

// ── Email verification + password reset (ADR-014 Phase B2) ────────────────

/** POST /api/auth/verify-email { token } — mark the user's email verified. */
authRouter.post("/verify-email", async (req, res) => {
  const token = String(req.body?.token ?? "").trim();
  if (!token) { sendError(res, 400, "token is required"); return; }
  const rec = await memoryEngine.emailAuth.consumeAuthToken(hashToken(token), "email_verify", new Date().toISOString());
  if (!rec || !rec.userId) { sendError(res, 400, "Invalid or expired verification link"); return; }
  await memoryEngine.emailAuth.setEmailVerified(rec.userId);
  res.json({ ok: true, verified: true });
});

/** POST /api/auth/resend-verification (authed) — reissue + resend the link. */
authRouter.post("/resend-verification", requireJwt, async (req: AuthedRequest, res) => {
  const user = await memoryEngine.getUserById(req.userId!);
  if (!user?.email) { sendError(res, 400, "No email on file"); return; }
  const { raw, hash } = generateToken();
  const now = new Date().toISOString();
  await memoryEngine.emailAuth.createAuthToken({ tokenHash: hash, kind: "email_verify", userId: user.userId, email: user.email, expiresAt: expiryFrom(now, 24 * 3600_000), createdAt: now });
  const sent = await sendVerificationEmail(user.email, raw);
  res.json({ ok: true, delivered: sent.ok, link: sent.ok ? undefined : sent.link });
});

/**
 * POST /api/auth/forgot-password { email } — issue a reset link. Always 200 (never
 * reveal whether an account exists). Returns the link only when SMTP is off so a
 * local/self-host operator can still complete the flow.
 */
authRouter.post("/forgot-password", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email) { sendError(res, 400, "email is required"); return; }
  const user = await memoryEngine.getUserByEmail(email);
  if (user) {
    const { raw, hash } = generateToken();
    const now = new Date().toISOString();
    await memoryEngine.emailAuth.createAuthToken({ tokenHash: hash, kind: "password_reset", userId: user.userId, email, expiresAt: expiryFrom(now, 3600_000), createdAt: now });
    const sent = await sendPasswordResetEmail(email, raw);
    res.json({ ok: true, link: sent.ok ? undefined : sent.link });
    return;
  }
  res.json({ ok: true });
});

/** POST /api/auth/reset-password { token, password } — set a new password. */
authRouter.post("/reset-password", async (req, res) => {
  const token = String(req.body?.token ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!token || password.length < 8) { sendError(res, 400, "token and a password (min 8 chars) are required"); return; }
  const rec = await memoryEngine.emailAuth.consumeAuthToken(hashToken(token), "password_reset", new Date().toISOString());
  if (!rec || !rec.userId) { sendError(res, 400, "Invalid or expired reset link"); return; }
  await memoryEngine.updatePassword(rec.userId, await hashPassword(password));
  // ADR-037 B1 — a password reset ends every session, otherwise the reset does
  // not achieve the one thing the user changed their password to achieve.
  try { await revokeAllSessions(memoryEngine.refreshSessions, rec.userId, "password reset"); } catch { /* best-effort */ }
  res.json({ ok: true });
});
