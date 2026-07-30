/**
 * Email service (ADR-014 Phase B2) — pluggable SMTP by default.
 *
 * `IEmailService` is the one surface auth/invite flows call. Two implementations:
 *   - `NoopEmailService` (default) — logs "would send" + never throws, so the
 *     system runs exactly as before when no SMTP is configured (invite links are
 *     still generated; the operator can copy them out of the response/logs).
 *   - `SmtpEmailService` — nodemailer, lazily imported so the dependency only
 *     loads when SMTP is actually configured.
 *
 * Config is read from `system_settings` (key `email`) — NEVER `.env` — so the
 * dashboard can manage it and it survives redeploys.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface IEmailService {
  readonly kind: "noop" | "smtp";
  send(msg: EmailMessage): Promise<{ ok: boolean; detail?: string }>;
}

/** SMTP configuration (stored under system_settings 'email'). */
export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** Dashboard base URL used to build verification/invite/reset links. */
  appUrl?: string;
}

export function isSmtpConfigured(cfg: SmtpConfig | null | undefined): cfg is SmtpConfig {
  return !!cfg && cfg.enabled === true && !!cfg.host && !!cfg.from && Number.isFinite(cfg.port);
}

export class NoopEmailService implements IEmailService {
  readonly kind = "noop" as const;
  async send(msg: EmailMessage): Promise<{ ok: boolean; detail?: string }> {
    // Intentionally silent-but-visible: the flow still succeeds; the caller keeps
    // the raw link so an operator can deliver it manually.
    console.error(`[email:noop] would send "${msg.subject}" to ${msg.to} (SMTP not configured)`);
    return { ok: false, detail: "email delivery is not configured (SMTP disabled)" };
  }
}

export class SmtpEmailService implements IEmailService {
  readonly kind = "smtp" as const;
  constructor(private readonly cfg: SmtpConfig) {}

  async send(msg: EmailMessage): Promise<{ ok: boolean; detail?: string }> {
    try {
      // Lazy import so nodemailer only loads when SMTP is actually used.
      const nodemailer = (await import("nodemailer")).default as unknown as {
        createTransport: (opts: unknown) => { sendMail: (m: unknown) => Promise<unknown> };
      };
      const transport = nodemailer.createTransport({
        host: this.cfg.host,
        port: this.cfg.port,
        secure: this.cfg.secure ?? this.cfg.port === 465,
        auth: this.cfg.user ? { user: this.cfg.user, pass: this.cfg.pass } : undefined,
      });
      await transport.sendMail({
        from: this.cfg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "smtp send failed" };
    }
  }
}

/** Build the right service from config (SMTP when configured, else Noop). */
export function emailServiceFor(cfg: SmtpConfig | null | undefined): IEmailService {
  return isSmtpConfigured(cfg) ? new SmtpEmailService(cfg) : new NoopEmailService();
}
