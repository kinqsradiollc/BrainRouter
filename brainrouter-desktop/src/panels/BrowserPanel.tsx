/**
 * Browser panel — an in-app web view of the workspace's running app with a tool
 * rail down the left edge. It renders the dev-server endpoint (default
 * http://localhost:5173) in an Electron <webview> and drives it live via
 * executeJavaScript (webviewBridge): extract data-testid elements, inspect/pick,
 * highlight, tap/type, screenshot, console, network, a11y, and record/replay
 * flows. No separate window — the panel IS the browser.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons.js';
import {
  type WebviewEl,
  type LiveElement,
  type NetworkEntry,
  extractLive,
  setHighlight,
  startPick,
  readPick,
  cancelPick,
  instrumentNetwork,
  readNetwork,
  a11ySnapshot,
  tap,
  typeText,
  assertVisible,
  highlightEl,
  clearHighlight,
} from '../lib/uitest/webviewBridge.js';
import type { UiMap } from '@kinqs/brainrouter-core/uitest';
import { rowSource, symbolKindIcon } from '../lib/uitest/rowSource.js';

type Drawer = 'elements' | 'console' | 'network' | 'a11y' | 'shot' | 'flows' | null;
type Device = 'desktop' | 'tablet' | 'phone';
type ConsoleMsg = { level: number; text: string };
type FlowStep = { action: 'tap' | 'type' | 'assertVisible' | 'navigate'; target: string; text?: string };
/** A story step handed off from the Atlas, enriched with resolver hints + route. */
type StoryStep = { action: 'navigate' | 'tap' | 'type' | 'assertVisible'; target: string; text?: string; label?: string; type?: string; route?: string | null };

const DEVICE_W: Record<Device, number | null> = { desktop: null, tablet: 820, phone: 390 };
const FLOWS_KEY = 'br-browser-flows';
const URL_KEY = 'br-browser-url';
const UIMAP_KEY = 'br-browser-uimap';
function readUiMap(): UiMap | null {
  try { const raw = localStorage.getItem(UIMAP_KEY); return raw ? (JSON.parse(raw) as UiMap) : null; } catch { return null; }
}

function loadFlows(): Record<string, FlowStep[]> {
  try { return JSON.parse(localStorage.getItem(FLOWS_KEY) || '{}'); } catch { return {}; }
}
function saveFlows(f: Record<string, FlowStep[]>): void {
  try { localStorage.setItem(FLOWS_KEY, JSON.stringify(f)); } catch { /* ignore */ }
}

function isLoopbackHost(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0';
}

/**
 * The one choke-point every navigation passes through. Two jobs: (1) never hand
 * an empty/scheme-less value to `loadURL`/`src` (Electron throws ERR_INVALID_URL
 * for '' — the crash this fixes), and (2) stay inside the main-process webview
 * policy, which permits only LOOPBACK dev-server origins and self-contained
 * data:text/html docs — so remote http(s), file://, and other schemes are
 * refused here for honest UX instead of being silently blocked at the guest.
 * Returns a loadable URL or null (caller falls back to a blank data: doc).
 */
function normalizeUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/^data:text\/html/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) { try { return isLoopbackHost(new URL(s)) ? s : null; } catch { return null; } }
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
  return null;
}
// A self-contained blank document. NOT about:blank — the main-process attach
// gate only permits data:text/html / loopback / workspace-prototype sources.
const BROWSER_BLANK = 'data:text/html,%3C!doctype%20html%3E%3Cmeta%20charset%3Dutf-8%3E%3Ctitle%3ENew%20tab%3C%2Ftitle%3E';

export function BrowserPanel(): React.ReactElement {
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) || 'http://localhost:5173');
  const [urlDraft, setUrlDraft] = useState(url);
  const [ready, setReady] = useState(false);
  const [device, setDevice] = useState<Device>('desktop');
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [elements, setElements] = useState<LiveElement[]>([]);
  const [consoleMsgs, setConsoleMsgs] = useState<ConsoleMsg[]>([]);
  const [network, setNetwork] = useState<NetworkEntry[]>([]);
  const [a11y, setA11y] = useState<Array<{ role: string; name: string; testid?: string }>>([]);
  const [shot, setShot] = useState<string>('');
  const [highlightOn, setHighlightOn] = useState(false);
  const [pickMode, setPickMode] = useState(false);
  const [picked, setPicked] = useState<string>('');
  const [typeVal, setTypeVal] = useState('test');
  const [status, setStatus] = useState<string>('');
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<FlowStep[]>([]);
  const [flows, setFlows] = useState<Record<string, FlowStep[]>>(() => loadFlows());
  const [flowName, setFlowName] = useState('');
  const [drive, setDrive] = useState(''); // testid handed off from the Atlas Screens map
  const [logs, setLogs] = useState<string[]>([]); // run/action log shown in the bottom dock
  const [logsOpen, setLogsOpen] = useState(true);
  const [uiMap, setUiMap] = useState<UiMap | null>(() => readUiMap());

  const hostRef = useRef<HTMLDivElement>(null);
  const wvRef = useRef<WebviewEl | null>(null);
  const urlRef = useRef(url);
  urlRef.current = url;

  // Create the <webview> once and wire its lifecycle events.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const wv = document.createElement('webview') as unknown as WebviewEl;
    // partition MUST be set before src — Electron re-attaches the guest if the
    // partition changes after a load, which itself can fire a spurious
    // loadURL('') and the ERR_INVALID_URL the user was seeing.
    wv.setAttribute('partition', 'persist:browser-panel');
    wv.setAttribute('src', normalizeUrl(urlRef.current) ?? BROWSER_BLANK);
    wv.style.width = '100%';
    wv.style.height = '100%';
    wv.style.border = '0';
    const onReady = (): void => setReady(true);
    const onConsole = (e: unknown): void => {
      const ev = e as { level: number; message: string };
      setConsoleMsgs((m) => [...m, { level: ev.level, text: ev.message }].slice(-200));
    };
    // getURL() is '' until a document commits (and on a failed provisional load).
    // Never write that back into state or it re-enters the sinks as an empty load.
    const onNav = (): void => { try { const u = wv.getURL(); if (u && u !== BROWSER_BLANK) { setUrl(u); setUrlDraft(u); } } catch { /* ignore */ } };
    const onFail = (e: unknown): void => {
      const ev = e as { errorDescription?: string; validatedURL?: string; errorCode?: number };
      // errorCode -3 is ABORTED (a superseded navigation) — not a real failure.
      if (ev.errorCode === -3) return;
      setStatus(`load failed: ${ev.errorDescription || 'unreachable'}${ev.validatedURL ? ` (${ev.validatedURL})` : ''} — check the URL or that the server is running.`);
    };
    wv.addEventListener('dom-ready', onReady);
    wv.addEventListener('console-message', onConsole as EventListener);
    wv.addEventListener('did-navigate', onNav as EventListener);
    wv.addEventListener('did-navigate-in-page', onNav as EventListener);
    wv.addEventListener('did-fail-load', onFail as EventListener);
    // did-fail-provisional-load fires for connection-refused on the INITIAL load
    // (the most common failure) which did-fail-load misses.
    wv.addEventListener('did-fail-provisional-load', onFail as EventListener);
    host.appendChild(wv);
    wvRef.current = wv;
    return () => {
      wv.removeEventListener('dom-ready', onReady);
      wv.removeEventListener('console-message', onConsole as EventListener);
      wv.removeEventListener('did-navigate', onNav as EventListener);
      wv.removeEventListener('did-navigate-in-page', onNav as EventListener);
      wv.removeEventListener('did-fail-load', onFail as EventListener);
      wv.removeEventListener('did-fail-provisional-load', onFail as EventListener);
      try { host.removeChild(wv); } catch { /* ignore */ }
      wvRef.current = null;
    };
  }, []);

  // Navigate when the committed URL changes.
  const go = (next: string): void => {
    const u = normalizeUrl(next);
    if (!u) { setStatus('Enter a loopback dev-server URL (e.g. localhost:5173 or http://127.0.0.1:3000).'); return; }
    setStatus('');
    setUrl(u);
    setUrlDraft(u);
    localStorage.setItem(URL_KEY, u);
    wvRef.current?.loadURL(u).catch(() => setStatus('navigation failed'));
  };

  // Poll for a picked element while in inspect mode.
  useEffect(() => {
    if (!pickMode) return;
    const wv = wvRef.current;
    if (!wv) return;
    void startPick(wv);
    const t = setInterval(async () => {
      const r = await readPick(wv).catch(() => null);
      if (r) {
        setPicked(r.testid ? `data-testid="${r.testid}"` : `${r.tag} — no testid (try ${r.suggestion})`);
        setPickMode(false);
      }
    }, 250);
    return () => { clearInterval(t); void cancelPick(wv); };
  }, [pickMode]);

  const withWv = async (fn: (wv: WebviewEl) => Promise<void>): Promise<void> => {
    const wv = wvRef.current;
    if (!wv || !ready) { setStatus('page not ready yet'); return; }
    try { await fn(wv); } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
  };

  // The UI map is produced by the Atlas extract flow and mirrored to localStorage
  // by App; refresh our copy whenever it changes so source links stay current.
  useEffect(() => {
    const onMap = (): void => setUiMap(readUiMap());
    window.addEventListener('br-browser-uimap', onMap);
    return () => window.removeEventListener('br-browser-uimap', onMap);
  }, []);

  // §a11y-inspect — map an a11y role to the resolver's coarse type hint so the
  // fuzzy fallback finds the right control when a row has no data-testid.
  const roleToType = (role: string): string | undefined => {
    if (role === 'link') return 'link';
    if (role === 'button') return 'button';
    if (role === 'combobox') return 'select';
    if (role === 'textbox' || role === 'searchbox') return 'input';
    return undefined;
  };
  const hoverHighlight = (n: { role: string; name: string; testid?: string }): void => {
    const wv = wvRef.current; if (!wv || !ready) return;
    highlightEl(wv, n.testid || n.name, { label: n.name, type: roleToType(n.role) }).catch(() => { /* ignore */ });
  };
  const hoverClear = (): void => {
    const wv = wvRef.current; if (!wv || !ready) return;
    clearHighlight(wv).catch(() => { /* ignore */ });
  };

  // Mirror every status update into the bottom Logs dock (fires only on change,
  // so story-run steps, action results, and errors all stream in as a log).
  useEffect(() => {
    const s = status.trim();
    if (!s) return;
    setLogs((l) => [...l, `${new Date().toLocaleTimeString([], { hour12: false })}  ${s}`].slice(-300));
  }, [status]);

  // Also fold run-flow notifications from App (the "Preparing…" banner and the
  // ensure-app result/errors, which otherwise only flash as a toast) into the
  // same dock — so it's one trail you can scan to see exactly where a run stalled.
  useEffect(() => {
    const onLog = (e: Event): void => {
      const msg = (e as CustomEvent<{ message?: string }>).detail?.message?.trim();
      if (msg) setLogs((l) => [...l, `${new Date().toLocaleTimeString([], { hour12: false })}  ${msg}`].slice(-300));
    };
    window.addEventListener('br-browser-log', onLog);
    return () => window.removeEventListener('br-browser-log', onLog);
  }, []);

  const doExtract = () => withWv(async (wv) => { setElements(await extractLive(wv)); setDrawer('elements'); setStatus(''); });
  const toggleHighlight = () => withWv(async (wv) => { const on = !highlightOn; await setHighlight(wv, on); setHighlightOn(on); });
  const doScreenshot = () => withWv(async (wv) => { const img = await wv.capturePage(); setShot(img.toDataURL()); setDrawer('shot'); });
  // Name a shot after the current URL's route so saved files are recognisable.
  const shotName = (): string => {
    try { const u = new URL(urlRef.current); return (u.hash || u.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'screen'; } catch { return 'screen'; }
  };
  // Persist the current screenshot to disk (the host writes it under
  // .brainrouter/ui-tests/screenshots/ and toasts the path). BrowserPanel takes no
  // props, so hand off via a window event that App forwards to the host query.
  const saveShot = (): void => {
    if (!shot) { setStatus('take a screenshot first'); return; }
    window.dispatchEvent(new CustomEvent('br-browser-savescreenshot', { detail: { dataUrl: shot, name: shotName() } }));
    setStatus('Saving screenshot…');
  };
  const doConsole = () => setDrawer('console');
  const doNetwork = () => withWv(async (wv) => { await instrumentNetwork(wv); setNetwork(await readNetwork(wv)); setDrawer('network'); });
  const doA11y = () => withWv(async (wv) => {
    setA11y(await a11ySnapshot(wv));
    setDrawer('a11y');
    if (!uiMap) window.dispatchEvent(new CustomEvent('br-browser-loaduimap'));
  });

  // Receive a "drive this element" handoff from the Atlas Screens map: focus the
  // testid, open the elements drawer, and (once the page is ready) extract so the
  // target shows up ready to run.
  useEffect(() => {
    const onFocus = (): void => {
      try {
        const raw = localStorage.getItem('br-browser-focus');
        const t = raw ? (JSON.parse(raw) as { testID?: string }).testID || '' : '';
        if (!t) return;
        setDrive(t);
        setDrawer('elements');
        setStatus(`Driving "${t}" — Extract, then run it`);
      } catch { /* ignore */ }
    };
    window.addEventListener('br-browser-focus', onFocus);
    return () => window.removeEventListener('br-browser-focus', onFocus);
  }, []);

  useEffect(() => {
    if (drive && ready) void doExtract();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drive, ready]);

  const record = (step: FlowStep) => { if (recording) setRecorded((s) => [...s, step]); };

  const runElement = (el: LiveElement) => withWv(async (wv) => {
    let r;
    if (el.action === 'type') { r = await typeText(wv, el.testid, typeVal); record({ action: 'type', target: el.testid, text: typeVal }); }
    else if (el.action === 'assertVisible') { r = await assertVisible(wv, el.testid); record({ action: 'assertVisible', target: el.testid }); }
    else { r = await tap(wv, el.testid); record({ action: 'tap', target: el.testid }); }
    setStatus(`${r.ok ? 'OK' : 'FAIL'} ${el.action} ${el.testid}${r.error ? ' — ' + r.error : ''}`);
  });

  const runFlow = (name: string) => withWv(async (wv) => {
    const steps = flows[name] || [];
    for (const s of steps) {
      if (s.action === 'navigate') { const nav = normalizeUrl(s.target); if (nav) await wv.loadURL(nav).catch(() => undefined); continue; }
      const r = s.action === 'type' ? await typeText(wv, s.target, s.text ?? '') : s.action === 'assertVisible' ? await assertVisible(wv, s.target) : await tap(wv, s.target);
      setStatus(`flow ${name}: ${s.action} ${s.target} → ${r.ok ? 'ok' : 'fail'}`);
      if (!r.ok) break;
      await new Promise((res) => setTimeout(res, 200));
    }
  });

  const saveFlow = () => {
    const name = (flowName || 'flow').replace(/[^a-z0-9_-]+/gi, '-');
    const next = { ...flows, [name]: recorded };
    setFlows(next); saveFlows(next); setRecorded([]); setRecording(false); setFlowName(''); setDrawer('flows');
  };

  // Load a URL and resolve once the page is ready (or a safety timeout).
  const loadAndWait = (raw: string): Promise<void> => new Promise((resolve) => {
    const wv = wvRef.current;
    const u = normalizeUrl(raw);
    if (!wv || !u) { resolve(); return; }
    let done = false;
    const finish = (): void => { if (done) return; done = true; wv.removeEventListener('dom-ready', finish); resolve(); };
    wv.addEventListener('dom-ready', finish);
    setUrl(u); setUrlDraft(u); try { localStorage.setItem(URL_KEY, u); } catch { /* ignore */ }
    wv.loadURL(u).catch(() => finish());
    setTimeout(finish, 9000);
  });

  // Replay a STORY handed off from the Atlas: open the app (the dev server is
  // already up — the host's ensure-app waited), then run each step LIVE with a
  // per-step [i/n] status, an element flash, and hash navigation.
  const runStory = async (baseUrl: string, title: string, steps: StoryStep[], storyId?: string): Promise<void> => {
    const wv = wvRef.current;
    if (!wv) return;
    setDrawer('elements');
    setStatus(`Running "${title}"…`);
    if (baseUrl) await loadAndWait(baseUrl);
    await new Promise((r) => setTimeout(r, 400));
    // Capture per-step outcomes + a screenshot (final, or at the first failure) so
    // the run can be turned into a markdown report + Artifact by the host.
    const results: Array<{ i: number; action: string; target: string; ok: boolean; error?: string; ms?: number }> = [];
    const shots: Array<{ name: string; dataUrl: string }> = [];
    const grab = async (name: string): Promise<void> => { try { const img = await wv.capturePage(); shots.push({ name, dataUrl: img.toDataURL() }); } catch { /* ignore */ } };
    let failed = false;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const tag = `[${i + 1}/${steps.length}] ${st.action} ${st.target}`;
      const t0 = Date.now();
      if (st.action === 'navigate') {
        setStatus(tag);
        const hash = st.route ? (st.route.startsWith('#') ? st.route : '#' + st.route) : '';
        if (hash) { try { await wv.executeJavaScript(`location.hash=${JSON.stringify(hash)}`, true); } catch { /* ignore */ } }
        results.push({ i: i + 1, action: st.action, target: st.target, ok: true, ms: Date.now() - t0 });
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      setDrive(st.target);
      const hint = { label: st.label, type: st.type };
      const r = st.action === 'type' ? await typeText(wv, st.target, st.text ?? '', hint)
        : st.action === 'assertVisible' ? await assertVisible(wv, st.target, hint)
        : await tap(wv, st.target, hint);
      results.push({ i: i + 1, action: st.action, target: st.target, ok: !!r.ok, error: r.error, ms: Date.now() - t0 });
      setStatus(`${tag} → ${r.ok ? 'ok' : 'FAIL' + (r.error ? ': ' + r.error : '')}`);
      if (!r.ok) {
        await grab(`step-${i + 1}-fail`);
        setStatus(`Story "${title}" stopped at step ${i + 1} (${st.action} ${st.target})${r.error ? ' — ' + r.error : ''}`);
        failed = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    if (!failed) { await grab('final'); setStatus(`✓ Story "${title}" finished — ${steps.length} steps`); }
    const id = storyId || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
    window.dispatchEvent(new CustomEvent('br-browser-runresult', { detail: { story: { id, title }, baseUrl, results, screenshots: shots } }));
  };

  // Receive a story handoff from the Atlas Stories overlay (the ensure-app result
  // carries the resolved app URL); replay it live in the webview.
  useEffect(() => {
    const onRunStory = (e: Event): void => {
      const url = (e as CustomEvent<{ url?: string }>).detail?.url;
      let payload: { id?: string; title?: string; steps?: StoryStep[] } | null = null;
      try { payload = JSON.parse(localStorage.getItem('br-browser-runstory') || 'null'); } catch { payload = null; }
      if (!payload || !Array.isArray(payload.steps) || !payload.steps.length) return;
      void runStory(url || urlRef.current, payload.title || 'story', payload.steps, payload.id);
    };
    window.addEventListener('br-browser-runstory', onRunStory);
    return () => window.removeEventListener('br-browser-runstory', onRunStory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deviceW = DEVICE_W[device];

  const railBtn = (icon: string, title: string, on: boolean, onClick: () => void, disabled = false) => (
    <button className={`br-tool${on ? ' on' : ''}`} title={title} onClick={onClick} disabled={disabled || (!ready && title !== 'Reload')}>
      <Icon name={icon} size={16} />
    </button>
  );

  return (
    <div className="browser-panel">
      <div className="browser-topbar">
        <button className="br-nav" title="Back" onClick={() => wvRef.current?.goBack()}>‹</button>
        <button className="br-nav" title="Forward" onClick={() => wvRef.current?.goForward()}>›</button>
        <button className="br-nav" title="Reload" onClick={() => wvRef.current?.reload()}><Icon name="refresh" size={13} /></button>
        <input
          className="browser-url"
          value={urlDraft}
          placeholder="http://localhost:5173"
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(urlDraft); }}
        />
        <button className="br-go" onClick={() => go(urlDraft)}>Go</button>
      </div>

      <div className="browser-body">
        <div className="browser-rail">
          {railBtn('monitor', 'Computer use (coming soon)', false, () => setStatus('Computer use — coming soon'), true)}
          {railBtn('bolt', 'Extract data-testid elements', drawer === 'elements', doExtract)}
          {railBtn('eye', pickMode ? 'Inspecting… click an element' : 'Inspect / pick element', pickMode, () => setPickMode((p) => !p))}
          {railBtn('search', highlightOn ? 'Hide test-id outlines' : 'Highlight test-ids', highlightOn, toggleHighlight)}
          <div className="br-rail-sep" />
          {railBtn('monitor', 'Desktop', device === 'desktop', () => setDevice('desktop'))}
          {railBtn('file', 'Tablet', device === 'tablet', () => setDevice('tablet'))}
          {railBtn('phone', 'Phone', device === 'phone', () => setDevice('phone'))}
          <div className="br-rail-sep" />
          {railBtn('terminal', 'Console', drawer === 'console', doConsole)}
          {railBtn('globe', 'Network', drawer === 'network', doNetwork)}
          {railBtn('file', 'Screenshot', drawer === 'shot', doScreenshot)}
          {railBtn('review', 'Accessibility tree', drawer === 'a11y', doA11y)}
          <div className="br-rail-sep" />
          {railBtn('play', recording ? `Recording (${recorded.length})` : 'Record a flow', recording, () => setRecording((r) => !r))}
          {railBtn('clock', 'Flows', drawer === 'flows', () => setDrawer('flows'))}
        </div>

        <div className="browser-stage">
          <div className={`browser-view dev-${device}`} style={deviceW ? { maxWidth: deviceW } : undefined} ref={hostRef} />
          {(status || picked) && (
            <div className="browser-status">
              {picked && <span className="br-picked">{picked}</span>}
              {status && <span className="br-status-msg">{status}</span>}
            </div>
          )}
          {drawer && (
            <div className="browser-drawer">
              <div className="browser-drawer-head">
                <b>{drawer === 'elements' ? `Elements (${elements.length})` : drawer === 'console' ? `Console (${consoleMsgs.length})` : drawer === 'network' ? `Network (${network.length})` : drawer === 'a11y' ? `Accessibility (${a11y.length})` : drawer === 'shot' ? 'Screenshot' : 'Flows'}</b>
                <span className="br-drawer-actions">
                  {drawer === 'network' && <button className="chip" onClick={doNetwork}>refresh</button>}
                  {drawer === 'shot' && shot && <button className="chip" onClick={saveShot}>Save</button>}
                  {drawer === 'elements' && <input className="br-type" value={typeVal} onChange={(e) => setTypeVal(e.target.value)} title="text used by type actions" />}
                  <button className="icon-btn" title="Close" onClick={() => setDrawer(null)}><Icon name="close" size={11} /></button>
                </span>
              </div>
              <div className="browser-drawer-body">
                {drawer === 'elements' && (elements.length ? elements.map((el) => (
                  <div key={el.testid} className={`br-el${el.visible ? '' : ' hidden'}${el.testid === drive ? ' focus' : ''}`}>
                    <span className="br-el-id">{el.testid}</span>
                    <span className="br-el-type">{el.type}</span>
                    {!el.visible && <span className="br-el-flag">hidden</span>}
                    <button className="br-el-run" onClick={() => runElement(el)}>{el.action}</button>
                  </div>
                )) : <div className="br-empty">No data-testid elements on this screen. Add some, then Extract again.</div>)}

                {drawer === 'console' && (consoleMsgs.length ? consoleMsgs.slice().reverse().map((m, i) => (
                  <div key={i} className={`br-log lvl-${m.level}`}>{m.text}</div>
                )) : <div className="br-empty">No console output captured yet.</div>)}

                {drawer === 'network' && (network.length ? network.slice().reverse().map((n, i) => (
                  <div key={i} className={`br-net${n.ok ? '' : ' fail'}`}><span className="br-net-status">{n.status || 'ERR'}</span><span className="br-net-method">{n.method}</span><span className="br-net-url" title={n.url}>{n.url}</span><span className="br-net-ms">{n.ms}ms</span></div>
                )) : <div className="br-empty">No requests yet — interact with the page, then refresh.</div>)}

                {drawer === 'a11y' && (a11y.length ? a11y.map((n, i) => {
                  const src = rowSource(n, uiMap, url);
                  return (
                    <div key={i} className="br-a11y" draggable
                      title={`Drag into chat · ${src.ref}`}
                      onMouseEnter={() => hoverHighlight(n)}
                      onMouseLeave={hoverClear}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', src.ref);
                        e.dataTransfer.setData('application/x-brainrouter-ref', src.ref);
                        e.dataTransfer.setData('application/x-brainrouter-tag', JSON.stringify({
                          name: n.name || n.testid || n.role, kind: src.kind, ref: src.ref, filePath: src.filePath, line: src.line,
                        }));
                        e.dataTransfer.effectAllowed = 'copy';
                      }}>
                      <Icon name={symbolKindIcon(src.kind)} size={12} className={`br-a11y-kind k-${src.kind ?? 'none'}`} />
                      <span className="br-a11y-role">{n.role}</span>
                      <span className="br-a11y-name">{n.name || '—'}</span>
                      {n.testid && <span className="br-a11y-tid">{n.testid}</span>}
                      {src.filePath && (
                        <button className="br-a11y-src"
                          title={`Open ${src.filePath}${src.line != null ? ':' + src.line : ''}`}
                          onClick={() => window.dispatchEvent(new CustomEvent('br-browser-openfile', { detail: { path: src.filePath, line: src.line } }))}>↪ source</button>
                      )}
                    </div>
                  );
                }) : <div className="br-empty">No accessibility nodes found.</div>)}

                {drawer === 'shot' && (shot ? <img className="br-shot" src={shot} alt="screenshot" /> : <div className="br-empty">No screenshot yet.</div>)}

                {drawer === 'flows' && (
                  <div className="br-flows">
                    {recorded.length > 0 && (
                      <div className="br-flow-save">
                        <span>Recorded {recorded.length} step(s)</span>
                        <input className="br-type" placeholder="flow name" value={flowName} onChange={(e) => setFlowName(e.target.value)} />
                        <button className="chip" onClick={saveFlow}>Save</button>
                      </div>
                    )}
                    {Object.keys(flows).length ? Object.keys(flows).map((name) => (
                      <div key={name} className="br-flow"><span>{name}</span><span className="br-flow-n">{flows[name].length} step(s)</span><button className="chip" onClick={() => runFlow(name)}><Icon name="play" size={11} /> run</button></div>
                    )) : <div className="br-empty">No saved flows. Toggle Record, run some element actions, then Save.</div>}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="browser-logs">
        <div className="browser-logs-head">
          <b>Logs</b><span className="browser-logs-n">{logs.length}</span>
          <span className="browser-logs-actions">
            <button className="icon-btn" title={logsOpen ? 'Collapse logs' : 'Expand logs'} onClick={() => setLogsOpen((o) => !o)}>{logsOpen ? '▾' : '▴'}</button>
            <button className="chip" onClick={() => setLogs([])}>clear</button>
          </span>
        </div>
        {logsOpen && (
          <div className="browser-logs-body">
            {logs.length ? logs.slice().reverse().map((l, i) => (
              <div key={logs.length - i} className={`browser-log-line${/(fail|error|stopped|refused|not found|unreachable|not ready)/i.test(l) ? ' err' : /(✓|finished|welcome|→ ok|OK )/i.test(l) ? ' ok' : ''}`}>{l}</div>
            )) : <div className="br-empty">No activity yet — run a story or an action and it streams here.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
