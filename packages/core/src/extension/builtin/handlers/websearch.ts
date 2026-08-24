// ADR-041 D8 Phase 36 — the host-side egress tools fetch_url + web_search. Both are
// DISABLED in a pentest turn (host egress bypasses the scope-pinned sandbox = SSRF vector),
// and both prefer the in-app browser (real Chromium + the user's session) when present,
// falling back to the HTTP crawler / configured search provider. New host surface:
// pentestMode + browserControlPort. The in-app-browser helpers come from websearch/inAppBrowser.js
// (extracted in this same slice) so this handler never imports back through the dispatch shim.
// Bodies are the former switch cases verbatim (this.x -> ctx.host.x).

import { getCliKnobs } from '../../../config/config.js';
import { egressDecision } from '../../../exec/policy/execPolicy.js';
import { fetchAndExtract } from '../../../websearch/crawler.js';
import { buildSearchProvider } from '../../../websearch/factory.js';
import { parseGoogleHtml, googleSearchUrl } from '../../../websearch/providers/google.js';
import { looksStructuredUrl, fetchViaInAppBrowser, fetchHtmlViaInAppBrowser } from '../../../websearch/inAppBrowser.js';
import type { WebSearchResult } from '../../../websearch/types.js';
import { buildPageArtifact } from '../../../browser/pageArtifact.js';
import { createArtifact } from '../../../artifact/artifactStore.js';
import type { BuiltinToolHandler, BuiltinToolHost } from './registry.js';

/**
 * ADR-044 M4 — land a successfully fetched page as a durable, recallable
 * artifact (opt-in via `cli.webSearch.persistToMemory`). The page becomes a
 * markdown artifact with provenance (source URL + fetch time) and addressable
 * sections via `buildPageArtifact`, and is captured into session memory so a
 * later turn can cite it. Best-effort: any failure here never breaks the fetch —
 * the tool still returns the page. Returns the artifact id when one was written.
 */
export async function persistFetchedPage(
  host: BuiltinToolHost,
  page: { title: string; url: string; text: string },
): Promise<string | undefined> {
  if (!getCliKnobs().webSearch.persistToMemory) return undefined;
  if (!host.workspaceRoot || !host.sessionKey) return undefined;
  try {
    const artifact = buildPageArtifact({
      title: page.title,
      url: page.url,
      markdown: page.text,
      fetchedAt: new Date().toISOString(),
    });
    const created = createArtifact(host.workspaceRoot, {
      kind: 'markdown-report',
      format: 'markdown',
      title: artifact.title,
      content: artifact.markdown,
      summary: `Fetched from ${page.url}`,
      sessionKey: host.sessionKey,
      editedBy: 'agent',
    });
    await host.captureArtifactToMemory(created);
    return created.id;
  } catch {
    return undefined;
  }
}

export const websearchHandlers: Record<string, BuiltinToolHandler> = {
  fetch_url: async ({ args, host }) => {
        // A pentest turn must never reach the network from the HOST — that path
        // bypasses the scope-pinned Docker/proxy sandbox entirely (SSRF to
        // internal services / cloud metadata). Force target interaction through
        // the sandboxed run_command or the scoped proxy tools.
        if (host.pentestMode) return 'fetch_url is disabled for pentests; reach the target via run_command inside the sandbox, or view_request/repeat_request through the scoped proxy.';
        const url = args.url;
        // POLICY-3 — per-host egress allowlist (empty = unrestricted).
        const egressAllowlist = getCliKnobs().egressAllowlist;
        const egress = egressDecision(url, egressAllowlist);
        if (egress.decision === 'deny') {
          return `fetch_url blocked by egress policy: ${egress.reason}.`;
        }
        const knobs = getCliKnobs();
        // BROWSER-FIRST: when the in-app browser is available (desktop, top-level,
        // not a silent child), fetch through it so JS-rendered / logged-in /
        // bot-guarded pages return their REAL rendered content. Falls back to the
        // HTTP crawler on any failure or when there is no browser (CLI/server).
        // EXCEPT structured/API URLs (JSON/XML/feeds): the browser would render
        // them into a DOM and innerText-scrape a mangled copy — send those
        // straight to the crawler, which returns the raw bytes.
        if (host.browserControlPort && !host.silent && !looksStructuredUrl(String(url))) {
          // Read through a background agent-owned tab, then close it. The human's
          // selected tab and panel remain untouched while the real browser
          // session, JavaScript, and authentication are still available.
          const viaBrowser = await fetchViaInAppBrowser(host.browserControlPort, String(url), 25_000, host.turnAbort?.signal);
          if (viaBrowser?.text) {
            const artifactId = await persistFetchedPage(host, { title: viaBrowser.title, url: viaBrowser.url, text: viaBrowser.text });
            return JSON.stringify({ ok: true, via: 'in-app-browser', title: viaBrowser.title, url: viaBrowser.url, text: viaBrowser.text, ...(artifactId ? { artifactId } : {}) }, null, 2);
          }
        }
        const result = await fetchAndExtract(String(url), {
          ...knobs.webSearch.crawler,
          signal: host.turnAbort?.signal,
          // Re-apply the allowlist on every redirect hop (the crawler also blocks
          // private/loopback/metadata IPs on each hop as an always-on SSRF guard).
          isEgressAllowed: (target) => egressDecision(target, egressAllowlist).decision !== 'deny',
        });
        if (result.ok) {
          const artifactId = await persistFetchedPage(host, { title: result.title, url: result.url, text: result.text });
          if (artifactId) return JSON.stringify({ ...result, artifactId }, null, 2);
        }
        return JSON.stringify(result, null, 2);
  },

  web_search: async ({ args, host }) => {
        // Host-side egress; disabled in a pentest for the same reason as fetch_url.
        if (host.pentestMode) return 'web_search is disabled for pentests; stay inside the authorized target using the sandboxed tools.';
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('web_search requires a non-empty query.');
        const knobs = getCliKnobs();
        const maxResults = Math.max(1, Math.min(10, Number(args.maxResults ?? knobs.webSearch.maxResults)));
        const page = Math.max(1, Math.min(10, Math.floor(Number(args.page ?? 1))));
        // BROWSER-ONLY when available: run the search THROUGH the in-app browser
        // (real Chromium, the user's session, no raw HTTP scrape / bot-challenge).
        // Google runs through the real browser so the search shares the user's
        // locale and session. A consent wall, challenge, or parser miss falls
        // through to an explicitly configured HTTP provider; there is no hidden
        // second search engine.
        if (host.browserControlPort && !host.silent) {
          const port = host.browserControlPort;
          const sig = host.turnAbort?.signal;
          const tryEngine = async (url: string, parsers: Array<(h: string, n: number) => WebSearchResult[]>): Promise<WebSearchResult[]> => {
            try {
              const html = await fetchHtmlViaInAppBrowser(port, url, 25_000, sig);
              if (html) for (const parse of parsers) { const r = parse(html, maxResults); if (r.length) return r; }
            } catch { /* fall through to the explicitly configured HTTP provider */ }
            return [];
          };
          const results = await tryEngine(googleSearchUrl(query, maxResults, page), [parseGoogleHtml]);
          if (results.length) return JSON.stringify(results.slice(0, maxResults), null, 2);
        }
        if (page > 1) return 'web_search pagination requires the managed Desktop browser; headless API providers currently support page 1 only.';
        try {
          const provider = buildSearchProvider(knobs);
          const results = await provider.search(query, maxResults, host.turnAbort?.signal);
          return JSON.stringify(results.slice(0, maxResults), null, 2);
        } catch (err: any) {
          return `web_search failed: ${err?.message ?? err}`;
        }
  },
};
