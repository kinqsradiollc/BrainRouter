/**
 * webviewBridge — the live-DOM toolset for the Browser panel. Every tool runs as
 * a small snippet inside the embedded <webview> via `executeJavaScript`, so the
 * panel drives the workspace's real running app (no Playwright, no separate
 * window). Values returned are JSON-serializable.
 *
 * The <webview> element is typed loosely (`WebviewEl`) so the renderer needn't
 * pull in Electron's types; only the handful of methods/events we use are named.
 */

export interface WebviewEl extends HTMLElement {
  src: string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  capturePage(): Promise<{ toDataURL(): string }>;
  setZoomFactor(factor: number): void;
  openDevTools(): void;
}

/** One element discovered in the live DOM. */
export interface LiveElement {
  testid: string;
  tag: string;
  role: string;
  type: string;
  action: 'tap' | 'type' | 'assertVisible' | 'navigate';
  label: string;
  visible: boolean;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  value?: unknown;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  ok: boolean;
  ms: number;
  kind: string;
}

/** A resolver hint for the fuzzy fallback: the element's human label + coarse type. */
export interface ResolveHint { label?: string; type?: string }

// Precise-first, fuzzy fallback: find by exact data-testid; else, within controls
// of the given type, match aria-label/title/placeholder/text (exact, then
// partial). Injected into the page so broad (no-data-testid) apps stay runnable.
const RESOLVE_FN = `function __brResolve(target,label,type){
  var all=document.querySelectorAll('[data-testid]');
  for(var k=0;k<all.length;k++){ if(all[k].getAttribute('data-testid')===target) return all[k]; }
  var want=String(label||target||'').trim().toLowerCase(); if(!want) return null;
  var sel=type==='button'?'button,[role=button],a,[role=menuitem],[role=tab]':type==='input'?'input,textarea,[role=textbox],[role=searchbox]':type==='link'?'a,[role=link]':type==='select'?'select,[role=combobox]':'button,a,input,textarea,select,[role]';
  var cands=Array.prototype.slice.call(document.querySelectorAll(sel));
  function vis(n){var r=n.getBoundingClientRect();var cs=getComputedStyle(n);return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none';}
  function txt(n){return String((n.getAttribute&&(n.getAttribute('aria-label')||n.getAttribute('title')||n.getAttribute('placeholder')))||n.textContent||'').trim().toLowerCase();}
  var exact=cands.filter(function(n){return vis(n)&&txt(n)===want;}); if(exact.length) return exact[0];
  var part=cands.filter(function(n){return vis(n)&&txt(n).indexOf(want)>=0;}); return part.length?part[0]:null;
}`;

// Briefly outline the acted-on element so the user sees each step land.
const FLASH = `try{el.style.outline='2px solid #7c5cff';el.style.outlineOffset='1px';setTimeout(function(){try{el.style.outline='';}catch(e){}},700);}catch(e){}`;

/** JSON-encoded (target, label, type) argument list for the injected __brResolve. */
function resolveArgs(target: string, hint?: ResolveHint): string {
  return `${JSON.stringify(target)},${JSON.stringify(hint?.label ?? '')},${JSON.stringify(hint?.type ?? '')}`;
}

// --- inference mirrors the source extractor so the live map reads the same ---
const INFER = `function infer(el){
  const tag=(el.tagName||'').toLowerCase();
  const role=(el.getAttribute('role')||'').toLowerCase();
  const hasHref=el.hasAttribute('href')||el.hasAttribute('to');
  if(role==='button')return{type:'button',action:'tap'};
  if(role==='textbox'||role==='searchbox')return{type:'input',action:'type'};
  if(role==='link')return{type:'link',action:hasHref?'navigate':'tap'};
  if(tag==='button'||/button/.test(tag))return{type:'button',action:'tap'};
  if(tag==='input'||tag==='textarea')return{type:'input',action:'type'};
  if(tag==='a')return{type:'link',action:hasHref?'navigate':'tap'};
  if(tag==='select')return{type:'select',action:'tap'};
  if(typeof el.onclick==='function')return{type:'button',action:'tap'};
  return{type:'element',action:'assertVisible'};
}`;

const EXTRACT_JS = `(() => {
  ${INFER}
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll('[data-testid]')) {
    const id = el.getAttribute('data-testid');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const i = infer(el);
    out.push({
      testid: id,
      tag: (el.tagName||'').toLowerCase(),
      role: el.getAttribute('role') || '',
      type: i.type,
      action: i.action,
      label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim().slice(0, 48),
      visible: !!(r.width && r.height) && cs.visibility !== 'hidden' && cs.display !== 'none',
    });
  }
  return out.sort((a,b) => a.testid < b.testid ? -1 : 1);
})()`;

const HIGHLIGHT_JS = (on: boolean) => `(() => {
  const ID = '__browser_highlight_style__';
  const prev = document.getElementById(ID);
  if (prev) prev.remove();
  if (${on ? 'true' : 'false'}) {
    const s = document.createElement('style');
    s.id = ID;
    s.textContent = '[data-testid]{outline:2px solid #7c5cff !important;outline-offset:1px !important;} [data-testid]::after{}';
    document.documentElement.appendChild(s);
  }
  return { ok: true };
})()`;

// Pick mode: arm a one-shot capture; the renderer polls PICK_READ_JS.
const PICK_START_JS = `(() => {
  window.__browserPicked = null;
  if (window.__browserPickHandler) document.removeEventListener('click', window.__browserPickHandler, true);
  window.__browserPickHandler = (e) => {
    e.preventDefault(); e.stopPropagation();
    let el = e.target;
    while (el && !el.getAttribute('data-testid') && el.parentElement) el = el.parentElement;
    const tid = el && el.getAttribute ? el.getAttribute('data-testid') : null;
    const t = e.target;
    window.__browserPicked = {
      testid: tid || null,
      tag: (t.tagName||'').toLowerCase(),
      text: (t.textContent||'').trim().slice(0,48),
      suggestion: tid ? null : (t.id ? ('#'+t.id) : (t.className && typeof t.className==='string' ? '.'+t.className.trim().split(/\\s+/)[0] : (t.tagName||'').toLowerCase())),
    };
    document.removeEventListener('click', window.__browserPickHandler, true);
  };
  document.addEventListener('click', window.__browserPickHandler, true);
  return { ok: true };
})()`;

const PICK_READ_JS = `(window.__browserPicked || null)`;
const PICK_CANCEL_JS = `(() => { if (window.__browserPickHandler) document.removeEventListener('click', window.__browserPickHandler, true); window.__browserPicked = null; return {ok:true}; })()`;

// Network: patch fetch + XHR to record into a ring buffer; read on demand.
const NET_INSTRUMENT_JS = `(() => {
  if (window.__browserNetReady) return { ok: true };
  window.__browserNetReady = true;
  window.__browserNet = [];
  const push = (e) => { window.__browserNet.push(e); if (window.__browserNet.length > 200) window.__browserNet.shift(); };
  const of = window.fetch;
  if (of) window.fetch = function(...a){
    const t = performance.now(); const url = (a[0] && a[0].url) || String(a[0] || '');
    const method = (a[1] && a[1].method) || 'GET';
    return of.apply(this, a).then((res) => { push({ method, url, status: res.status, ok: res.ok, ms: Math.round(performance.now()-t), kind: 'fetch' }); return res; })
      .catch((err) => { push({ method, url, status: 0, ok: false, ms: Math.round(performance.now()-t), kind: 'fetch' }); throw err; });
  };
  const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this.__m = m; this.__u = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(){ const t = performance.now(); const xhr = this;
    this.addEventListener('loadend', () => push({ method: xhr.__m||'GET', url: xhr.__u||'', status: xhr.status, ok: xhr.status>=200&&xhr.status<400, ms: Math.round(performance.now()-t), kind: 'xhr' }));
    return oSend.apply(this, arguments); };
  return { ok: true };
})()`;

const NET_READ_JS = `(window.__browserNet || [])`;

// A compact accessibility-ish tree: interactive/landmark nodes with role + name.
const A11Y_JS = `(() => {
  const roleOf = (el) => el.getAttribute('role') || ({a:'link',button:'button',input:'textbox',select:'combobox',nav:'navigation',main:'main',header:'banner',footer:'contentinfo',h1:'heading',h2:'heading',h3:'heading'})[el.tagName.toLowerCase()] || '';
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('alt') || (el.tagName==='INPUT'?el.getAttribute('placeholder'):'') || el.textContent || '').trim().slice(0,40);
  const out = [];
  for (const el of document.querySelectorAll('a,button,input,select,textarea,nav,main,header,footer,[role],h1,h2,h3,[data-testid]')) {
    const role = roleOf(el); if (!role) continue;
    const r = el.getBoundingClientRect(); if (!(r.width && r.height)) continue;
    out.push({ role, name: nameOf(el), testid: el.getAttribute('data-testid') || undefined });
    if (out.length > 100) break;
  }
  return out;
})()`;

// --- wrappers ---
export const extractLive = (wv: WebviewEl) => wv.executeJavaScript(EXTRACT_JS, true) as Promise<LiveElement[]>;
export const setHighlight = (wv: WebviewEl, on: boolean) => wv.executeJavaScript(HIGHLIGHT_JS(on), true) as Promise<ActionResult>;
export const startPick = (wv: WebviewEl) => wv.executeJavaScript(PICK_START_JS, true) as Promise<ActionResult>;
export const readPick = (wv: WebviewEl) => wv.executeJavaScript(PICK_READ_JS, false) as Promise<null | { testid: string | null; tag: string; text: string; suggestion: string | null }>;
export const cancelPick = (wv: WebviewEl) => wv.executeJavaScript(PICK_CANCEL_JS, true) as Promise<ActionResult>;
export const instrumentNetwork = (wv: WebviewEl) => wv.executeJavaScript(NET_INSTRUMENT_JS, true) as Promise<ActionResult>;
export const readNetwork = (wv: WebviewEl) => wv.executeJavaScript(NET_READ_JS, false) as Promise<NetworkEntry[]>;
export const a11ySnapshot = (wv: WebviewEl) => wv.executeJavaScript(A11Y_JS, false) as Promise<Array<{ role: string; name: string; testid?: string }>>;

export function tap(wv: WebviewEl, target: string, hint?: ResolveHint): Promise<ActionResult> {
  const js = `(() => { ${RESOLVE_FN}
    var el=__brResolve(${resolveArgs(target, hint)});
    if(!el) return { ok:false, error:'not found: '+${JSON.stringify(target)} };
    el.scrollIntoView({block:'center'}); ${FLASH} el.click(); return { ok:true };
  })()`;
  return wv.executeJavaScript(js, true) as Promise<ActionResult>;
}

export function typeText(wv: WebviewEl, target: string, text: string, hint?: ResolveHint): Promise<ActionResult> {
  const val = JSON.stringify(text);
  const js = `(() => { ${RESOLVE_FN}
    var el=__brResolve(${resolveArgs(target, hint)});
    if(!el) return { ok:false, error:'not found: '+${JSON.stringify(target)} };
    el.scrollIntoView({block:'center'}); ${FLASH} el.focus(); try{el.value=${val};}catch(e){}
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
    return { ok:true, value:${val} };
  })()`;
  return wv.executeJavaScript(js, true) as Promise<ActionResult>;
}

export function assertVisible(wv: WebviewEl, target: string, hint?: ResolveHint): Promise<ActionResult> {
  const js = `(() => { ${RESOLVE_FN}
    var el=__brResolve(${resolveArgs(target, hint)});
    if(!el) return { ok:false, error:'not found: '+${JSON.stringify(target)} };
    var r=el.getBoundingClientRect(); var cs=getComputedStyle(el);
    var vis=!!(r.width&&r.height)&&cs.visibility!=='hidden'&&cs.display!=='none';
    if(vis){ el.scrollIntoView({block:'center'}); ${FLASH} }
    return { ok:vis, error: vis?undefined:'not visible' };
  })()`;
  return wv.executeJavaScript(js, true) as Promise<ActionResult>;
}

// Persistent hover outline for the Accessibility list: resolve the element the
// user points at, outline it, and scroll it into view — until cleared. Unlike
// FLASH (transient, 700ms) and HIGHLIGHT_JS (every [data-testid]), this outlines
// ONE element and restores its prior inline outline on clear.
export function highlightEl(wv: WebviewEl, target: string, hint?: ResolveHint): Promise<ActionResult> {
  const js = `(() => { ${RESOLVE_FN}
    try { var p = window.__browserHoverEl; if (p && p.el) { p.el.style.outline = p.o || ''; p.el.style.outlineOffset = p.oo || ''; } } catch(e){}
    var el=__brResolve(${resolveArgs(target, hint)});
    if(!el){ window.__browserHoverEl=null; return { ok:false, error:'not found: '+${JSON.stringify(target)} }; }
    window.__browserHoverEl={ el: el, o: el.style.outline, oo: el.style.outlineOffset };
    el.style.outline='2px solid #7c5cff'; el.style.outlineOffset='1px';
    el.scrollIntoView({block:'center',inline:'nearest'});
    return { ok:true };
  })()`;
  return wv.executeJavaScript(js, true) as Promise<ActionResult>;
}

/** Remove the hover outline set by highlightEl, restoring the element's prior inline outline. */
export function clearHighlight(wv: WebviewEl): Promise<ActionResult> {
  const js = `(() => {
    try { var p = window.__browserHoverEl; if (p && p.el) { p.el.style.outline = p.o || ''; p.el.style.outlineOffset = p.oo || ''; } } catch(e){}
    window.__browserHoverEl=null; return { ok:true };
  })()`;
  return wv.executeJavaScript(js, true) as Promise<ActionResult>;
}
