/**
 * GitHub webhook core (ADR-010 P6b) — shared by the in-brain route AND the
 * standalone ingress microservice. Pure + dependency-injected so it unit-tests
 * without a server or a DB: verify the App's HMAC, resolve the tenant from the
 * installation, enqueue tenant-tagged. No Express, no engine — just the logic.
 */
import crypto from "node:crypto";
import type { ResolvedIntegration } from "./types.js";

/** Constant-time verify of GitHub's `sha256=<hex>` HMAC over the raw body. */
export function verifyGithubSignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !raw || raw.length === 0) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface WebhookDeps {
  findIntegrationByInstallation(installationId: string): Promise<(ResolvedIntegration & { orgId: string }) | null>;
  enqueue(job: { kind: string; input: Record<string, unknown> }): Promise<void>;
}

export interface WebhookRequest {
  body: Record<string, any>;
  rawBody: Buffer;
  signature?: string;
  event?: string;
  delivery?: string;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Process one GitHub delivery. Unknown/unsigned → generic 202 (no
 * installation-existence leak); signature mismatch on a KNOWN installation → 401;
 * valid → enqueue + 202.
 */
export async function processGithubDelivery(deps: WebhookDeps, req: WebhookRequest): Promise<WebhookResponse> {
  const installationId = String(req.body?.installation?.id ?? "").trim();
  if (!installationId) return { status: 202, body: { ok: true, skipped: "no-installation" } };

  let integ: (ResolvedIntegration & { orgId: string }) | null = null;
  try { integ = await deps.findIntegrationByInstallation(installationId); } catch { /* → generic 202 */ }
  if (!integ) return { status: 202, body: { ok: true, skipped: "unknown-installation" } };

  const secret = typeof integ.secret?.webhookSecret === "string" ? integ.secret.webhookSecret : "";
  if (!verifyGithubSignature(secret, req.rawBody, req.signature)) {
    return { status: 401, body: { error: "invalid webhook signature", code: "unauthorized" } };
  }

  try {
    await deps.enqueue({
      kind: "trigger.github",
      input: {
        orgId: integ.orgId,
        installationId,
        event: req.event,
        delivery: req.delivery,
        repo: req.body?.repository?.full_name,
        number: req.body?.issue?.number ?? req.body?.pull_request?.number,
        action: req.body?.action,
      },
    });
  } catch { /* best-effort; the endpoint still acks */ }

  return { status: 202, body: { ok: true, orgId: integ.orgId } };
}
