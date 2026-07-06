/**
 * Hosted GitHub webhook ingress (ADR-010 P6b / ADR-009) — the ORG backend's
 * stateless receiver. It authenticates by the App's own HMAC (no JWT — webhooks
 * carry none): resolve the tenant from the installation id, verify the
 * X-Hub-Signature-256 with THAT org's webhook secret, then enqueue into the
 * shared Postgres queue tenant-tagged. It never executes — runners poll per-org.
 *
 * Unknown / unsigned deliveries get a generic 202 so the endpoint never leaks
 * which installations exist; only a signature MISMATCH on a known installation
 * is a 401.
 */
import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { memoryEngine } from "../../../memory/engine.js";

export const triggersRouter = Router();

/** Constant-time verify of GitHub's `sha256=<hex>` HMAC over the raw body. */
function verifyGithubSignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !raw || raw.length === 0) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

triggersRouter.post("/github/events", async (req: Request & { rawBody?: Buffer }, res: Response) => {
  const body = (req.body ?? {}) as Record<string, any>;
  const installationId = String(body?.installation?.id ?? "").trim();
  if (!installationId) { res.status(202).json({ ok: true, skipped: "no-installation" }); return; }

  let integ: (Awaited<ReturnType<typeof memoryEngine.integrations.findIntegrationByInstallation>>) = null;
  try {
    integ = await memoryEngine.integrations.findIntegrationByInstallation("github_app", installationId);
  } catch { /* fall through → generic 202 */ }
  if (!integ) { res.status(202).json({ ok: true, skipped: "unknown-installation" }); return; }

  const secret = typeof integ.secret?.webhookSecret === "string" ? integ.secret.webhookSecret : "";
  const sig = req.headers["x-hub-signature-256"];
  if (!verifyGithubSignature(secret, req.rawBody ?? Buffer.alloc(0), Array.isArray(sig) ? sig[0] : sig)) {
    res.status(401).json({ error: "invalid webhook signature", code: "unauthorized" });
    return;
  }

  // Enqueue into the shared Postgres queue, tenant-tagged. Best-effort — the
  // webhook is acknowledged (202) regardless; the per-org runner drains it.
  const event = String(req.headers["x-github-event"] ?? "").trim();
  const delivery = String(req.headers["x-github-delivery"] ?? "").trim();
  try {
    await (memoryEngine.store as { enqueueMemoryJob?: (input: unknown) => Promise<unknown> }).enqueueMemoryJob?.({
      kind: "trigger.github",
      input: {
        orgId: integ.orgId,
        installationId,
        event,
        delivery,
        repo: body?.repository?.full_name,
        number: body?.issue?.number ?? body?.pull_request?.number,
        action: body?.action,
      },
    });
  } catch { /* best-effort enqueue; the endpoint still acks */ }

  res.status(202).json({ ok: true, orgId: integ.orgId });
});
