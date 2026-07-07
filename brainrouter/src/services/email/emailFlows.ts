/**
 * Email flows (ADR-014 Phase B2) — load SMTP config from system_settings and send
 * the transactional emails (verification, invitation, password reset). Links point
 * at the dashboard (`appUrl`, from settings, default localhost:3000). Every send is
 * best-effort: it returns the raw link so the caller can surface it even when SMTP
 * is off (NoopEmailService), so invitations still work in a no-email deployment.
 */
import { memoryEngine } from "../../memory/engine.js";
import { emailServiceFor, type SmtpConfig, type IEmailService } from "./emailService.js";

const DEFAULT_APP_URL = "http://localhost:3000";

export async function loadEmailConfig(): Promise<SmtpConfig | null> {
  return memoryEngine.emailAuth.getSetting<SmtpConfig>("email");
}

export async function getEmailService(): Promise<IEmailService> {
  return emailServiceFor(await loadEmailConfig());
}

function baseUrl(cfg: SmtpConfig | null): string {
  const u = (cfg?.appUrl ?? "").trim().replace(/\/+$/, "");
  return u || DEFAULT_APP_URL;
}

export interface SendResult { ok: boolean; link: string; detail?: string }

export async function sendVerificationEmail(to: string, rawToken: string): Promise<SendResult> {
  const cfg = await loadEmailConfig();
  const link = `${baseUrl(cfg)}/verify-email?token=${rawToken}`;
  const svc = emailServiceFor(cfg);
  const r = await svc.send({
    to,
    subject: "Verify your BrainRouter email",
    text: `Welcome to BrainRouter. Verify your email address:\n\n${link}\n\nThis link expires in 24 hours.`,
  });
  return { ok: r.ok, link, detail: r.detail };
}

export async function sendInviteEmail(to: string, orgName: string, rawToken: string): Promise<SendResult> {
  const cfg = await loadEmailConfig();
  const link = `${baseUrl(cfg)}/accept-invite?token=${rawToken}`;
  const svc = emailServiceFor(cfg);
  const r = await svc.send({
    to,
    subject: `You've been invited to ${orgName} on BrainRouter`,
    text: `You've been invited to join the team "${orgName}" on BrainRouter.\n\nAccept the invitation:\n\n${link}\n\nThis link expires in 7 days.`,
  });
  return { ok: r.ok, link, detail: r.detail };
}

export async function sendPasswordResetEmail(to: string, rawToken: string): Promise<SendResult> {
  const cfg = await loadEmailConfig();
  const link = `${baseUrl(cfg)}/reset-password?token=${rawToken}`;
  const svc = emailServiceFor(cfg);
  const r = await svc.send({
    to,
    subject: "Reset your BrainRouter password",
    text: `A password reset was requested for your BrainRouter account.\n\nReset it here:\n\n${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  });
  return { ok: r.ok, link, detail: r.detail };
}
