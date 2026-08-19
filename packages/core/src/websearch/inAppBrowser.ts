// ADR-041 D8 Phase 36 (egress prep) — the in-app-browser fetch helpers, lifted VERBATIM
// out of extension/builtin/runtime.ts so the fetch_url / web_search handlers can import them
// WITHOUT cycling back through the dispatch shim (the same cycle-avoidance move as the P17
// sourceSafety extraction). The block is self-contained — it references only JS builtins and
// its own names — so it moves with zero new imports. No behaviour change.

/** Minimal shape of the per-Agent browser-control port (a bridge to the desktop
 *  WebContentsView). Typed loosely so the runtime pulls in no desktop imports. */
export interface BrowserFetchPort { request(command: unknown, options?: { signal?: AbortSignal }): Promise<{ ok?: boolean; tabId?: string; data?: unknown }> }

/** True when a URL clearly points at STRUCTURED data (a JSON/XML/CSV/feed or an
 *  API endpoint) rather than a rendered web page. Those must NOT go through the
 *  browser — Chromium renders the response into a DOM view and innerText scraping
 *  mangles it; the HTTP crawler returns the bytes near-verbatim (parseable). */
export function looksStructuredUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.toLowerCase();
    if (/\.(json|xml|csv|tsv|txt|rss|atom|ndjson|yaml|yml)$/.test(path)) return true;
    if (path.includes('/api/') || path.startsWith('/api') || path.includes('/v1/') || path.includes('/v2/')) return true;
    if (/^(api|data|feeds?)\./i.test(u.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * How the agent's `web_search` / `fetch_url` fast-path drives the in-app browser.
 *
 * When `live` is set, the fetch is made WATCHABLE: it opens (or reuses via
 * `tabRef`) a single VISIBLE research tab, activates it, and LEAVES it open so
 * the user sees the agent navigate to the URL / search / page forward — one tab
 * moving page→page rather than throwaway tabs flashing open and closed. Without
 * `live` (the default) it keeps the original silent behavior: a NON-active
 * background tab that is always closed after the read.
 */
export interface InAppBrowseOptions {
  live?: boolean;
  /** Mutable holder for the reused research tab id, shared across an agent's
   *  web_search / fetch_url calls so the user watches ONE tab, not many. */
  tabRef?: { id?: string };
}

/**
 * Open a browse tab, or — in `live` mode with a known `tabRef.id` — reuse and
 * navigate the existing research tab (and re-activate it) so the user watches a
 * single tab move. Returns the tab id, or undefined if a fresh tab won't open.
 */
async function openOrReuseBrowseTab(port: BrowserFetchPort, url: string, signal: AbortSignal, opts: InAppBrowseOptions): Promise<string | undefined> {
  const live = opts.live === true;
  const ref = opts.tabRef;
  if (live && ref?.id) {
    const nav = await port.request({ kind: 'page.navigate', url, tabId: ref.id }, { signal }).catch(() => null);
    if (nav?.ok) {
      // Bring the reused research tab to the front so the user watches it move.
      await port.request({ kind: 'tabs.select', tabId: ref.id }, { signal }).catch(() => undefined);
      return ref.id;
    }
    ref.id = undefined; // stale/closed — fall through and open a fresh visible tab
  }
  const open = await port.request({ kind: 'tabs.open', url, activate: live }, { signal });
  if (!open?.ok || !open.tabId) return undefined;
  if (live && ref) ref.id = open.tabId;
  return open.tabId;
}

/**
 * Fetch a URL through the in-app browser (real Chromium, JS-rendered, using the
 * user's logged-in session), returning the page's rendered text — the SAME view
 * the agent gets from the browser tools. In `live` mode it drives a VISIBLE,
 * reused research tab the user can watch; otherwise a NON-active background tab
 * that is always closed after the read.
 *
 * Best-effort by design: a hard timeout bounds the whole flow and ANY failure
 * returns null so the caller falls back to the HTTP crawler — fetch_url can
 * never be made worse than the crawler baseline. SSRF is enforced by the desktop
 * browser's own onBeforeRequest destination gate, so no extra check is needed.
 */
export async function fetchViaInAppBrowser(port: BrowserFetchPort, url: string, timeoutMs: number, outerSignal?: AbortSignal, opts: InAppBrowseOptions = {}): Promise<{ title: string; url: string; text: string } | null> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  const live = opts.live === true;
  let tabId: string | undefined;
  try {
    tabId = await openOrReuseBrowseTab(port, url, signal, opts);
    if (!tabId) return null;
    // Wait for load, but ignore its timeout — we still read whatever rendered.
    await port.request({ kind: 'page.wait', tabId, loadState: 'load', timeoutMs: Math.min(15_000, timeoutMs) }, { signal }).catch(() => undefined);
    // page.text returns the page's clean rendered innerText (article text, not the
    // structural agent snapshot). Fall back to the semantic snapshot's node text
    // if page.text is somehow empty, and to the crawler (return null) if both are.
    const textRes = await port.request({ kind: 'page.text', tabId, maxChars: 100_000 }, { signal }).catch(() => null);
    const td = (textRes?.ok ? textRes.data : null) as { url?: string; title?: string; text?: string } | null;
    let title = String(td?.title ?? '');
    let finalUrl = String(td?.url ?? url);
    let text = String(td?.text ?? '').replace(/\n{3,}/g, '\n\n').slice(0, 60_000).trim();
    if (!text) {
      const snap = await port.request({ kind: 'page.snapshot', tabId, maxChars: 50_000 }, { signal }).catch(() => null);
      const sd = (snap?.ok ? snap.data : null) as { url?: string; title?: string; nodes?: Array<{ name?: unknown; value?: unknown }> } | null;
      const nodes = Array.isArray(sd?.nodes) ? sd!.nodes : [];
      text = nodes.map((n) => String(n?.name ?? n?.value ?? '').trim()).filter(Boolean).join('\n').slice(0, 40_000);
      if (sd?.title) title = String(sd.title);
      if (sd?.url) finalUrl = String(sd.url);
    }
    return text ? { title, url: finalUrl, text } : null;
  } catch {
    return null;
  } finally {
    // Live mode keeps the reused research tab open (the user is watching it;
    // reapAgentTabs cleans it up between turns). Headless mode always closes.
    if (tabId && !live) { try { await port.request({ kind: 'tabs.close', tabId }); } catch { /* best effort */ } }
  }
}

/**
 * Fetch a page's RENDERED HTML through the in-app browser (real Chromium + the
 * user's session), so structured extraction (e.g. web_search parsing a results
 * page) runs over what the browser actually rendered — the network/JS/session
 * all go through the browser, never a raw HTTP scrape. In `live` mode it drives
 * a VISIBLE, reused research tab (so the user watches the search happen);
 * otherwise a background tab that is always closed. Returns null on any failure.
 */
export async function fetchHtmlViaInAppBrowser(port: BrowserFetchPort, url: string, timeoutMs: number, outerSignal?: AbortSignal, opts: InAppBrowseOptions = {}): Promise<string | null> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  const live = opts.live === true;
  let tabId: string | undefined;
  try {
    tabId = await openOrReuseBrowseTab(port, url, signal, opts);
    if (!tabId) return null;
    await port.request({ kind: 'page.wait', tabId, loadState: 'load', timeoutMs: Math.min(15_000, timeoutMs) }, { signal }).catch(() => undefined);
    const res = await port.request({ kind: 'page.html', tabId, maxChars: 500_000 }, { signal }).catch(() => null);
    const data = (res?.ok ? res.data : null) as { html?: string } | null;
    const html = String(data?.html ?? '');
    return html.length > 100 ? html : null;
  } catch {
    return null;
  } finally {
    // Live mode leaves the reused research tab open for the user to watch.
    if (tabId && !live) { try { await port.request({ kind: 'tabs.close', tabId }); } catch { /* best effort */ } }
  }
}
