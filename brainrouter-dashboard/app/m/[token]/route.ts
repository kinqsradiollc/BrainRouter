import type { NextRequest } from "next/server";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

function unavailablePage(): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Not available · BrainRouter</title><style>:root{color-scheme:dark}body{margin:0;background:#09090b;color:#f4f4f5;font:16px/1.6 system-ui,sans-serif}.wrap{max-width:720px;margin:0 auto;padding:12vh 24px}.card{border:1px solid #29292f;border-radius:18px;background:#151518;padding:28px}h1{margin:0 0 8px;font-size:1.75rem}p{margin:0;color:#92929d}</style></head><body><main class="wrap"><section class="card"><h1>This shared page is temporarily unavailable</h1><p>BrainRouter could not reach the meeting service. Please try this link again shortly.</p></section></main></body></html>';
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const baseUrl = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3747").replace(/\/$/, "");
  try {
    const upstream = await fetch(`${baseUrl}/m/${encodeURIComponent(token.trim())}`, {
      cache: "no-store",
      headers: { Accept: "text/html" },
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": upstream.headers.get("content-security-policy") || CSP,
        "X-Robots-Tag": upstream.headers.get("x-robots-tag") || "noindex, nofollow",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response(unavailablePage(), {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": CSP,
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "private, no-store",
      },
    });
  }
}
