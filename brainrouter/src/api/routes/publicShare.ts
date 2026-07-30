/**
 * Public share PAGE (D8). The share link minted for a public meeting is
 * `${BRAINROUTER_PUBLIC_URL}/m/<token>` — this router serves the human-facing HTML
 * at that path (the JSON read stays at /api/public/meetings/:token). Unauthenticated,
 * server-rendered, self-contained (no scripts, strict CSP), robots-noindex. It shows
 * only the redacted summary the share token grants — never the transcript or actions.
 */
import { Router, type Request, type Response } from "express";
import * as meetings from "../../memory/meetings/backend.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Inject-safe inline markdown — operates on ALREADY-escaped text, so no user content
 *  can ever produce live markup. Supports **bold** and `code` only. */
function inline(escaped: string): string {
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Minimal, injection-safe markdown→HTML: escape FIRST, then transform the escaped text. */
export function renderShareMarkdown(md: string): string {
  const lines = escapeHtml(md).split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (h) { closeList(); const lvl = Math.min(h[1].length + 1, 4); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }
    if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList(); out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

const STYLE = `
  :root { color-scheme: light dark; --bg:#fff; --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --card:#fafafa; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#0a0a0b; --fg:#ededf0; --muted:#8b8b93; --line:#26262b; --card:#141417; } }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 24px 80px; }
  .brand { font:600 13px/1 ui-monospace,monospace; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:28px; }
  h1 { font-size:1.7rem; margin:0 0 4px; line-height:1.25; } .date { color:var(--muted); font-size:.9rem; margin-bottom:28px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px 28px; }
  .card h2 { font-size:1.15rem; margin:1.4em 0 .5em; } .card h3,.card h4 { font-size:1rem; margin:1.2em 0 .4em; }
  .card h2:first-child,.card h3:first-child { margin-top:0; }
  .card p { margin:.6em 0; } .card ul { margin:.6em 0; padding-left:1.3em; } .card li { margin:.25em 0; }
  code { background:var(--line); padding:.1em .35em; border-radius:5px; font-size:.9em; }
  .foot { margin-top:40px; color:var(--muted); font-size:.82rem; text-align:center; }
`;

function shell(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)} · BrainRouter</title><style>${STYLE}</style></head><body><div class="wrap">${inner}<div class="foot">Shared via BrainRouter</div></div></body></html>`;
}

export const publicSharePageRouter = Router();

publicSharePageRouter.get("/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "").trim();
  res.set("Content-Type", "text/html; charset=utf-8");
  // No scripts anywhere; inline styles only.
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
  res.set("X-Robots-Tag", "noindex, nofollow");
  const meeting = token ? await meetings.getByShareToken(token).catch(() => null) : null;
  if (!meeting) {
    res.status(404).send(shell("Not available", `<div class="brand">BrainRouter</div><h1>This shared page isn't available</h1><p class="date">The link may have expired or been revoked by its owner.</p>`));
    return;
  }
  res.send(shell(meeting.title, `<div class="brand">BrainRouter</div><h1>${escapeHtml(meeting.title)}</h1><div class="date">${escapeHtml(meeting.date)}</div><div class="card">${renderShareMarkdown(meeting.summaryMarkdown)}</div>`));
});
