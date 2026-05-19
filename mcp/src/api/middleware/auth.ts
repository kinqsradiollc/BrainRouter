import type { Request, Response, NextFunction } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { randomBytes } from "node:crypto";
import { verifyJwt } from "../auth/crypto.js";

export type AuthedRequest = Request & { userId?: string; isAdmin?: boolean; email?: string };

const configuredJwtSecret = process.env.BRAINROUTER_JWT_SECRET?.trim();
const generatedJwtSecret = randomBytes(32).toString("hex");
export const USING_FALLBACK_JWT_SECRET = !configuredJwtSecret;
export const JWT_SECRET = configuredJwtSecret || generatedJwtSecret;
if (USING_FALLBACK_JWT_SECRET) {
  console.error("[BrainRouter] WARNING: BRAINROUTER_JWT_SECRET not set. Using random secret — sessions will not survive restarts.");
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const key = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key) {
    res.status(401).json({ error: "API key required" });
    return;
  }
  const user = memoryEngine.getUserByApiKey(key);
  if (!user) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }
  req.userId = user.userId;
  req.isAdmin = user.isAdmin;
  req.email = user.email;
  next();
}

export function requireJwt(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "JWT required" });
    return;
  }
  const payload = verifyJwt(token, JWT_SECRET);
  if (!payload) {
    res.status(403).json({ error: "Invalid or expired token" });
    return;
  }
  req.userId = typeof payload.userId === "string" ? payload.userId : undefined;
  req.isAdmin = Boolean(payload.isAdmin);
  req.email = typeof payload.email === "string" ? payload.email : undefined;
  if (!req.userId) {
    res.status(403).json({ error: "Invalid or expired token" });
    return;
  }
  const user = memoryEngine.getUserById(req.userId);
  if (!user) {
    res.status(403).json({ error: "Invalid or expired token" });
    return;
  }
  if (user.status === "disabled") {
    res.status(403).json({ error: "Account disabled" });
    return;
  }
  next();
}

export function requireAnyAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!bearer) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (bearer.split(".").length === 3) {
    const payload = verifyJwt(bearer, JWT_SECRET);
    if (payload && typeof payload.userId === "string") {
      req.userId = payload.userId;
      req.isAdmin = Boolean(payload.isAdmin);
      req.email = typeof payload.email === "string" ? payload.email : undefined;
      return next();
    }
  }

  const user = memoryEngine.getUserByApiKey(bearer);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  req.userId = user.userId;
  req.isAdmin = user.isAdmin;
  req.email = user.email;
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.isAdmin) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
