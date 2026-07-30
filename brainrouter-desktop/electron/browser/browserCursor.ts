/**
 * The visible agent cursor overlay.
 *
 * Attaching the CDP debugger and driving the page with synthetic input makes the
 * agent's clicks INVISIBLE to a human watching the pane — the page reacts, but
 * nothing shows WHERE the agent pointed. This overlay draws a pointer ring that
 * glides to each click/hover/drag target and pulses a ripple on click, so the
 * user can watch the agent operate the browser.
 *
 * The script is injected via `executeJavaScriptInIsolatedWorld`, whose isolated
 * world shares the page's DOM, so the overlay is a real, visible element. It is
 * create-if-missing on every call so it self-heals after a navigation wipes the
 * document. Every step is guarded; it never throws into the page.
 */

export const AGENT_CURSOR_ID = '__brainrouter_native_cursor__';
export const AGENT_CURSOR_STYLE_ID = '__brainrouter_native_cursor_style__';

/**
 * Isolated-world source that ensures the agent-cursor overlay exists, glides it
 * to (x, y) via a CSS transition, and — when `click` — pulses a ripple there.
 */
export function agentCursorScript(x: number, y: number, click: boolean): string {
  return `(() => { try {
    if (!document.getElementById('${AGENT_CURSOR_STYLE_ID}')) {
      const st = document.createElement('style'); st.id = '${AGENT_CURSOR_STYLE_ID}';
      st.textContent = '@keyframes __br_cursor_ripple{0%{transform:translate(-50%,-50%) scale(.25);opacity:.6}100%{transform:translate(-50%,-50%) scale(2);opacity:0}}';
      (document.head || document.documentElement).appendChild(st);
    }
    let el = document.getElementById('${AGENT_CURSOR_ID}');
    if (!el) {
      el = document.createElement('div'); el.id = '${AGENT_CURSOR_ID}'; el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:0;top:0;margin:0;z-index:2147483647;pointer-events:none;width:20px;height:20px;border:2px solid #7c5cff;border-radius:50%;background:rgba(124,92,255,.15);box-shadow:0 0 0 2px rgba(124,92,255,.22),0 1px 6px rgba(0,0,0,.4);transform:translate(-50%,-50%);transition:left .26s cubic-bezier(.22,.61,.36,1),top .26s cubic-bezier(.22,.61,.36,1);will-change:left,top';
      (document.body || document.documentElement).appendChild(el);
    }
    el.style.left = (${x}) + 'px'; el.style.top = (${y}) + 'px';
    ${click ? `
    const rp = document.createElement('div'); rp.setAttribute('aria-hidden', 'true');
    rp.style.cssText = 'position:fixed;left:' + (${x}) + 'px;top:' + (${y}) + 'px;margin:0;z-index:2147483646;pointer-events:none;width:30px;height:30px;border-radius:50%;background:radial-gradient(circle,rgba(124,92,255,.5),rgba(124,92,255,0) 70%);transform:translate(-50%,-50%) scale(.25);animation:__br_cursor_ripple .5s ease-out forwards';
    (document.body || document.documentElement).appendChild(rp);
    setTimeout(() => { try { rp.remove(); } catch (_e) {} }, 560);
    ` : ''}
    return { ok: true };
  } catch (_e) { return { ok: false }; } })()`;
}

/** Isolated-world source that removes the overlay and its keyframes stylesheet. */
export function removeAgentCursorScript(): string {
  return `(() => { document.getElementById('${AGENT_CURSOR_ID}')?.remove(); document.getElementById('${AGENT_CURSOR_STYLE_ID}')?.remove(); return { ok: true }; })()`;
}
