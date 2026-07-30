/**
 * Admin email/SMTP settings (ADR-014 Phase B2). System-global config stored in
 * `system_settings` (key 'email') — NEVER `.env`. Admin-only. The password is
 * write-only: never returned to the client, preserved when the client omits it.
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireJwt, requireAdmin, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";
import { emailServiceFor, type SmtpConfig } from "../../../services/email/emailService.js";

export const adminEmailRouter = Router();
adminEmailRouter.use(requireJwt, requireAdmin);

/** GET /api/admin/email — the current SMTP config, password masked. */
adminEmailRouter.get("/", async (_req, res) => {
  const cfg = await memoryEngine.emailAuth.getSetting<SmtpConfig>("email");
  if (!cfg) { res.json({ config: null, configured: false }); return; }
  const { pass, ...safe } = cfg;
  res.json({ config: { ...safe, hasPassword: !!pass }, configured: cfg.enabled === true });
});

/** PUT /api/admin/email — set the SMTP config. Omitting `pass` keeps the stored one. */
adminEmailRouter.put("/", async (req: AuthedRequest, res) => {
  const b = req.body ?? {};
  const existing = await memoryEngine.emailAuth.getSetting<SmtpConfig>("email");
  const cfg: SmtpConfig = {
    enabled: Boolean(b.enabled),
    host: String(b.host ?? "").trim(),
    port: Number.parseInt(String(b.port ?? "587"), 10) || 587,
    secure: Boolean(b.secure),
    user: b.user === undefined ? existing?.user : String(b.user).trim() || undefined,
    // Write-only password: keep the stored one unless a new non-empty value is sent.
    pass: b.pass === undefined || b.pass === "" ? existing?.pass : String(b.pass),
    from: String(b.from ?? "").trim(),
    appUrl: b.appUrl === undefined ? existing?.appUrl : String(b.appUrl).trim() || undefined,
  };
  if (cfg.enabled && (!cfg.host || !cfg.from)) {
    sendError(res, 400, "host and from are required when SMTP is enabled");
    return;
  }
  await memoryEngine.emailAuth.setSetting("email", cfg);
  const { pass, ...safe } = cfg;
  res.json({ config: { ...safe, hasPassword: !!pass }, configured: cfg.enabled === true });
});

/** POST /api/admin/email/test — send a test email to the admin to verify SMTP. */
adminEmailRouter.post("/test", async (req: AuthedRequest, res) => {
  const cfg = await memoryEngine.emailAuth.getSetting<SmtpConfig>("email");
  const to = String(req.body?.to ?? "").trim() || (await memoryEngine.getUserById(req.userId!))?.email || "";
  if (!to) { sendError(res, 400, "no recipient (set a `to`, or an email on your account)"); return; }
  const svc = emailServiceFor(cfg);
  const r = await svc.send({ to, subject: "BrainRouter SMTP test", text: "This is a test email from your BrainRouter deployment. SMTP is working." });
  res.json({ delivered: r.ok, transport: svc.kind, detail: r.detail });
});
